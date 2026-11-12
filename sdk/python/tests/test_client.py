"""Tests of the silo-os client. Offline tests use a fake server; the live ones run when SILO_TEST_URL and
SILO_TEST_TOKEN point at a test SILO (tests/sdk.test.mjs starts one)."""
import asyncio
import io
import json
import os
import pathlib
import sys
import threading
import time
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from silo_os import (AsyncSilo, AuthError, ConnectionFailed, NotFound, PermissionDenied, RateLimited, Silo,  # noqa: E402
                     SiloError)
from silo_os.__main__ import main  # noqa: E402

TOKEN = "silo_pat_" + "a" * 43


class Fake(BaseHTTPRequestHandler):
    hits = []
    plan = []

    def log_message(self, *a):
        pass

    def _answer(self):
        size = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(size) if size else b""
        Fake.hits.append((self.command, self.path, self.headers.get("Authorization"), body))
        status, data, headers = Fake.plan.pop(0) if Fake.plan else (200, {"ok": True}, {})
        raw = json.dumps(data).encode()
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = _answer


class Offline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Fake.hits.clear()
        Fake.plan.clear()

    def test_token_and_address_are_checked(self):
        with self.assertRaises(ValueError):
            Silo(self.url, "nope")
        with self.assertRaises(ValueError):
            Silo("http://silo.example.com", TOKEN)
        Silo("http://silo.example.com", TOKEN, allow_insecure_http=True)
        Silo("https://silo.example.com", TOKEN)

    def test_bearer_and_json(self):
        Fake.plan.append((200, {"text": "hi", "traceId": "t1", "tokens": 5}, {}))
        silo = Silo(self.url, TOKEN)
        answer = silo.ask({"id": "a 1", "name": "A"}, "hello")
        self.assertEqual((answer.text, answer.trace_id, answer.tokens, str(answer)), ("hi", "t1", 5, "hi"))
        method, path, auth, body = Fake.hits[0]
        self.assertEqual((method, path, auth), ("POST", "/api/agents/a%201/chat", "Bearer " + TOKEN))
        self.assertEqual(json.loads(body), {"message": "hello"})

    def test_waits_after_429_as_long_as_retry_after_says(self):
        Fake.plan += [(429, {"error": "Too many"}, {"Retry-After": "0.3"}), (200, {"agents": [], "workflows": []}, {})]
        start = time.monotonic()
        self.assertEqual(Silo(self.url, TOKEN).state(), {"agents": [], "workflows": []})
        # Windows clocks tick every ~15 ms, so allow a little under the asked wait.
        self.assertGreaterEqual(time.monotonic() - start, 0.27)
        self.assertEqual(len(Fake.hits), 2)
        Fake.plan += [(429, {"error": "Too many"}, {"Retry-After": "0"})] * 2
        with self.assertRaises(RateLimited) as cm:
            Silo(self.url, TOKEN, retries=1).state()
        self.assertEqual((cm.exception.status, cm.exception.retry_after, cm.exception.message), (429, 0.0, "Too many"))

    def test_errors_by_status(self):
        for status, kind in [(401, AuthError), (403, PermissionDenied), (404, NotFound), (400, SiloError)]:
            Fake.plan.append((status, {"error": f"no {status}"}, {}))
            with self.assertRaises(kind) as cm:
                Silo(self.url, TOKEN, retries=0).request("POST", "/x", {})
            self.assertEqual(cm.exception.message, f"no {status}")
        Fake.plan.append((503, {"error": "busy"}, {}))
        with self.assertRaises(SiloError):
            Silo(self.url, TOKEN, retries=0).request("POST", "/x", {})
        self.assertEqual(Fake.hits[-1][0], "POST", "a POST is never sent twice")

    def test_names_and_lookups(self):
        state = {"agents": [{"id": "a1", "name": "Atlas"}], "workflows": [{"id": "w1", "name": "Atlas", "steps": []}]}
        Fake.plan.append((200, state, {}))
        with self.assertRaises(SiloError):
            Silo(self.url, TOKEN).evaluate("atlas")
        Fake.plan.append((200, state, {}))
        with self.assertRaises(NotFound):
            Silo(self.url, TOKEN).resident("Nobody")

    def test_unreachable(self):
        with self.assertRaises(ConnectionFailed):
            Silo("http://127.0.0.1:9", TOKEN, retries=0, timeout=2).state()

    def test_async(self):
        Fake.plan += [(200, {"text": "a"}, {}), (200, {"text": "b"}, {})]

        async def go():
            async with AsyncSilo(self.url, TOKEN) as silo:
                return await asyncio.gather(silo.ask({"id": "x"}, "1"), silo.ask({"id": "y"}, "2"))

        self.assertEqual(sorted(a.text for a in asyncio.run(go())), ["a", "b"])


@unittest.skipUnless(os.environ.get("SILO_TEST_URL"), "no test SILO")
class Live(unittest.TestCase):
    def setUp(self):
        self.silo = Silo(os.environ["SILO_TEST_URL"], os.environ["SILO_TEST_TOKEN"])

    def test_residents_runs_and_tests(self):
        silo = self.silo
        self.assertEqual(silo.resident("clerk")["name"], "Clerk")
        answer = silo.ask("Clerk", "What do you sell?")
        self.assertEqual(answer.text, "Compatible fixture")
        self.assertIn("spans", silo.trace(answer.trace_id))
        run = silo.run("Stand", "Two apples", timeout=60, poll=0.2)
        self.assertEqual((run["status"], run["output"]), ("completed", "Compatible fixture"))
        self.assertEqual(silo.get_run(run["id"])["id"], run["id"])
        report = silo.evaluate("Stand", repeat=1, timeout=60, poll=0.2)
        self.assertEqual((report["status"], report["passed"], report["total"]), ("done", 1, 1))
        silo.write_file("notes/sdk.txt", "from python é")
        self.assertEqual(silo.read_file("notes/sdk.txt"), "from python é")
        self.assertEqual(silo.pending(), {"requests": [], "runs": []})
        with self.assertRaises(NotFound):
            silo.get_run("nope")

    def test_read_only_token_is_refused(self):
        silo = Silo(os.environ["SILO_TEST_URL"], os.environ["SILO_TEST_READ_TOKEN"])
        self.assertTrue(silo.residents())
        with self.assertRaises(PermissionDenied):
            silo.ask("Clerk", "hi")

    def test_cli_eval(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = main(["--url", os.environ["SILO_TEST_URL"], "--token", os.environ["SILO_TEST_TOKEN"], "eval", "Stand", "--repeat", "1", "--json"])
        self.assertEqual(code, 0, buf.getvalue())
        self.assertTrue(json.loads(buf.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
