"""The silo command (also python -m silo_os).

    silo ask Atlas "What changed today?"
    silo run "Invoice reader" "invoice-0042.pdf"
    silo eval                          every workflow and resident with tests; exit 1 when something got worse
    silo eval "Invoice reader" --repeat 3 --min-score 80 --strict --json

SILO_URL (default http://127.0.0.1:3000) and SILO_TOKEN come from the environment, or --url and --token.
Exit codes: 0 good, 1 a run failed or tests got worse / fell short, 2 wrong command, token or address.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional

from .client import Silo
from .errors import AuthError, ConnectionFailed, PermissionDenied, SiloError


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="silo", description="Talk to a SILO from the terminal or CI.")
    p.add_argument("--url", help="SILO address (default SILO_URL or http://127.0.0.1:3000)")
    p.add_argument("--token", help="API token (default SILO_TOKEN)")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("ask", help="ask a resident")
    a.add_argument("resident")
    a.add_argument("message")
    r = sub.add_parser("run", help="run a workflow and print its output")
    r.add_argument("workflow")
    r.add_argument("input")
    r.add_argument("--timeout", type=float, default=1800)
    e = sub.add_parser("eval", help="run tests and fail when something got worse")
    e.add_argument("names", nargs="*", help="workflows or residents (names or ids); default all with tests")
    e.add_argument("--repeat", type=int, choices=range(1, 6), metavar="1-5")
    e.add_argument("--min-score", type=float)
    e.add_argument("--strict", action="store_true", help="every case must pass")
    e.add_argument("--timeout", type=float, default=1800)
    e.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    try:
        silo = Silo(args.url, args.token)
        if args.cmd == "ask":
            print(silo.ask(args.resident, args.message).text)
            return 0
        if args.cmd == "run":
            run = silo.run(args.workflow, args.input, timeout=args.timeout)
            if run.get("status") == "completed":
                print(run.get("output", ""))
                return 0
            error = run.get("error")
            print(f"The run ended as {run.get('status')}" + (f": {error}" if error else "."), file=sys.stderr)
            return 1
        return _eval(silo, args)
    except ValueError as err:
        print(err, file=sys.stderr)
        return 2
    except (AuthError, PermissionDenied, ConnectionFailed) as err:
        print(f"{err.message}", file=sys.stderr)
        return 2
    except SiloError as err:
        print(f"{err.message}", file=sys.stderr)
        return 1


def _eval(silo: Silo, args: argparse.Namespace) -> int:
    state = silo.state()
    every = [("workflow", w) for w in state["workflows"] if w.get("tests")] + \
            [("agent", x) for x in state["agents"] if x.get("tests")]
    wanted = every
    if args.names:
        wanted = []
        for n in args.names:
            hit = [t for t in every if t[1]["id"] == n or t[1]["name"].lower() == n.lower()]
            if not hit:
                print(f'No workflow or resident with tests is called "{n}".', file=sys.stderr)
                return 2
            wanted.append(hit[0])
    if not wanted:
        print("Nothing here has tests yet.", file=sys.stderr)
        return 2
    out: List[Dict[str, Any]] = []
    for kind, obj in wanted:
        try:
            rep = silo.evaluate(obj, kind=kind, repeat=args.repeat, timeout=args.timeout)
            out.append({"kind": kind, "name": obj["name"], "report": rep})
        except SiloError as err:
            out.append({"kind": kind, "name": obj["name"], "error": err.message})
    bad = [x for x in out if _bad(x, args)]
    if args.json:
        print(json.dumps({"ok": not bad, "reports": out}, indent=2))
    else:
        for x in out:
            label = "resident" if x["kind"] == "agent" else "workflow"
            rep = x.get("report")
            if not rep:
                line = "NOT STARTED: " + x["error"]
            elif rep.get("status") != "done":
                line = str(rep.get("status")).upper()
            else:
                delta = (rep.get("compare") or {}).get("scoreDelta")
                line = f"{rep['passed']}/{rep['total']} passed  score {rep.get('score')}" + \
                       (f" ({delta:+g})" if isinstance(delta, (int, float)) else "") + ("  GOT WORSE" if rep.get("worse") else "")
            print(f"{label:9} {x['name'][:32]:32} {line}")
        print(f"\n{len(bad)} of {len(out)} did not pass." if bad else f"\nAll {len(out)} passed.")
    return 1 if bad else 0


def _bad(x: Dict[str, Any], args: argparse.Namespace) -> bool:
    rep = x.get("report")
    if not rep or rep.get("status") != "done" or rep.get("worse"):
        return True
    if args.min_score is not None and (rep.get("score") or 0) < args.min_score:
        return True
    return bool(args.strict and rep.get("passed") < rep.get("total"))


if __name__ == "__main__":
    sys.exit(main())
