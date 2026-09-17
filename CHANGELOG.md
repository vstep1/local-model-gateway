# Changelog

All notable changes to Local Model Gateway are documented here.

## [0.5.0] - Unreleased

Version 0.5.0 is an unreleased release candidate. See the
[release notes](docs/releases/v0.5.0.md) for the upgrade checklist and current
verification status.

### Added

- Added the experimental managed `POST /v1/audio/speech` route. It requires a
  managed runtime with `supports_audio: true`, non-blank `input` and
  `instructions`, and currently returns non-streaming WAV data.
- Added `supports_audio` capability metadata to managed-runtime config, status,
  model discovery, and the well-known manifest.
- Added the experimental MiniMax Music 3 macOS/MPS runtime adapter and setup
  documentation.

### Changed

- MiniMax Music 3 now generates each request in one native pass with a
  preallocated language-model KV cache. `min_audio_duration` controls when the
  end-of-audio token may be sampled, while `audio_duration` remains the maximum
  target duration.
- Managed upstream proxying now applies the configured runtime timeout to both
  response headers and body transfer, which supports long audio responses.
- Request history and telemetry now preserve the first terminal outcome. Late
  upstream callbacks cannot rewrite a completed, failed, or cancelled work
  item.
- Active prefill telemetry now requires fresh progress from the current request;
  stale progress from an earlier request is suppressed.
- Aborted or timed-out upstream response bodies now release GPU admission even
  when the response is never read.
- macOS `service install` now preflights the exact Node executable and gateway
  entrypoint before replacing launchd state.
- The macOS llama-server adapter now understands modern and legacy slot
  telemetry, writes progress atomically, prevents prefill telemetry from
  regressing after generation begins, and handles quoted environment paths and
  empty extra-argument lists.
- Visual QA now uses local Playwright reports and screenshot artifacts without
  an external Argos dependency or upload step.

### Fixed

- Fixed managed proxy history that could record an HTTP or transport failure as
  successful work.
- Fixed cancellation handling so a closed client request is recorded as
  cancelled without a second response being written after the connection ends.
- Fixed blank audio fields being admitted to the queue; MiniMax now rejects
  non-loopback hosts before GPU/model imports and invalid numeric, integer,
  positive-step, or seed-range values before each generation.
- Fixed MiniMax launchd plist generation to XML-escape paths and lint the
  temporary plist before replacing the existing service definition.

### Security and maintenance

- Updated the dependency lockfile for security remediation and kept generated
  Python bytecode out of the repository.

### Upgrade notes

- Existing experimental MiniMax installs must refresh the copied adapter files
  from [the repository example](examples/runtime-adapters/minimax-music3/README.md),
  including `server.py` and the new `request_validation.py`, before restarting
  the runtime.
- Use Node.js 22, then run `npm install`, `npm run build`, and
  `npx local-model-gateway doctor --json` after updating. If the doctor report
  has top-level `status: fail`, follow its read-only `doctor --fix-plan` output.
- Updating files and running the doctor does not automatically restart the
  gateway or runtime. Restart services explicitly when the local installation
  is ready.

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

[0.5.0]: https://github.com/vstep1/local-model-gateway/compare/v0.4.0...HEAD
