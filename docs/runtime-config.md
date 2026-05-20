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
- optional `load_progress_path` pointing to a small JSON or text file written by
  the runtime adapter during model load
- optional context and timeout metadata for client recommendations

`load_progress_path` is the only source used for determinate load percentages.
When it is absent, the dashboard shows an indeterminate loading bar with elapsed
time instead of pretending elapsed timeout is real progress. The progress file
may contain a bare number (`0.42` or `42`) or JSON such as:

```json
{ "progress": 0.42, "updated_at": "2026-05-20T03:00:00Z" }
```

External OpenAI-compatible APIs can be listed under `openai_upstreams`; they are
passive proxies and are not part of local GPU residency management.

LoRA adapters that should be imported at startup can be listed under
`startup_models` as `alias: ./path/to/adapter.gguf`. The default quick-start
config leaves this empty so a clean install starts without workstation-specific
model files.

Runtime adapter examples live in [Runtime Adapters](runtime-adapters.md),
including a macOS launchd script and Linux systemd/Docker stubs.
