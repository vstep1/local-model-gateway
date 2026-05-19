# Local Model Gateway Agent Install Contract

Use this file when an agent is installing, configuring, or debugging this repo.

## Required Flow

1. Run `npm install` and `npm run build` after checkout.
2. Run `npx local-model-gateway init` only if `local-model-gateway.config.yaml` is missing, or use `--force` only with explicit user approval.
3. Run `npx local-model-gateway doctor --json` before starting services or editing runtime config.
4. If doctor reports `fail`, run `npx local-model-gateway doctor --fix-plan` and follow the plan. Do not improvise a side path.
5. Start the gateway with `npx local-model-gateway start` for foreground use or `npx local-model-gateway service install` for macOS launchd.
6. Verify `http://127.0.0.1:8787/dashboard`, `/status`, `/v1/models`, and the discovery manifest.

## Hard Rules

- Treat `http://127.0.0.1:8787/v1` as the single local GPU admission path.
- Do not start a second `local-model-gateway` on `8788` or another port unless the user explicitly asks for an isolated test.
- Do not start `llama-server` or `llama-cli` directly as a workaround for bad gateway config. Fix the managed runtime or exclusive-job config instead.
- Do not bind non-loopback hosts unless auth is configured.
- Do not expose unmanaged loopback upstreams unless the user explicitly accepts that they are outside local GPU residency control.
- Do not kill processes, stop services, or rewrite configs automatically from doctor output. Doctor is read-only in this version.

## Common Failure Modes

- Dashboard idle but fans running: check for sibling gateways and direct `llama-cli` or `llama-server` processes. Use `doctor --json` first.
- Port `8787` occupied: verify whether it is this gateway. If another process owns it, stop that process or choose a deliberate config change.
- Runtime health unavailable: this can be normal when a managed runtime is unloaded. Check the runtime service script and let the gateway start it on demand.
- Model does not appear in `/v1/models`: enable a managed runtime, add a startup LoRA model, or configure an external upstream intentionally.

## Agent Output Expectations

When reporting install status to a user, include:

- `doctor --json` top-level status.
- Whether the dashboard is reachable.
- Which model aliases are exposed by `/v1/models`.
- Any fix-plan steps that still require user approval.
