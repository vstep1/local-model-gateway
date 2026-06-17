# CLI Reference

The CLI binary is `local-model-gateway`. From a source checkout, run it through
`npx`:

```bash
npx local-model-gateway <command>
```

There is no global `--config` flag today. Commands that read gateway
configuration use `local-model-gateway.config.yaml` in the current working
directory by default, or the file pointed to by `LOCAL_MODEL_GATEWAY_CONFIG`.

## Commands

| Command | Purpose |
| --- | --- |
| `local-model-gateway` | Print usage. |
| `local-model-gateway --help` | Print usage. |
| `local-model-gateway -h` | Print usage. |
| `local-model-gateway init` | Write a starter `local-model-gateway.config.yaml` in the current directory. |
| `local-model-gateway doctor` | Run read-only install, config, process, and endpoint checks. |
| `local-model-gateway start` | Start the gateway in the foreground. |
| `local-model-gateway service install` | Install and start the macOS launchd service. |
| `local-model-gateway recipes list` | Print the names of available client setup recipes. |
| `local-model-gateway recipes show <recipe>` | Print one client setup recipe. |

## Flags

Only the flags below are supported. The current parser is intentionally small
and does not provide command-specific help output.

| Flag | Applies to | Purpose |
| --- | --- | --- |
| `--help` | root command | Print usage and exit successfully. |
| `-h` | root command | Print usage and exit successfully. |
| `--force` | `init` | Overwrite an existing `local-model-gateway.config.yaml`. Without this flag, `init` leaves an existing config untouched and reports its path. |
| `--json` | `doctor` | Print the doctor report as machine-readable JSON. |
| `--fix-plan` | `doctor` | Print an ordered, read-only remediation plan. |

If `doctor` receives both `--json` and `--fix-plan`, JSON output wins.

## `init`

```bash
npx local-model-gateway init
npx local-model-gateway init --force
```

`init` detects the local platform, Node path, memory size, and any
`llama-cli`/`llama-server` binaries on `PATH`, then writes
`local-model-gateway.config.yaml`.

Generated heavyweight runtime presets are disabled by default. Enable them only
after wiring their service scripts to working local runtimes.

## `doctor`

```bash
npx local-model-gateway doctor
npx local-model-gateway doctor --json
npx local-model-gateway doctor --fix-plan
```

`doctor` is read-only. It checks the resolved config, local process state,
gateway reachability, managed runtime scripts, runtime health URLs, sibling
gateway listeners, unmanaged loopback upstreams, and direct `llama.cpp`
processes.

Output modes:

| Mode | Use |
| --- | --- |
| default | Human-readable status for a terminal. |
| `--json` | Agent and CI consumption. The top-level status is `ok`, `warn`, or `fail`. |
| `--fix-plan` | Ordered remediation steps. The command still does not mutate files or services. |

Exit behavior:

- exits `0` when the aggregate doctor status is `ok` or `warn`
- exits `1` when the aggregate doctor status is `fail`

## `start`

```bash
npx local-model-gateway start
```

Starts the gateway in the foreground using the resolved config. Keep this
process running while clients use the gateway.

Default local endpoints:

| Endpoint | URL |
| --- | --- |
| OpenAI-compatible API | `http://127.0.0.1:8787/v1` |
| MCP Streamable HTTP | `http://127.0.0.1:8787/mcp` |
| Status | `http://127.0.0.1:8787/status` |
| Dashboard | `http://127.0.0.1:8787/dashboard` |
| Discovery manifest | `http://127.0.0.1:8787/.well-known/local-model-gateway.json` |

## `service install`

```bash
npx local-model-gateway service install
```

Installs and starts a macOS launchd service for the current checkout/config.
The command writes a LaunchAgent plist under the current user's
`~/Library/LaunchAgents` directory and starts it with `launchctl`.

This command currently supports macOS only. On Linux or other platforms, run the
gateway in the foreground with `local-model-gateway start` or adapt the
reference systemd/Docker examples.

## `recipes list`

```bash
npx local-model-gateway recipes list
```

Prints the recipe names accepted by `recipes show`:

```text
generic-openai
generic-mcp
hermes
```

## `recipes show`

```bash
npx local-model-gateway recipes show generic-openai
npx local-model-gateway recipes show generic-mcp
npx local-model-gateway recipes show hermes
```

Available recipes:

| Recipe | Output |
| --- | --- |
| `generic-openai` | Base URL, API key placeholder, model guidance, and a `curl` chat-completions example. |
| `generic-mcp` | MCP Streamable HTTP URL and useful setup tool names. |
| `hermes` | Hermes provider and MCP server snippet. |

Unknown recipe names exit with an error and print the available recipe names.

## Common Environment Variables

These are not CLI flags, but they are the supported way to point commands at a
non-default config or override config values during local testing.

| Variable | Use |
| --- | --- |
| `LOCAL_MODEL_GATEWAY_CONFIG` | Path to the config file read by `doctor`, `start`, and `service install`. |
| `LOCAL_MODEL_GATEWAY_HOST` | Override `server.host`. Non-loopback hosts require auth. |
| `LOCAL_MODEL_GATEWAY_PORT` | Override `server.port`. |
| `LOCAL_MODEL_GATEWAY_AUTH_TOKEN` | Configure bearer auth for protected endpoints. |
| `LOCAL_MODEL_GATEWAY_DATA_DIR` | Override the data directory. |
| `LOCAL_MODEL_GATEWAY_DB_PATH` | Override the SQLite database path. |
| `LOCAL_MODEL_GATEWAY_MODELS_DIR` | Override managed model storage. |
| `LOCAL_MODEL_GATEWAY_MODEL_SOURCE_DIR` | Override model source directory. |
| `LOCAL_MODEL_GATEWAY_OPENAI_UPSTREAMS` | JSON override for unmanaged OpenAI-compatible upstreams. |
| `LOCAL_MODEL_GATEWAY_MANAGED_RUNTIMES` | JSON override for managed runtime definitions. |

See [Runtime Config](runtime-config.md) for the full config file schema and
runtime adapter settings.
