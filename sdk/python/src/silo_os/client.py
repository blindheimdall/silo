"""The SILO client: Silo for plain code, AsyncSilo for asyncio. Only the standard library is used."""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

from .errors import ConnectionFailed, NotFound, RateLimited, SiloError, Timeout, error_for

__all__ = ["Silo", "AsyncSilo", "Answer", "DEFAULT_URL"]

DEFAULT_URL = "http://127.0.0.1:3000"
TOKEN_SHAPE = re.compile(r"^silo_pat_[A-Za-z0-9_-]{43}$")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
RUN_ACTIVE = {"running", "queued"}
REPORT_ACTIVE = {"running", "waiting"}
Json = Dict[str, Any]


@dataclass
class Answer:
    """What a resident answered. trace_id opens the trace of the answer in SILO."""

    text: str
    trace_id: Optional[str] = None
    tokens: int = 0
    raw: Json = field(default_factory=dict, repr=False)

    def __str__(self) -> str:
        return self.text


class Silo:
    """A connection to one SILO.

    >>> silo = Silo()                      # SILO_URL and SILO_TOKEN from the environment
    >>> silo.ask("Atlas", "Summarize the open invoices").text
    >>> silo.run("Invoice reader", "invoice-0042.pdf")["output"]

    The token (System > API tokens) decides what the client may do: read, run, approve. It is only sent over https,
    or over http to this computer, unless allow_insecure_http is set.
    """

    def __init__(self, url: Optional[str] = None, token: Optional[str] = None, *, timeout: float = 120.0,
                 retries: int = 3, allow_insecure_http: bool = False) -> None:
        self.url = (url or os.environ.get("SILO_URL") or DEFAULT_URL).rstrip("/")
        self.token = token if token is not None else os.environ.get("SILO_TOKEN", "")
        if not TOKEN_SHAPE.match(self.token or ""):
            raise ValueError("Give a SILO API token (silo_pat_...), or set SILO_TOKEN. Make one in System > API tokens.")
        parts = urllib.parse.urlsplit(self.url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"Not a SILO address: {self.url}")
        if parts.scheme == "http" and parts.hostname not in LOCAL_HOSTS and not allow_insecure_http:
            raise ValueError("Use https for a SILO on another computer, so the token is not sent in the clear "
                             "(or pass allow_insecure_http=True on a network you trust).")
        self.timeout = timeout
        self.retries = max(0, int(retries))

    def __repr__(self) -> str:
        return f"Silo({self.url!r})"

    # --- HTTP ---
    def request(self, method: str, path: str, body: Optional[Json] = None, *, timeout: Optional[float] = None) -> Any:
        """Calls /api{path} and returns the JSON answer. Waits and tries again after 429 (as long as Retry-After
        says, at most a minute) and, for GET, after 502-504 or a dropped connection."""
        url = self.url + "/api" + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json", "User-Agent": "silo-os-python/0.1"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout or self.timeout) as res:
                    raw = res.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                raw = e.read()
                try:
                    parsed: Any = json.loads(raw) if raw else None
                except ValueError:
                    parsed = raw.decode("utf-8", "replace")[:500]
                message = parsed.get("error") if isinstance(parsed, dict) and parsed.get("error") else f"HTTP {e.code}"
                wait = _retry_after(e.headers.get("Retry-After"))
                err = error_for(e.code, str(message), parsed, wait)
                retry = isinstance(err, RateLimited) or (method == "GET" and e.code in (502, 503, 504))
                if retry and attempt < self.retries:
                    attempt += 1
                    time.sleep(min(60.0, wait if wait is not None else 2.0 ** attempt))
                    continue
                raise err from None
            except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
                if method == "GET" and attempt < self.retries:
                    attempt += 1
                    time.sleep(min(30.0, 2.0 ** attempt))
                    continue
                reason = getattr(e, "reason", e)
                raise ConnectionFailed(f"Cannot reach SILO at {self.url}: {reason}") from None

    def _get(self, path: str, **query: Any) -> Any:
        q = {k: v for k, v in query.items() if v is not None}
        return self.request("GET", path + ("?" + urllib.parse.urlencode(q) if q else ""))

    def _post(self, path: str, body: Optional[Json] = None, *, timeout: Optional[float] = None) -> Any:
        return self.request("POST", path, body if body is not None else {}, timeout=timeout)

    # --- What is there ---
    def state(self) -> Json:
        """Everything the token may read: residents, workflows, runs, requests, proposals, settings."""
        return self._get("/state")

    def residents(self) -> List[Json]:
        return self.state()["agents"]

    def workflows(self) -> List[Json]:
        return self.state()["workflows"]

    def resident(self, name_or_id: str) -> Json:
        """A resident by id or name (case does not matter)."""
        return _pick(self.residents(), name_or_id, "resident")

    def workflow(self, name_or_id: str) -> Json:
        """A workflow by id or name (case does not matter)."""
        return _pick(self.workflows(), name_or_id, "workflow")

    # --- Residents ---
    def ask(self, resident: Union[str, Json], message: str, *, timeout: float = 600.0) -> Answer:
        """Sends a message to a resident's chat and returns the answer. Tools that need approval wait for it."""
        agent = resident if isinstance(resident, dict) else self.resident(resident)
        data = self._post(f"/agents/{_seg(agent['id'])}/chat", {"message": message}, timeout=timeout)
        return Answer(text=data.get("text", ""), trace_id=data.get("traceId"), tokens=data.get("tokens") or 0, raw=data)

    # --- Workflows and runs ---
    def run(self, workflow: Union[str, Json], input: str, *, wait: bool = True, timeout: float = 1800.0,
            poll: float = 2.0) -> Json:
        """Starts a workflow. With wait, returns the finished run (status, output, error); otherwise at once."""
        w = workflow if isinstance(workflow, dict) else self.workflow(workflow)
        run = self._post(f"/workflows/{_seg(w['id'])}/run", {"input": input})
        return self.wait_run(run["id"], timeout=timeout, poll=poll) if wait else run

    def get_run(self, run_id: str) -> Json:
        return self._get(f"/runs/{_seg(run_id)}")

    def wait_run(self, run_id: str, *, timeout: float = 1800.0, poll: float = 2.0) -> Json:
        """Waits until the run ends. A run that waits for an approval keeps waiting; decide it in SILO or with
        approve_run. Raises Timeout after timeout seconds (the run goes on)."""
        end = time.monotonic() + timeout
        while True:
            run = self.get_run(run_id)
            if run.get("status") not in RUN_ACTIVE:
                return run
            if time.monotonic() > end:
                raise Timeout(f"The run {run_id} did not finish in {timeout:g} seconds; it is {run.get('status')}.", body=run)
            time.sleep(poll)

    def stop_run(self, run_id: str) -> None:
        self._post(f"/runs/{_seg(run_id)}/stop")

    # --- Approvals ---
    def pending(self) -> Json:
        """What waits for a person: tool requests and runs waiting for review."""
        s = self.state()
        return {"requests": [r for r in s.get("requests", []) if r.get("status") == "pending"],
                "runs": [r for r in s.get("runs", []) if r.get("waiting") and r.get("status") == "running"]}

    def allow(self, request_id: str, *, always: bool = False) -> None:
        """Allows a waiting tool request (needs the approve scope). always trusts that tool for the resident."""
        self._post(f"/requests/{_seg(request_id)}", {"allow": True, "always": always})

    def deny(self, request_id: str) -> None:
        self._post(f"/requests/{_seg(request_id)}", {"allow": False})

    def approve_run(self, run_id: str, note: str = "") -> None:
        self._post(f"/runs/{_seg(run_id)}/approve", {"approve": True, "note": note})

    def reject_run(self, run_id: str, note: str = "") -> None:
        self._post(f"/runs/{_seg(run_id)}/approve", {"approve": False, "note": note})

    # --- Tests ---
    def evaluate(self, target: Union[str, Json], *, kind: Optional[str] = None, repeat: Optional[int] = None,
                 wait: bool = True, timeout: float = 1800.0, poll: float = 2.0) -> Json:
        """Runs the saved test cases of a workflow or resident (by name or id) and returns the report: passed,
        total, score, and compare (what got better or worse than before; report['worse'] is True on a regression)."""
        kind, obj = self._target(target, kind)
        body: Json = {"trigger": "ci"}
        if repeat is not None:
            body["repeat"] = repeat
        rep = self._post(f"/{'agents' if kind == 'agent' else 'workflows'}/{_seg(obj['id'])}/evaluate", body)
        if "reports" in rep:
            rep = rep["reports"][-1]
        if not wait:
            return rep
        end = time.monotonic() + timeout
        while rep.get("status") in REPORT_ACTIVE:
            if time.monotonic() > end:
                raise Timeout(f"The tests of {obj['name']} did not finish in {timeout:g} seconds.", body=rep)
            time.sleep(poll)
            rep = self.report(rep["id"])
        return rep

    def report(self, report_id: str) -> Json:
        return self._get(f"/evals/{_seg(report_id)}")["report"]

    def _target(self, target: Union[str, Json], kind: Optional[str]) -> "tuple[str, Json]":
        if isinstance(target, dict):
            return (kind or ("workflow" if "steps" in target else "agent")), target
        s = self.state()
        hits = [("workflow", w) for w in s["workflows"] if kind in (None, "workflow") and _matches(w, target)]
        hits += [("agent", a) for a in s["agents"] if kind in (None, "agent") and _matches(a, target)]
        if not hits:
            raise NotFound(f'No workflow or resident is called "{target}".', 404)
        if len(hits) > 1:
            raise SiloError(f'"{target}" is both a workflow and a resident. Pass kind="workflow" or kind="agent".')
        return hits[0]

    # --- Files and traces ---
    def files(self) -> List[Json]:
        return self._get("/files")

    def read_file(self, name: str) -> str:
        return self._get("/file", name=name)["content"]

    def write_file(self, name: str, content: str) -> None:
        """Saves a text file in the workspace (needs the run scope)."""
        self._post("/file", {"name": name, "content": content})

    def trace(self, trace_id: str) -> Json:
        return self._get(f"/traces/{_seg(trace_id)}")


