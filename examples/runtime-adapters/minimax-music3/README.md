# MiniMax Music 3 macOS Runtime

This experimental adapter exposes a local
[MiniMax Music 3](https://huggingface.co/MiniMaxAI/MiniMax-Music3) Diffusers
pipeline as `POST /v1/audio/speech`, then lets Local Model Gateway manage it
through the shared GPU queue.

The tested path is Apple Silicon with MPS and BF16. The model download is about
28 GiB, generation is compute-intensive, and the model weights retain their
upstream license. This repository does not redistribute them.

For long requests, the adapter renders memory-bounded 20-second Music3
sections and joins them with one-second crossfades until the exact requested
sample count is available. This avoids the growing autoregressive cache of a
single multi-minute pass and also handles Music3 emitting its end-of-audio
token before the requested upper bound. Tune the defaults with
`MINIMAX_MUSIC3_MAX_SEGMENT_SECONDS`, `MINIMAX_MUSIC3_CROSSFADE_SECONDS`, and
`MINIMAX_MUSIC3_MAX_SEGMENTS`.

## Install

From the repository root:

```bash
mkdir -p runtime/minimax-music3
cp examples/runtime-adapters/minimax-music3/server.py runtime/minimax-music3/
cp examples/runtime-adapters/minimax-music3/audio_segments.py runtime/minimax-music3/
cp examples/runtime-adapters/minimax-music3/requirements.txt runtime/minimax-music3/
cp examples/runtime-adapters/minimax-music3/minimax-music3-service.sh runtime/
chmod +x runtime/minimax-music3-service.sh

python3.12 -m venv runtime/minimax-music3/.venv
runtime/minimax-music3/.venv/bin/pip install -r runtime/minimax-music3/requirements.txt
runtime/minimax-music3/.venv/bin/hf download MiniMaxAI/MiniMax-Music3 \
  --local-dir runtime/minimax-music3/model
```

Add the managed runtime to `local-model-gateway.config.yaml`:

```yaml
runtimes:
  minimax-music3:
    enabled: true
    base_url: http://127.0.0.1:18009/v1
    health_url: http://127.0.0.1:18009/v1/models
    service_script: ./runtime/minimax-music3-service.sh
    load_progress_path: ./runtime/minimax-music3/load-progress.json
    start_args: [start]
    stop_args: [stop]
    idle_ttl_ms: 1800000
    load_timeout_ms: 7200000
    max_concurrency: 1
    upstream_model: MiniMaxAI/MiniMax-Music3
    supports_audio: true
    supports_streaming: false
    supports_reasoning: false
```

Run the required preflight before starting or restarting the gateway:

```bash
npx local-model-gateway doctor --json
```

If the result has top-level `status: fail`, follow only the generated plan:

```bash
npx local-model-gateway doctor --fix-plan
```

Otherwise, start the gateway normally. The optional LibreChat music dashboard
runs separately from the gateway dashboard and is available at `/music` in
that app (port 3080 in the standard local setup):

```bash
npx local-model-gateway start
open http://127.0.0.1:3080/music
```

## API smoke test

```bash
curl http://127.0.0.1:8787/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "minimax-music3",
    "input": "[Verse]\nCity lights are fading\n\n[Chorus]\nWe carry sparks of summer",
    "instructions": "Warm acoustic pop, close vocal, brushed drums.",
    "max_new_tokens": 125,
    "num_inference_steps": 30,
    "seed": 7,
    "response_format": "wav",
    "stream": false
  }' \
  --output test-output.wav
```

Music 3 produces about 25 audio frames per second, so `max_new_tokens: 125`
requests roughly five seconds. The dashboard converts its length field using
the same ratio.

## Adapter contract

- The adapter binds only to `127.0.0.1:18009`.
- The launchd label is `ai.local.runtime.minimax-music3`.
- The gateway owns admission at `127.0.0.1:8787/v1`; do not send normal client
  traffic directly to port 18009.
- The runtime loads on demand, reports load progress through a small JSON file,
  serializes generation with a process lock, and returns PCM16 WAV audio.
- `HF_HUB_OFFLINE=1` is set for inference so missing components fail instead of
  silently fetching after startup.
