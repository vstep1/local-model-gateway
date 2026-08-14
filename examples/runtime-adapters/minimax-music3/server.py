#!/usr/bin/env python3
"""Loopback-only OpenAI speech endpoint for MiniMax Music 3."""

from __future__ import annotations

import io
import json
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import soundfile as sf
import torch
from diffusers import ModularPipeline


HOST = os.environ.get("MINIMAX_MUSIC3_HOST", "127.0.0.1")
PORT = int(os.environ.get("MINIMAX_MUSIC3_PORT", "18009"))
MODEL_PATH = Path(os.environ["MINIMAX_MUSIC3_MODEL_PATH"]).expanduser().resolve()
MODEL_ID = "MiniMaxAI/MiniMax-Music3"
MODEL_ALIAS = "minimax-music3"
PROGRESS_PATH = Path(
    os.environ.get("MINIMAX_MUSIC3_PROGRESS_PATH", MODEL_PATH.parent / "load-progress.json")
).expanduser().resolve()


def write_progress(phase: str, progress: float | None, error: str | None = None) -> None:
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {"load_phase": phase, "load_progress": progress}
    if error:
        payload["error"] = error
    temporary = PROGRESS_PATH.with_suffix(PROGRESS_PATH.suffix + ".tmp")
    temporary.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    temporary.replace(PROGRESS_PATH)


def select_device() -> torch.device:
    requested = os.environ.get("MINIMAX_MUSIC3_DEVICE", "auto").lower()
    if requested != "auto":
        return torch.device(requested)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    raise RuntimeError("MiniMax Music 3 requires an MPS or CUDA GPU")


def select_dtype() -> torch.dtype:
    requested = os.environ.get("MINIMAX_MUSIC3_DTYPE", "bfloat16").lower()
    if requested == "float16":
        return torch.float16
    if requested == "float32":
        return torch.float32
    if requested == "bfloat16":
        return torch.bfloat16
    raise ValueError(f"Unsupported MINIMAX_MUSIC3_DTYPE: {requested}")


write_progress("initializing", 0.05)
DEVICE = select_device()
DTYPE = select_dtype()

try:
    write_progress("loading_pipeline", 0.15)
    PIPE = ModularPipeline.from_pretrained(str(MODEL_PATH), local_files_only=True)
    # Modular component specs retain the Hub repo ID even when the index came
    # from disk. Redirect every component to the verified local snapshot.
    for component_spec in PIPE._component_specs.values():
        if component_spec.pretrained_model_name_or_path:
            component_spec.pretrained_model_name_or_path = str(MODEL_PATH)
    write_progress("loading_components", 0.35)
    PIPE.load_components(dtype=DTYPE)
    required_components = (
        "condition_encoder",
        "language_model",
        "rvq_depth_decoder",
        "scheduler",
        "tokenizer",
        "transformer",
        "vocoder",
    )
    missing = [name for name in required_components if getattr(PIPE, name, None) is None]
    if missing:
        raise RuntimeError(f"Failed to load components: {', '.join(missing)}")
    write_progress("moving_to_device", 0.75)
    PIPE.to(DEVICE)
    SAMPLING_RATE = int(PIPE.sampling_rate)
    write_progress("ready", 1.0)
except Exception as exc:
    write_progress("failed", None, str(exc))
    raise


GENERATION_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "MiniMaxMusic3Local/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == "/v1/models":
            self.send_json(
                HTTPStatus.OK,
                {
                    "object": "list",
                    "data": [
                        {"id": MODEL_ID, "object": "model", "owned_by": "MiniMaxAI"},
                        {"id": MODEL_ALIAS, "object": "model", "owned_by": "local"},
                    ],
                },
            )
            return
        if self.path == "/health":
            self.send_json(HTTPStatus.OK, {"status": "ok", "device": str(DEVICE)})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "Not found"}})

    def do_POST(self) -> None:
        if self.path != "/v1/audio/speech":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "Not found"}})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            lyrics = str(request["input"]).strip()
            prompt = str(request["instructions"]).strip()
            if not lyrics or not prompt:
                raise ValueError("input and instructions must be non-empty")
            if request.get("stream", False):
                raise ValueError("streaming generation is not supported")
            if request.get("response_format", "wav") != "wav":
                raise ValueError("only response_format=wav is supported")

            frames = int(request.get("max_new_tokens", 250))
            duration = float(request.get("audio_duration", frames / 25.0))
            duration = min(max(duration, 0.04), 360.0)
            steps = int(request.get("num_inference_steps", 30))
            seed = int(request.get("seed", 0))
            generator = torch.Generator("cpu").manual_seed(seed)

            with GENERATION_LOCK:
                audio = PIPE(
                    prompt=prompt,
                    lyrics=lyrics,
                    audio_duration=duration,
                    generator=generator,
                    num_inference_steps=steps,
                    output="audios",
                    output_type="pt",
                )[0]

            samples = audio.squeeze(0).T.float().cpu().numpy()
            output = io.BytesIO()
            sf.write(output, samples, SAMPLING_RATE, format="WAV", subtype="PCM_16")
            encoded = output.getvalue()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": str(exc)}})
        except Exception as exc:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": {"message": str(exc)}})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
