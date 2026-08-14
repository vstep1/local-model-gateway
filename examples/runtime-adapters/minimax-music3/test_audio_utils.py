import unittest

import numpy as np

from audio_utils import ensure_minimum_samples, to_samples_channels


class AudioUtilsTest(unittest.TestCase):
    def test_normalizes_channels_first_audio(self):
        channels_first = np.arange(12, dtype=np.float32).reshape(2, 6)

        normalized = to_samples_channels(channels_first)

        self.assertEqual(normalized.shape, (6, 2))
        np.testing.assert_array_equal(normalized[:, 0], channels_first[0])

    def test_pads_vocoder_rounding_shortfall_to_minimum_sample_count(self):
        audio = np.ones((4, 2), dtype=np.float32)

        padded = ensure_minimum_samples(audio, minimum_samples=6)

        self.assertEqual(padded.shape, (6, 2))
        np.testing.assert_array_equal(padded[:4], audio)
        np.testing.assert_array_equal(padded[4:], np.zeros((2, 2), dtype=np.float32))


if __name__ == "__main__":
    unittest.main()
