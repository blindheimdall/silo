# silo-os

The Python client for [SILO](../../README.md): ask residents, run workflows, decide approvals and run tests from
scripts, notebooks and CI. Only the standard library, Python 3.9 or newer, typed.

```
pip install silo-os
```

Make a token in SILO under **System > API tokens** with the scopes you need (read, run, approve), then:

```python
from silo_os import Silo

silo = Silo("http://127.0.0.1:3000", "silo_pat_...")   # or set SILO_URL and SILO_TOKEN

answer = silo.ask("Atlas", "Which invoices are overdue?")
print(answer.text, answer.trace_id)

run = silo.run("Invoice reader", "invoice-0042.pdf")      # waits; run["status"], run["output"]
started = silo.run("Invoice reader", "big.pdf", wait=False)
silo.wait_run(started["id"], timeout=600)

for r in silo.pending()["requests"]:                      # needs the approve scope
    print(r["agentName"], "asks to", r["title"])
    silo.allow(r["id"])                                   # or silo.deny(r["id"])

report = silo.evaluate("Invoice reader", repeat=3)
assert not report["worse"], report["compare"]
```

With asyncio:

```python
import asyncio
from silo_os import AsyncSilo

async def main():
    async with AsyncSilo() as silo:
        a, b = await asyncio.gather(silo.ask("Atlas", "one"), silo.ask("Nova", "two"))

asyncio.run(main())
```

## Errors

Every error is a `SiloError` with `status` and `message`: `AuthError` (401), `PermissionDenied` (403, a missing
scope or role), `NotFound` (404), `Conflict` (409, already running or already decided), `RateLimited` (429),
`ServerError` (5xx), `ConnectionFailed` and `Timeout` (a wait ran out; the work goes on in SILO).

The client waits and tries again after 429 for as long as `Retry-After` says (at most a minute), and for reads after
502-504 or a dropped connection. `retries=3` sets how often.

The token is sent only over https, or over http to this computer. For a SILO elsewhere on a network you trust, pass
`allow_insecure_http=True`.

## In CI

```
SILO_URL=https://silo.example.com SILO_TOKEN=${{ secrets.SILO_TOKEN }} silo eval --min-score 80
```

`silo eval` runs the tests of every workflow and resident that has them (or the ones named), and exits 1 when one
got worse than its last report, fell under `--min-score`, or (with `--strict`) any case failed. `silo ask` and
`silo run` print an answer or an output.

## SILO as a tool server

SILO is also an MCP server (`/api/serve/mcp`) and an A2A agent (`/.well-known/agent-card.json`), so LangGraph,
CrewAI, Claude Desktop and other agents can call its residents directly. Turn them on in **System > Outside
programs**.

## Build and publish

```
python -m pip install build twine
python -m build sdk/python
python -m twine upload sdk/python/dist/*
```
