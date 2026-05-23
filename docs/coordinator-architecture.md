# Coordinator Architecture

The gateway has one durable GPU admission queue: `gpu_work_items`.

OpenAI-compatible HTTP requests and MCP `submit_job` requests both enqueue GPU work through `GpuCoordinator`. The public `jobs` table remains the MCP-facing job API, but it is no longer the execution queue when the coordinator is enabled.

## Runtime Adapters

The public model is runtime-first: every piece of GPU work has a runtime alias,
adapter, and mode.

- `openai_service` + `resident_service`: long-running OpenAI-compatible local
  runtimes such as `qwen3-32b` and `minimax-m2.7`.
- `llama_cli` + `one_shot_command`: single-process runtime work such as
  `llama-cli --lora` for an `ep2` sanitizer request.

SQLite still stores a small internal compatibility discriminator for scheduler
admission. Client-facing status and dashboard output should use adapter/mode
language.

## Admission Rules

- Higher priority wins.
- Same priority is FIFO using SQLite insertion order.
- A different model waits until active requests drain.
- Same-model runtime work can share a loaded runtime only up to `maxConcurrency`.
- One-shot command adapter work unloads resident service runtimes before
  execution.
- Active work is not interrupted except by explicit cancellation or admin force unload.

## Recovery

Startup marks queued/running `gpu_work_items` failed with `gateway_restarted`. Linked public MCP jobs are failed at the same time so callers never wait forever on abandoned work.
