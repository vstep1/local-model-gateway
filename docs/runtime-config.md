# Runtime Config

`local-ai-gateway.config.yaml` is the source of truth for local runtime setup.

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

