from contextlib import contextmanager


@contextmanager
def preallocated_kv_cache(model, *, max_new_tokens, cache_factory=None):
    """Inject one prompt-aware static cache into the first cached model call."""
    if cache_factory is None:
        from transformers import StaticCache

        cache_factory = StaticCache

    had_instance_forward = "forward" in model.__dict__
    previous_instance_forward = model.__dict__.get("forward")
    original_forward = model.forward
    cache = None

    def forward_with_static_cache(*args, **kwargs):
        nonlocal cache
        if kwargs.get("use_cache") and kwargs.get("past_key_values") is None:
            inputs_embeds = kwargs.get("inputs_embeds")
            if inputs_embeds is None:
                raise ValueError("Static cache setup requires inputs_embeds")
            if cache is None:
                prompt_tokens = int(inputs_embeds.shape[1])
                cache = cache_factory(
                    config=model.config,
                    max_cache_len=prompt_tokens + int(max_new_tokens) + 1,
                )
            kwargs["past_key_values"] = cache
        return original_forward(*args, **kwargs)

    model.forward = forward_with_static_cache
    try:
        yield
    finally:
        if had_instance_forward:
            model.forward = previous_instance_forward
        else:
            del model.forward
