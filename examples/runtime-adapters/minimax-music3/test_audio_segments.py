import unittest

import numpy as np

from audio_segments import generate_segmented_audio, to_samples_channels


class GenerateSegmentedAudioTest(unittest.TestCase):
    def test_normalizes_channels_first_audio(self):
        channels_first = np.arange(12, dtype=np.float32).reshape(2, 6)

        normalized = to_samples_channels(channels_first)

        self.assertEqual(normalized.shape, (6, 2))
        np.testing.assert_array_equal(normalized[:, 0], channels_first[0])

    def test_reaches_target_and_crossfades_segments(self):
        segments = [
            np.full((6, 2), 1.0, dtype=np.float32),
            np.full((6, 2), 3.0, dtype=np.float32),
            np.full((6, 2), 5.0, dtype=np.float32),
        ]
        calls = []

        def generate(segment_index):
            calls.append(segment_index)
            return segments[segment_index]

        audio = generate_segmented_audio(
            generate,
            target_samples=14,
            crossfade_samples=1,
            max_segments=3,
        )

        self.assertEqual(audio.shape, (14, 2))
        self.assertEqual(calls, [0, 1, 2])
        np.testing.assert_allclose(audio[5], np.array([2.0, 2.0], dtype=np.float32))
        np.testing.assert_allclose(audio[10], np.array([4.0, 4.0], dtype=np.float32))


if __name__ == "__main__":
    unittest.main()
