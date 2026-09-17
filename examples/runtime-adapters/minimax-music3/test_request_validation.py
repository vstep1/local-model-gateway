import builtins
import os
import runpy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from request_validation import parse_generation_parameters, validate_loopback_host


ADAPTER_DIR = Path(__file__).resolve().parent
SERVER_PATH = ADAPTER_DIR / "server.py"


class HostValidationTest(unittest.TestCase):
    def test_accepts_ipv4_loopback_and_rejects_other_address_families(self):
        self.assertEqual(validate_loopback_host("127.0.0.1"), "127.0.0.1")
        self.assertEqual(validate_loopback_host(" 127.0.0.2 "), "127.0.0.2")
        for host in ("0.0.0.0", "192.0.2.10", "::1", "localhost"):
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, "IPv4 loopback"):
                validate_loopback_host(host)

    def test_invalid_host_fails_before_heavy_imports_or_model_access(self):
        original_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name.split(".", 1)[0] in {"diffusers", "soundfile", "torch"}:
                raise AssertionError(f"heavy import reached for invalid host: {name}")
            return original_import(name, *args, **kwargs)

        with patch.dict(
            os.environ,
            {"MINIMAX_MUSIC3_HOST": "192.0.2.10"},
            clear=True,
        ), patch.object(builtins, "__import__", guarded_import):
            with self.assertRaisesRegex(ValueError, "IPv4 loopback"):
                runpy.run_path(str(SERVER_PATH), run_name="__main__")


class GenerationParameterValidationTest(unittest.TestCase):
    def test_rejects_nonfinite_duration_values(self):
        for field in ("audio_duration", "min_audio_duration"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "finite"):
                parse_generation_parameters({field: float("nan")})
            with self.subTest(field=f"{field}-infinity"), self.assertRaisesRegex(
                ValueError, "finite"
            ):
                parse_generation_parameters({field: float("inf")})

    def test_rejects_negative_inference_steps_before_generation(self):
        for steps in (-1, -0.5):
            with self.subTest(steps=steps), self.assertRaisesRegex(
                ValueError, "integer"
            ):
                parse_generation_parameters({"num_inference_steps": steps})

    def test_requires_at_least_one_inference_step_but_accepts_zero_seed(self):
        with self.assertRaisesRegex(ValueError, "positive integer"):
            parse_generation_parameters({"num_inference_steps": 0})
        parameters = parse_generation_parameters({"seed": 0})
        self.assertEqual(parameters.seed, 0)

    def test_rejects_boolean_numeric_values(self):
        for field in ("max_new_tokens", "num_inference_steps", "seed"):
            with self.subTest(field=field), self.assertRaisesRegex(
                ValueError, "integer"
            ):
                parse_generation_parameters({field: True})

    def test_rejects_seed_values_outside_torch_generator_range(self):
        for seed in (-(1 << 63) - 1, 1 << 64):
            with self.subTest(seed=seed), self.assertRaisesRegex(
                ValueError, "64-bit"
            ):
                parse_generation_parameters({"seed": seed})

    def test_normalizes_integer_overflow_before_generation(self):
        for field in ("max_new_tokens", "seed"):
            with self.subTest(field=field), self.assertRaisesRegex(
                ValueError, "integer"
            ):
                parse_generation_parameters({field: float("inf")})

        with self.assertRaisesRegex(ValueError, "finite"):
            parse_generation_parameters({"audio_duration": 10**1000})
        with self.assertRaisesRegex(ValueError, "finite default duration"):
            parse_generation_parameters({"max_new_tokens": 10**1000})

    def test_preserves_existing_duration_clamping(self):
        parameters = parse_generation_parameters(
            {"audio_duration": 0.0, "min_audio_duration": -1.0}
        )
        self.assertEqual(parameters.audio_duration, 0.04)
        self.assertEqual(parameters.min_audio_duration, 0.0)


if __name__ == "__main__":
    sys.path.insert(0, str(ADAPTER_DIR))
    unittest.main()
