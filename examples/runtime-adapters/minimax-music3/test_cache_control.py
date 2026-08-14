import unittest

from cache_control import preallocated_kv_cache


class _Embeddings:
    shape = (2, 7, 4096)


class _FakeModel:
    def __init__(self):
        self.config = object()

    def forward(self, **kwargs):
        return kwargs


class PreallocatedKvCacheTest(unittest.TestCase):
    def test_injects_a_prompt_aware_static_cache_and_restores_forward(self):
        model = _FakeModel()
        created = []

        def cache_factory(*, config, max_cache_len):
            cache = object()
            created.append((config, max_cache_len, cache))
            return cache

        self.assertNotIn("forward", model.__dict__)

        with preallocated_kv_cache(
            model,
            max_new_tokens=25,
            cache_factory=cache_factory,
        ):
            result = model.forward(inputs_embeds=_Embeddings(), use_cache=True)

        self.assertEqual(created[0][0], model.config)
        self.assertEqual(created[0][1], 33)
        self.assertIs(result["past_key_values"], created[0][2])
        self.assertNotIn("forward", model.__dict__)


if __name__ == "__main__":
    unittest.main()
