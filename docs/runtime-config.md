# Runtime Config

`local-model-gateway.config.yaml` is the source of truth for local runtime setup.

Managed runtimes are OpenAI-compatible local services controlled by a service
script. Each runtime needs:

- `base_url`
- `health_url`
- `service_script`
- `start_args`
- `stop_args`
- `max_concurrency`
- optional context and timeout metadata for client recommendations

External OpenAI-compatible APIs can be listed under `openai_upstreams`; they are
passive proxies and are not part of local GPU residency management.

LoRA adapters that should be imported at startup can be listed under
`startup_models` as `alias: ./path/to/adapter.gguf`. The default quick-start
config leaves this empty so a clean install starts without workstation-specific
model files.

Runtime adapter examples live in [Runtime Adapters](runtime-adapters.md),
including a macOS launchd script and Linux systemd/Docker stubs.
