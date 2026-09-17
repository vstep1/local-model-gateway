"""Validation for the lightweight, request-facing MiniMax adapter boundary."""

from __future__ import annotations

import ipaddress
import math
from dataclasses import dataclass
from typing import Any, Mapping


def validate_loopback_host(host: str) -> str:
    """Accept only IPv4 loopback addresses supported by HTTPServer."""
    normalized = host.strip()
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError as exc:
        raise ValueError(
            "MINIMAX_MUSIC3_HOST must be an IPv4 loopback address"
        ) from exc
    if address.version != 4 or not address.is_loopback:
        raise ValueError("MINIMAX_MUSIC3_HOST must be an IPv4 loopback address")
    return normalized


def _finite_float(value: Any, field_name: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{field_name} must be a finite number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{field_name} must be a finite number")
    return result


def _integer(value: Any, field_name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be an integer")
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{field_name} must be an integer") from exc
    if isinstance(value, float) and (
        not math.isfinite(value) or not value.is_integer()
    ):
        raise ValueError(f"{field_name} must be an integer")
    return result


def _nonnegative_int(value: Any, field_name: str) -> int:
    result = _integer(value, field_name)
    if result < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return result


def _seed(value: Any) -> int:
    result = _integer(value, "seed")
    # torch.Generator.manual_seed accepts signed 64-bit values and wraps them
    # into its unsigned 64-bit generator state. Reject values outside that
    # range here so malformed requests become a 400 instead of a generation
    # failure after the model lock has been acquired.
    if result < -(1 << 63) or result > (1 << 64) - 1:
        raise ValueError("seed must fit in a signed or unsigned 64-bit integer")
    return result


@dataclass(frozen=True)
class GenerationParameters:
    """Parsed request values used by one native Music3 generation pass."""

    max_new_tokens: int
    audio_duration: float
    min_audio_duration: float
    num_inference_steps: int
    seed: int


def parse_generation_parameters(request: Mapping[str, Any]) -> GenerationParameters:
    """Parse request numbers while retaining the adapter's duration semantics."""
    max_new_tokens = _nonnegative_int(
        request.get("max_new_tokens", 250),
        "max_new_tokens",
    )
    if "audio_duration" in request:
        requested_duration = request["audio_duration"]
    else:
        try:
            requested_duration = max_new_tokens / 25.0
        except OverflowError as exc:
            raise ValueError(
                "max_new_tokens must produce a finite default duration"
            ) from exc
    duration = _finite_float(
        requested_duration,
        "audio_duration",
    )
    duration = min(max(duration, 0.04), 360.0)
    minimum_duration = _finite_float(
        request.get("min_audio_duration", duration),
        "min_audio_duration",
    )
    minimum_duration = min(max(minimum_duration, 0.0), duration)
    steps = _integer(
        request.get("num_inference_steps", 30),
        "num_inference_steps",
    )
    if steps <= 0:
        raise ValueError("num_inference_steps must be a positive integer")
    return GenerationParameters(
        max_new_tokens=max_new_tokens,
        audio_duration=duration,
        min_audio_duration=minimum_duration,
        num_inference_steps=steps,
        seed=_seed(request.get("seed", 0)),
    )
