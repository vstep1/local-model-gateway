# MiniMax Music 3 macOS Runtime

This experimental adapter exposes a local
[MiniMax Music 3](https://huggingface.co/MiniMaxAI/MiniMax-Music3) Diffusers
pipeline as `POST /v1/audio/speech`, then lets Local Model Gateway manage it
through the shared GPU queue.

The tested path is Apple Silicon with MPS and BF16. The model download is about
28 GiB, generation is compute-intensive, and the model weights retain their
upstream license. This repository does not redistribute them.

Each request is one native Music3 generation pass. On MPS, the adapter
preallocates the language model's KV cache for the full request instead of
growing and reallocating it one token at a time. This removes the former
section-and-crossfade workaround and preserves composition-level continuity.

By default, `audio_duration` is both the minimum and maximum duration: the
adapter suppresses Music3's end-of-audio token until that duration. Set
`min_audio_duration` lower than `audio_duration` to give the model a window in
which to choose its own ending, or set it to `0` for the upstream early-ending
behavior.

## Install

From the repository root:

```bash
mkdir -p runtime/minimax-music3
cp examples/runtime-adapters/minimax-music3/server.py runtime/minimax-music3/
cp examples/runtime-adapters/minimax-music3/audio_utils.py runtime/minimax-music3/
cp examples/runtime-adapters/minimax-music3/cache_control.py runtime/minimax-music3/
cp examples/runtime-adapters/minimax-music3/duration_control.py runtime/minimax-music3/
cp examples/runtime-adapters/minimax-music3/request_validation.py runtime/minimax-music3/
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
    "audio_duration": 5,
    "min_audio_duration": 5,
    "num_inference_steps": 30,
    "seed": 7,
    "response_format": "wav",
    "stream": false
  }' \
  --output test-output.wav
```

Music 3 produces 25 audio frames per second. If `audio_duration` is omitted,
the adapter derives it from `max_new_tokens`, so `125` requests five seconds.
The dashboard converts its length field using the same ratio.

## Adapter contract

- The adapter accepts only IPv4 loopback hosts (`127.0.0.0/8`), defaulting to
  `127.0.0.1:18009`; IPv6 and non-loopback host values fail before model load.
- The launchd label is `ai.local.runtime.minimax-music3`.
- The gateway owns admission at `127.0.0.1:8787/v1`; do not send normal client
  traffic directly to port 18009.
- The runtime loads on demand, reports load progress through a small JSON file,
  serializes generation with a process lock, and returns PCM16 WAV audio.
- `HF_HUB_OFFLINE=1` is set for inference so missing components fail instead of
  silently fetching after startup.
