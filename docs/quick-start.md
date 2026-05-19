# Quick Start Design

The gateway is protocol-first. Client frameworks should need only:

- an OpenAI-compatible base URL
- an MCP Streamable HTTP URL
- the discovery manifest for model and timeout hints

Framework-specific support lives in CLI recipes, not in the scheduler or gateway
core. Recipes generate snippets for common clients while keeping the runtime
coordinator independent of Hermes, Continue, Claude Desktop, or any other agent.

`local-ai-gateway doctor` is the first debugging surface. It checks local
dependencies, config parsing, service scripts, and port availability before the
user starts the gateway.

Doctor output uses three statuses:

- `ok`: ready.
- `warn`: actionable context, but not a startup blocker. For example, an enabled
  runtime health URL may be unreachable because the runtime is currently
  unloaded and will be started on demand.
- `fail`: fix before expecting the gateway or runtime to work.
