# Managed Music Generation (Experimental)

Local Model Gateway can route music-generation requests through
`POST /v1/audio/speech` when a managed runtime advertises
`supports_audio: true`.

The gateway routes each request to an audio-capable managed runtime. This
experimental endpoint accepts lyrics and style instructions and returns
non-streaming WAV data when the selected runtime supports the contract. Clients
using an OpenAI-compatible library must send the required `input` and
`instructions` fields.

## Request contract

The gateway requires these non-blank fields:

- `model`: a configured managed runtime alias with `supports_audio: true`
- `input`: lyrics or other generation text
- `instructions`: musical style and production direction

The current route accepts WAV output without streaming. Set
`response_format` to `"wav"` (the default) and `stream` to `false` (the
default). Runtime-specific generation controls such as `seed`,
`max_new_tokens`, `audio_duration`, `min_audio_duration`, and
`num_inference_steps` pass through to the managed runtime.

```bash
curl http://127.0.0.1:8787/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "minimax-music3",
    "input": "[Verse]\nA local song begins",
    "instructions": "Dreamy synth-pop with intimate vocals.",
    "max_new_tokens": 125,
    "audio_duration": 5,
    "min_audio_duration": 5,
    "num_inference_steps": 30,
    "seed": 7,
    "response_format": "wav",
    "stream": false
  }' \
  --output song.wav
```

The request enters the same priority queue and runtime load/unload lifecycle as
managed text work. It also appears in request history and dashboard telemetry;
the gateway returns the runtime's WAV response as binary data.

## MiniMax Music 3

The repository includes an experimental Apple Silicon/MPS adapter in
[MiniMax Music 3 Runtime](../examples/runtime-adapters/minimax-music3/README.md).
Model weights are downloaded directly from Hugging Face and are not part of the
gateway release.

Each request is one native Music 3 generation pass. On MPS, the adapter
preallocates the language model's KV cache for the request instead of growing
and reallocating it one token at a time. This keeps composition continuity
without stitching generated sections together.

By default, `audio_duration` is both the minimum and maximum duration: the
adapter suppresses the end-of-audio token until that duration. Set
`min_audio_duration` below `audio_duration` to give the model a window for an
earlier ending, or set it to `0` for the upstream early-ending behavior. If
`audio_duration` is omitted, the adapter derives it from `max_new_tokens` using
Music 3's 25 audio frames-per-second ratio.

The adapter validates its IPv4 loopback bind before importing GPU/model
dependencies, then validates numeric generation parameters before each
generation. It returns PCM16 WAV audio and loads model components from the
local snapshot with offline Hub access during inference.

## Setup and cancellation

Follow the [MiniMax adapter setup](../examples/runtime-adapters/minimax-music3/README.md)
to install the Python environment, download the model, copy the adapter files,
and add a managed runtime with `supports_audio: true`. Run the read-only
preflight before starting the gateway:

```bash
npx local-model-gateway doctor --json
```

If the top-level status is `fail`, follow the generated plan from
`npx local-model-gateway doctor --fix-plan` before changing services or runtime
configuration.

When a client disconnects, the gateway closes the request and records the
cancellation. The current MiniMax adapter performs generation synchronously and
may finish its current native pass before handling another request, so
cancellation does not guarantee an immediate interruption of GPU computation.
