# Lazy MCP Broker Policy

The lazy MCP broker keeps the agent-facing tool surface small:

- `search_tools`
- `describe_tool`
- `call_tool`
- `list_servers`

Downstream tools are exposed only when policy allows:

- `effect: read`
- `confirmation: never`

The broker does not eagerly start every downstream MCP. It loads cached tool
metadata from `LAZY_MCP_BROKER_CATALOG_CACHE` when available, serves compact
`search_tools` results from that snapshot, and connects a downstream server only
for targeted catalog refreshes, `describe_tool`, or `call_tool`. Set
`LAZY_MCP_BROKER_REFRESH_ON_START=true` only when eager background refresh is
preferred over the lowest startup cost.

`search_tools` returns compact summaries only and never includes full schemas or
a `risk level` field. Large downstream results spill to local files instead of
being blindly truncated.
