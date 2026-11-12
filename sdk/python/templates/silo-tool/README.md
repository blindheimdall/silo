# {{title}}

Python tools for SILO residents, as a [FastMCP](https://github.com/modelcontextprotocol/python-sdk) server.

- `server.py`: the tools. Each `@mcp.tool()` function is one tool; its docstring and type hints tell residents how to use it.
- `requirements.txt`: the packages it needs. Add yours here.

## Run it

SILO added it as the connector **{{title}}** (System, Connectors). If you chose to install it, it uses its own
virtual environment in `.venv`. Otherwise install the packages yourself:

```
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
.venv/bin/python -m pip install -r requirements.txt       # macOS, Linux
```

then set the connector's command to that `.venv` Python and press Refresh.

## Safety

The connector runs on this computer with your rights, without a sandbox. Residents ask you before each call while
its approval is "always". Read code from others before you run it.
