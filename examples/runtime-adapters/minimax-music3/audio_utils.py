from __future__ import annotations

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


def ensure_minimum_samples(audio: np.ndarray, *, minimum_samples: int) -> np.ndarray:
    """Pad a sub-frame vocoder shortfall without altering generated samples."""
    shortfall = int(minimum_samples) - audio.shape[0]
    if shortfall <= 0:
        return audio
    padding = np.zeros((shortfall, audio.shape[1]), dtype=audio.dtype)
    return np.concatenate((audio, padding), axis=0)
