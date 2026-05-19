# @local-model-gateway/lazy-mcp-broker

Read-first lazy MCP broker that exposes compact downstream tool discovery.

Startup is intentionally cheap: the broker registers configured downstream
servers, loads a local catalog snapshot if one exists, and starts serving its
four broker tools without opening every downstream MCP process. Downstream MCPs
are connected only when a selected tool needs a fresh catalog or an actual call.

The broker surface is intentionally small:

- `search_tools`
- `describe_tool`
- `call_tool`
- `list_servers`

Useful environment variables:

- `LAZY_MCP_BROKER_CONFIG`: downstream MCP config path.
- `LAZY_MCP_BROKER_CATALOG_CACHE`: catalog snapshot path.
- `LAZY_MCP_BROKER_REFRESH_ON_START=true`: opt into eager background catalog
  refresh after startup. The default is lazy/no eager refresh.
