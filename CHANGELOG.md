# Changelog

All notable changes to Local Model Gateway are documented here.

## [0.5.0] - 2026-08-14

### Added

- Managed, OpenAI-compatible `POST /v1/audio/speech` proxying with shared GPU
  admission, cancellation, history, and binary WAV passthrough.
- `supports_audio` managed-runtime capability metadata in config, status, runtime
  discovery, and the well-known manifest.
- An experimental MiniMax Music 3 macOS/MPS runtime adapter and setup guide.

### Changed

- Audio requests are rejected unless the selected managed runtime explicitly
  declares `supports_audio: true`.

### Fixed

- Long-running audio requests now use the managed runtime timeout for response
  headers and body transfer instead of failing at the HTTP client's shorter
  default header timeout.
- Managed runtime proxy failures are recorded as failed work rather than
  successful work, and cancelled MiniMax adapter responses no longer emit a
  second error over a closed connection.

[0.5.0]: https://github.com/vstep1/local-model-gateway/compare/v0.4.0...v0.5.0

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