class AsyncSilo:
    """The same client for asyncio. Each call runs in a worker thread, so nothing outside the standard library is
    needed.

    >>> async with AsyncSilo() as silo:
    ...     answers = await asyncio.gather(silo.ask("Atlas", "a"), silo.ask("Nova", "b"))
    """

    def __init__(self, url: Optional[str] = None, token: Optional[str] = None, **options: Any) -> None:
        self.sync = Silo(url, token, **options)

    async def __aenter__(self) -> "AsyncSilo":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    def __repr__(self) -> str:
        return f"AsyncSilo({self.sync.url!r})"

    async def _call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(getattr(self.sync, name), *args, **kwargs)

    async def request(self, method: str, path: str, body: Optional[Json] = None, **kw: Any) -> Any:
        return await self._call("request", method, path, body, **kw)

    async def state(self) -> Json:
        return await self._call("state")

    async def residents(self) -> List[Json]:
        return await self._call("residents")

    async def workflows(self) -> List[Json]:
        return await self._call("workflows")

    async def resident(self, name_or_id: str) -> Json:
        return await self._call("resident", name_or_id)

    async def workflow(self, name_or_id: str) -> Json:
        return await self._call("workflow", name_or_id)

    async def ask(self, resident: Union[str, Json], message: str, **kw: Any) -> Answer:
        return await self._call("ask", resident, message, **kw)

    async def run(self, workflow: Union[str, Json], input: str, **kw: Any) -> Json:
        return await self._call("run", workflow, input, **kw)

    async def get_run(self, run_id: str) -> Json:
        return await self._call("get_run", run_id)

    async def wait_run(self, run_id: str, **kw: Any) -> Json:
        return await self._call("wait_run", run_id, **kw)

    async def stop_run(self, run_id: str) -> None:
        await self._call("stop_run", run_id)

    async def pending(self) -> Json:
        return await self._call("pending")

    async def allow(self, request_id: str, **kw: Any) -> None:
        await self._call("allow", request_id, **kw)

    async def deny(self, request_id: str) -> None:
        await self._call("deny", request_id)

    async def approve_run(self, run_id: str, note: str = "") -> None:
        await self._call("approve_run", run_id, note)

    async def reject_run(self, run_id: str, note: str = "") -> None:
        await self._call("reject_run", run_id, note)

    async def evaluate(self, target: Union[str, Json], **kw: Any) -> Json:
        return await self._call("evaluate", target, **kw)

    async def report(self, report_id: str) -> Json:
        return await self._call("report", report_id)

    async def files(self) -> List[Json]:
        return await self._call("files")

    async def read_file(self, name: str) -> str:
        return await self._call("read_file", name)

    async def write_file(self, name: str, content: str) -> None:
        await self._call("write_file", name, content)

    async def trace(self, trace_id: str) -> Json:
        return await self._call("trace", trace_id)


def _retry_after(value: Optional[str]) -> Optional[float]:
    try:
        return max(0.0, float(value)) if value is not None else None
    except ValueError:
        return None


def _seg(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


def _matches(obj: Json, key: str) -> bool:
    return obj.get("id") == key or str(obj.get("name", "")).lower() == str(key).lower()


def _pick(items: List[Json], key: str, what: str) -> Json:
    for item in items:
        if _matches(item, key):
            return item
    raise NotFound(f'No {what} is called "{key}".', 404)
