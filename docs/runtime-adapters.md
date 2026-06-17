# Runtime Adapters

Runtime adapters are the bridge between the gateway coordinator and a concrete
local model server. The gateway does not need to know how your machine starts a
model; it only needs a script with a small command contract.

## Support Status

| Adapter shape | Status | Use it for |
| --- | --- | --- |
| macOS launchd | Supported example path | Local Apple Silicon workstations using `llama-server`. |
| Generic shell script | Supported contract | Custom local runtimes that can implement `start` and `stop`. |
| Linux systemd | Reference-only template | Designing a Linux deployment after adding host-specific users, paths, GPU access, and hardening. |
| Docker Compose | Reference-only template | Understanding the service split before building a host-specific container deployment. |

Reference-only templates are not CI-tested install paths. Treat them as
architecture sketches, not production-ready service definitions.

## Adapter Contract

Each managed runtime config points at:

- `service_script`
- `start_args`
- `stop_args`
- `health_url`
- `base_url`

The coordinator calls:

```bash
<service_script> <start_args...>
<service_script> <stop_args...>
```

Then it polls `health_url` until the OpenAI-compatible runtime is ready.

## macOS launchd

Use the macOS example when you want the gateway to control `llama-server`
through a per-user LaunchAgent:

- [macOS launchd README](../examples/runtime-adapters/macos/README.md)
- [generic launchd llama-server script](../examples/runtime-adapters/macos/launchd-llama-server.sh)
- [Qwen3-32B env example](../examples/runtime-adapters/macos/qwen3-32b-service.env.example)
- [MiniMax M2.7 env example](../examples/runtime-adapters/macos/minimax-m2.7-service.env.example)

This is the first supported adapter shape because it matches local Apple Silicon
workstation use.

## Linux systemd Reference Templates

The systemd files are reference-only templates for Linux hosts:

- [systemd README](../examples/runtime-adapters/linux/systemd/README.md)
- [gateway unit template](../examples/runtime-adapters/linux/systemd/local-model-gateway.service.template)
- [runtime unit template](../examples/runtime-adapters/linux/systemd/llama-runtime.service.template)

They show the service shape but still need host-specific GPU, user, directory,
and security hardening before production use. They are not a supported
one-command Linux installer.

## Docker Reference Template

The Docker Compose files are reference-only deployment templates:

- [Docker README](../examples/runtime-adapters/docker/README.md)
- [Compose stub](../examples/runtime-adapters/docker/compose.stub.yaml)

Container GPU access is host-specific, so Docker is documented as an extension
target rather than the default quick start. The compose file is not a tested
production deployment.

## Practical Guidance

- Start with a runtime script that can pass `status`, `start`, and `stop`
  manually.
- Make `health_url` return `/v1/models` only after the model is genuinely ready.
- Keep runtime endpoints on loopback unless you have explicit auth and network
  isolation.
- Give large models realistic `load_timeout_ms` values.
- Use `max_concurrency: 1` until you have measured same-model parallelism on
  your machine.
