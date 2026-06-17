# Docker Runtime Reference Template

This is a reference-only protocol-shape example for containerized deployments.
It is not a supported installer or production deployment, and it is not
exercised by CI.

It is not yet the recommended local workstation path because GPU flags differ
across Apple Silicon, CUDA, ROCm, Docker Desktop, Colima, and host networking
setups. Use it to understand the service split:

- `gateway`: exposes OpenAI-compatible HTTP and MCP
- `qwen3-32b`: exposes an OpenAI-compatible local runtime on loopback

Before using it for real:

- replace `LOCAL_MODEL_GATEWAY_AUTH_TOKEN`
- mount writable config/data/model directories explicitly
- add the correct GPU device flags for your host
- update `local-model-gateway.config.yaml` so runtime `base_url` and `health_url`
  point at the container or host loopback endpoint you actually expose
- validate the host networking and GPU device flags on your target machine

```bash
docker compose -f examples/runtime-adapters/docker/compose.stub.yaml up gateway
docker compose -f examples/runtime-adapters/docker/compose.stub.yaml --profile runtime up qwen3-32b
```
