# Quick Start

The fastest way to prove a source checkout works is the bundled no-GPU
quickstart. It uses a tiny local OpenAI-compatible mock runtime, but the runtime
is still declared as a managed runtime. That means the gateway exercises the
same lifecycle used for real local model servers: start script, health check,
queue admission, OpenAI proxying, status, dashboard, and runtime history.
If another gateway is already listening on `127.0.0.1:8787`, stop it before
running this smoke test.

## 1. Build From Source

```bash
git clone https://github.com/vstep1/local-model-gateway.git
cd local-model-gateway
npm install
npm run build
```

## 2. Run The Managed-Runtime Smoke Test

Terminal 1:

```bash
LOCAL_MODEL_GATEWAY_CONFIG=examples/quickstart/local-model-gateway.config.yaml \
  npx local-model-gateway doctor

LOCAL_MODEL_GATEWAY_CONFIG=examples/quickstart/local-model-gateway.config.yaml \
  npx local-model-gateway start
```

`doctor` may warn that the runtime health URL is not reachable before startup.
That is expected for an unloaded on-demand runtime. It should not report a
top-level `fail`.

Terminal 2:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "quickstart-mock",
    "messages": [
      { "role": "user", "content": "Confirm the gateway quickstart works." }
    ]
  }'

curl 'http://127.0.0.1:8787/status?recent_limit=5&timeline_limit=10'
open http://127.0.0.1:8787/dashboard
```

The chat response should include `quickstart-mock response`. `/status` should
show `quickstart-mock` in managed runtime state and recent runtime timeline
events.

When done, press `Ctrl+C` in Terminal 1 and stop the mock runtime:

```bash
node examples/quickstart/mock-runtime-service.mjs stop
```

## 3. Create A Real Local Config

```bash
npx local-model-gateway init
npx local-model-gateway doctor
npx local-model-gateway doctor --json
npx local-model-gateway doctor --fix-plan
```

Fresh configs are safe by default. Heavyweight runtime presets are generated
disabled until you point them at local service scripts that work on your
machine.

Start the gateway:

```bash
npx local-model-gateway start
```

Default endpoints:

| Endpoint | URL |
| --- | --- |
| OpenAI-compatible API | `http://127.0.0.1:8787/v1` |
| MCP Streamable HTTP | `http://127.0.0.1:8787/mcp` |
| Status | `http://127.0.0.1:8787/status` |
| Dashboard | `http://127.0.0.1:8787/dashboard` |
| Discovery manifest | `http://127.0.0.1:8787/.well-known/local-model-gateway.json` |

## Design Notes

The gateway is protocol-first. Client frameworks should need only:

- an OpenAI-compatible base URL
- an MCP Streamable HTTP URL
- the discovery manifest for model and timeout hints

Framework-specific support lives in CLI recipes, not in the scheduler or gateway
core. Recipes generate snippets for common clients while keeping the runtime
coordinator independent of Hermes, Continue, Claude Desktop, or any other agent.

`local-model-gateway doctor` is the first debugging surface. It checks local
dependencies, config parsing, service scripts, and port availability before the
user starts the gateway.

Doctor output uses three statuses:

- `ok`: ready.
- `warn`: actionable context, but not a startup blocker. For example, an enabled
  runtime health URL may be unreachable because the runtime is currently
  unloaded and will be started on demand.
- `fail`: fix before expecting the gateway or runtime to work.
