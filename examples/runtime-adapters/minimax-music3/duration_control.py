from contextlib import contextmanager


@contextmanager
def suppress_early_audio_end(head, *, minimum_frames, end_token_id):
    """Prevent Music3 from sampling its end token before a minimum duration."""
    had_instance_forward = "forward" in head.__dict__
    previous_instance_forward = head.__dict__.get("forward")
    original_forward = head.forward
    decode_step = 0

    def forward_with_minimum_duration(*args, **kwargs):
        nonlocal decode_step
        logits = original_forward(*args, **kwargs)
        if decode_step <= int(minimum_frames):
            logits[..., int(end_token_id)] = -float("inf")
        decode_step += 1
        return logits

    head.forward = forward_with_minimum_duration
    try:
        yield
    finally:
        if had_instance_forward:
            head.forward = previous_instance_forward
        else:
            del head.forward
