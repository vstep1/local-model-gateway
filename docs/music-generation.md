# Music Generation

Local Model Gateway supports managed music generation through
`POST /v1/audio/speech`.

The gateway does not turn a text model into a music model. A managed runtime
must implement the same endpoint and declare `supports_audio: true`. Eligible
runtimes appear in status and discovery metadata as `supports_audio: true`.

## Request shape

The gateway validates and forwards these required fields:

- `model`: a managed runtime alias with audio support
- `input`: lyrics, including optional section tags
- `instructions`: musical style and production direction

It currently accepts WAV, non-streaming output. Runtime-specific generation
controls such as `seed`, `max_new_tokens`, `audio_duration`,
`min_audio_duration`, and `num_inference_steps` pass through unchanged.

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

Requests use the same priority queue, runtime load/unload lifecycle, client
cancellation signal, history, and dashboard telemetry as managed text runtime
requests. The WAV response is returned as binary data rather than JSON.

## MiniMax Music 3

The repository includes an experimental macOS adapter and reproducible setup
instructions in
[MiniMax Music 3 Runtime](../examples/runtime-adapters/minimax-music3/README.md).
Model weights are downloaded directly from Hugging Face and are not part of the
gateway release.
