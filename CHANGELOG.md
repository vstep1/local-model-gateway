# Changelog

All notable changes to this project are documented here.

## v0.4.0 - 2026-05-31

### Added

- Added durable runtime timeline events for queued work, runtime load/unload, cancellation, timeout, and failure history.
- Added dashboard Recent Work filters and a Runtime Timeline panel.
- Added the read-only MCP `runtime_history` tool.

## v0.3.0 - 2026-05-23

### Added

- Added stop-command cancellation for OpenAI-compatible requests, so commands such as `stop` and `cancel generation` cancel matching in-flight local work instead of starting another GPU request.
- Added runtime telemetry support for model-load progress, inference prefill progress, prefill input counts, and transfer bandwidth.
- Added `recent_work` to `/status` so fast one-shot jobs remain visible after completion.
- Added a Recent Work table to `/dashboard`.
- Added runtime adapter/mode fields to work status: `runtimeAlias`, `runtimeAdapter`, and `runtimeMode`.

### Changed

- Updated the dashboard to show runtime, adapter, and mode instead of the confusing public `type`/`kind` vocabulary.
- Reworked one-shot LoRA/`llama-cli` work to appear publicly as a `llama_cli` runtime adapter with `one_shot_command` mode.
- Stabilized dashboard loading animation and live status rendering.
- Updated doctor and agent-install guidance around coordinated one-shot runtime adapter work.

### Fixed

- Fixed dashboard loading progress edge cases where unavailable telemetry could appear as a misleading zero-percent value.
- Fixed dashboard status refresh behavior after the gateway restarts while a runtime is already loaded.

## v0.2.0 - 2026-05-23

### Added

- Added the browser dashboard at `/dashboard`.
- Added stronger agent-led install guardrails and upgraded `doctor` output.
- Added public discovery metadata for dashboard and runtime endpoints.

### Changed

- Clarified repository positioning around lightweight local AI workstation management.
- Improved README polish and public-facing project assets.

## v0.1.0 - 2026-05-23

### Added

- Published the initial public-ready workspace with the OpenAI-compatible gateway, shared GPU coordinator, MCP runtime tools, lazy MCP broker, runtime adapter examples, and demo assets.
