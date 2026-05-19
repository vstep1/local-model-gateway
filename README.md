# Local AI Gateway

Local AI Gateway coordinates local model residency for agent workloads. It exposes
one OpenAI-compatible HTTP endpoint and one MCP endpoint, while a shared SQLite
queue decides which local runtime is loaded and when queued work can run.

## Quick Start

```bash
npm install
npm run build
npx local-ai-gateway init
npx local-ai-gateway doctor
npx local-ai-gateway start
```

Default endpoints:

- OpenAI-compatible API: `http://127.0.0.1:8787/v1`
- MCP Streamable HTTP: `http://127.0.0.1:8787/mcp`
- Status: `http://127.0.0.1:8787/status`
- Discovery manifest: `http://127.0.0.1:8787/.well-known/local-ai-gateway.json`

## CLI

```bash
npx local-ai-gateway init
npx local-ai-gateway doctor
npx local-ai-gateway start
npx local-ai-gateway service install
npx local-ai-gateway recipes list
npx local-ai-gateway recipes show generic-openai
npx local-ai-gateway recipes show generic-mcp
npx local-ai-gateway recipes show hermes
```

`init` writes `local-ai-gateway.config.yaml`. Runtime presets for Qwen3-32B and
MiniMax M2.7 are included disabled by default; enable only after installing a
matching local runtime adapter on the machine.

## Packages

- `@local-ai-gateway/core`: SQLite queue, GPU coordinator, runtime config, model registry.
- `@local-ai-gateway/gateway`: OpenAI-compatible routes and MCP tools.
- `@local-ai-gateway/runtime-adapters`: launchd and shell adapter helpers.
- `@local-ai-gateway/lazy-mcp-broker`: compact read-first MCP broker.
- `local-ai-gateway`: CLI.

## Safety Defaults

- The gateway binds to `127.0.0.1` by default.
- Non-loopback binds require `server.auth_token` or `LOCAL_AI_GATEWAY_AUTH_TOKEN`.
- Local loopback upstreams are rejected unless explicitly allowed, so GPU work
  cannot bypass the coordinator accidentally.
- Runtime state, SQLite databases, model files, logs, and local config are ignored.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run ci
```

