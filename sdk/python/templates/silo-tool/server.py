"""{{title}}: tools for SILO residents, written in Python with FastMCP.

SILO starts this file as a stdio MCP connector. Every function marked @mcp.tool() becomes a tool that residents with
this connector can call. Its docstring is the description they read and its type hints are the arguments, so keep
both clear. Return plain data (str, int, float, bool, list, dict).

Change the tools, then press Refresh on the connector in SILO. Try it alone with:  python server.py
(it then waits for an MCP client on stdin; stop it with Ctrl+C).

The connector runs in the SILO workspace folder, so relative paths point there. Approval is "always" by default:
residents ask you before each call. Lower it in the connector settings only for tools that just read.
"""
from mcp.server.fastmcp import FastMCP

mcp = FastMCP({{name_json}}, instructions={{description_json}})


@mcp.tool()
def word_count(text: str) -> dict:
    """Counts the words, lines and characters of a text."""
    return {"words": len(text.split()), "lines": len(text.splitlines()), "characters": len(text)}


@mcp.tool()
def add(a: float, b: float) -> float:
    """Adds two numbers exactly as given."""
    return a + b


if __name__ == "__main__":
    mcp.run()  # stdio
