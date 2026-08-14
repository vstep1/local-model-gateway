import unittest

import torch

from duration_control import suppress_early_audio_end


class _FakeHead:
    def forward(self):
        return torch.zeros((2, 5), dtype=torch.float32)


class SuppressEarlyAudioEndTest(unittest.TestCase):
    def test_masks_end_token_until_minimum_frames_then_restores_forward(self):
        head = _FakeHead()
        self.assertNotIn("forward", head.__dict__)

        with suppress_early_audio_end(head, minimum_frames=2, end_token_id=4):
            first = head.forward()
            second = head.forward()
            third = head.forward()
            fourth = head.forward()

        self.assertTrue(torch.isneginf(first[..., 4]).all())
        self.assertTrue(torch.isneginf(second[..., 4]).all())
        self.assertTrue(torch.isneginf(third[..., 4]).all())
        self.assertEqual(fourth[..., 4].tolist(), [0.0, 0.0])
        self.assertNotIn("forward", head.__dict__)


if __name__ == "__main__":
    unittest.main()
