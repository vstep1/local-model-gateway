# Security

The gateway starts and stops local model processes. Treat config files, runtime
adapter scripts, and MCP downstream definitions as trusted local administration
inputs.

The default server binds to `127.0.0.1`. Binding to a non-loopback host requires
an auth token and should only be done behind local network controls.

Do not include secrets in examples or issue reports. The gateway redacts bearer
tokens, API keys, and user-home paths in public status and diagnostic output.
