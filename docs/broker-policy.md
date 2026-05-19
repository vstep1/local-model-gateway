# Lazy MCP Broker Policy

The lazy MCP broker keeps the agent-facing tool surface small:

- `search_tools`
- `describe_tool`
- `call_tool`
- `list_servers`

Downstream tools are exposed only when policy allows:

- `effect: read`
- `confirmation: never`

`search_tools` returns compact summaries only and never includes full schemas or
a `risk level` field. Large downstream results spill to local files instead of
being blindly truncated.
