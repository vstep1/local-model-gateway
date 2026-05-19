# Linux systemd Runtime Stub

The systemd files here are starting points, not a full installer.

The gateway needs two things:

- a long-running gateway service
- one service per managed runtime that exposes an OpenAI-compatible
  `llama-server` endpoint on loopback

## Gateway Service

```bash
sudo install -o root -g root -m 0644 \
  examples/runtime-adapters/linux/systemd/local-ai-gateway.service.template \
  /etc/systemd/system/local-ai-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now local-ai-gateway.service
```

## Runtime Service

```bash
sudo mkdir -p /etc/local-ai-gateway/runtimes
sudo install -o root -g root -m 0644 \
  examples/runtime-adapters/linux/systemd/llama-runtime.service.template \
  /etc/systemd/system/local-ai-runtime@.service
sudo install -o root -g root -m 0644 \
  examples/runtime-adapters/linux/systemd/qwen3-32b.env.example \
  /etc/local-ai-gateway/runtimes/qwen3-32b.env
sudo systemctl daemon-reload
sudo systemctl start local-ai-runtime@qwen3-32b.service
```

In `local-ai-gateway.config.yaml`, point the runtime script at a shell wrapper
that calls `systemctl start local-ai-runtime@qwen3-32b.service` and `systemctl
stop local-ai-runtime@qwen3-32b.service`, or replace this stub with a first-class
systemd adapter.

This directory includes a basic wrapper for that contract:

```bash
mkdir -p runtime-adapters
cp examples/runtime-adapters/linux/systemd/systemd-runtime-wrapper.sh runtime-adapters/qwen3-32b-service.sh
cat > runtime-adapters/qwen3-32b-service.env <<'EOF'
RUNTIME_ALIAS=qwen3-32b
RUNTIME_SYSTEMD_UNIT=local-ai-runtime@qwen3-32b.service
RUNTIME_SYSTEMD_SCOPE=system
EOF
chmod +x runtime-adapters/qwen3-32b-service.sh
```

GPU access, users, paths, and sandboxing vary by distro and accelerator. Treat
these templates as a portable shape, then harden for your host.
