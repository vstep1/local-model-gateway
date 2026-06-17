# Agent-Led Install Runbook

This runbook is for local agents that are installing or repairing Local Model
Gateway on a user's workstation.

## Install Flow

```bash
npm install
npm run build
npx local-model-gateway init
npx local-model-gateway doctor --json
```

If the JSON status is `fail`, stop and run:

```bash
npx local-model-gateway doctor --fix-plan
```

Follow the printed plan. Do not invent alternate ports, direct model commands, or
framework-specific workarounds.

## Start And Verify

Foreground start:

```bash
npx local-model-gateway start
```

macOS launchd start:

```bash
npx local-model-gateway service install
```

Verification endpoints:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/status
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/.well-known/local-model-gateway.json
open http://127.0.0.1:8787/dashboard
```

If auth is configured, include the configured bearer token for protected JSON
endpoints. `/health`, `/dashboard`, and the discovery manifest remain public on
loopback.

## Doctor Contract

`doctor` is read-only. It may inspect ports, processes, configs, runtime scripts,
and gateway endpoints. It must not edit files, stop services, kill processes, or
download models.

Use the outputs this way:

- `doctor`: human-readable checks.
- `doctor --json`: machine-readable status for agents.
- `doctor --fix-plan`: ordered remediation steps for the user or agent to review.

See [CLI Reference](cli-reference.md) for every command and flag.

The JSON output has a top-level `status` of `ok`, `warn`, or `fail`. Agents
should treat `fail` as a blocker.

## Common Failure Modes

### Sibling Gateway

Symptom: `/dashboard` shows idle, but fans are running or another port is
serving OpenAI-compatible requests.

Cause: another `local-model-gateway` is running on a port such as `8788`.

Correct action: stop or let the sibling gateway finish, update clients to use
`http://127.0.0.1:8787/v1`, and rerun `doctor --json`.

Do not start a second gateway to work around config or LaunchAgent issues.

### Direct llama.cpp Process

Symptom: `llama-cli` or `llama-server` is consuming CPU/GPU but `/status` does
not show active work.

Cause: model work is running outside the coordinator.

Correct action: route the workload through the gateway. For a long-running
server, add it as a resident service runtime. For one-shot LoRA work, route it
through a `llama_cli` runtime adapter so it appears in `/status` and the
dashboard.

### Runtime Health Is Down

Symptom: a managed runtime health URL is unreachable.

Cause: the runtime may simply be unloaded.

Correct action: verify the service script exists and is executable. The gateway
will start unloaded managed runtimes on demand.

### Unmanaged Loopback Upstream

Symptom: config points an external upstream at another local OpenAI-compatible
server.

Cause: the local server can bypass GPU residency and queue policy.

Correct action: convert the server into a managed runtime unless the user
explicitly wants an unmanaged isolation case.

## Agent Reporting Checklist

When finishing an install or repair, report:

- `doctor --json` top-level status.
- Dashboard URL and reachability.
- `/v1/models` aliases.
- Any running local model processes doctor still flags.
- Any manual approval needed before stopping services or changing config.
