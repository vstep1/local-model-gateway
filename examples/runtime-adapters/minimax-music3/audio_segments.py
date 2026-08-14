from __future__ import annotations

from collections.abc import Callable

import numpy as np


def to_samples_channels(audio: np.ndarray) -> np.ndarray:
    """Normalize Diffusers audio output to a float32 [samples, channels] array."""
    normalized = np.asarray(audio)
    if normalized.ndim == 3 and normalized.shape[0] == 1:
        normalized = normalized[0]
    if normalized.ndim != 2:
        raise ValueError(f"expected a 2D audio array, got shape {normalized.shape}")
    if normalized.shape[0] <= 8 and normalized.shape[1] > normalized.shape[0]:
        normalized = normalized.T
    return normalized.astype(np.float32, copy=False)


def generate_segmented_audio(
    generate_segment: Callable[[int], np.ndarray],
    *,
    target_samples: int,
    crossfade_samples: int,
    max_segments: int,
) -> np.ndarray:
    """Generate and join audio sections until the requested sample count is available."""
    assembled: np.ndarray | None = None

    for segment_index in range(max_segments):
        segment = generate_segment(segment_index)
        if segment.ndim != 2 or segment.shape[0] == 0:
            raise ValueError("generated audio segments must be non-empty [samples, channels] arrays")

        if assembled is None:
            assembled = segment
        else:
            overlap = min(
                crossfade_samples,
                assembled.shape[0] // 2,
                segment.shape[0] // 2,
            )
            if overlap > 0:
                weights = (np.arange(overlap, dtype=np.float32) + 1.0) / (overlap + 1.0)
                weights = weights[:, None]
                transition = assembled[-overlap:] * (1.0 - weights) + segment[:overlap] * weights
                assembled = np.concatenate((assembled[:-overlap], transition, segment[overlap:]), axis=0)
            else:
                assembled = np.concatenate((assembled, segment), axis=0)

        if assembled.shape[0] >= target_samples:
            return assembled[:target_samples]

    generated_samples = 0 if assembled is None else assembled.shape[0]
    raise RuntimeError(
        f"segmented generation produced {generated_samples} samples, fewer than target {target_samples}"
    )
