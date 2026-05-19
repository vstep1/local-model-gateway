# macOS launchd Runtime Example

This example wraps one `llama-server` runtime in a launchd service controlled by
Local AI Gateway. The gateway calls the copied script with `start`, `stop`,
`status`, and `logs`; the script writes a launchd plist and a tiny wrapper under
your user Library directory.

## 1. Copy The Adapter

```bash
mkdir -p runtime-adapters
cp examples/runtime-adapters/macos/launchd-llama-server.sh runtime-adapters/qwen3-32b-service.sh
cp examples/runtime-adapters/macos/qwen3-32b-service.env.example runtime-adapters/qwen3-32b-service.env
chmod +x runtime-adapters/qwen3-32b-service.sh
```

Edit `runtime-adapters/qwen3-32b-service.env` for your machine.

For MiniMax:

```bash
cp examples/runtime-adapters/macos/launchd-llama-server.sh runtime-adapters/minimax-m2.7-service.sh
cp examples/runtime-adapters/macos/minimax-m2.7-service.env.example runtime-adapters/minimax-m2.7-service.env
chmod +x runtime-adapters/minimax-m2.7-service.sh
```

## 2. Point Gateway Config At The Script

```yaml
runtimes:
  qwen3-32b:
    enabled: true
    base_url: http://127.0.0.1:18001/v1
    health_url: http://127.0.0.1:18001/v1/models
    service_script: ./runtime-adapters/qwen3-32b-service.sh
    start_args: [start]
    stop_args: [stop]
    idle_ttl_ms: 600000
    load_timeout_ms: 900000
    max_concurrency: 1
    upstream_model: qwen3-32b
    context_window: 131072
    recommended_prompt_budget: 98304
```

## 3. Test The Runtime Script Directly

```bash
./runtime-adapters/qwen3-32b-service.sh status
./runtime-adapters/qwen3-32b-service.sh start
curl http://127.0.0.1:18001/v1/models
./runtime-adapters/qwen3-32b-service.sh stop
```

Once this works, use the gateway normally and let the coordinator call the
script on demand.

## Notes

- Labels default to `ai.local.runtime.<alias>`.
- Plists are written to `~/Library/LaunchAgents`.
- Logs default to `~/Library/Logs/local-ai-gateway/<alias>`.
- Runtime wrapper state defaults to
  `~/Library/Application Support/local-ai-gateway/runtimes/<alias>`.
- The example is intentionally generic; for unusual llama.cpp arguments, copy
  the generated wrapper and hard-code the exact command you need.
