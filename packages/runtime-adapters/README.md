# Runtime Adapters

This package contains service adapter helpers used by the CLI.

Implemented:

- macOS launchd plist rendering
- shell command rendering

Examples:

- `../../examples/runtime-adapters/macos`: reusable launchd llama-server adapter
- `../../examples/runtime-adapters/linux/systemd`: Linux systemd service stubs
- `../../examples/runtime-adapters/docker`: Docker Compose deployment stub

Planned:

- systemd unit rendering
- Docker Compose runtime adapter helpers
