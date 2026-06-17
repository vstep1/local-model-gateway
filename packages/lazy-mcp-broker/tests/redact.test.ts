import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactObject, redactText, safeError } from '../src/redact.js';

describe('broker redaction', () => {
  const redacted = '[REDACTED]';

  it('redacts bearer tokens in text and error messages', () => {
    const bearer = `Bearer ${'secret-token'}`;
    assert.equal(redactText(`Authorization: ${bearer}`), 'Authorization: Bearer [REDACTED]');
    assert.equal(safeError(new Error(`failed with ${bearer}`)), 'failed with Bearer [REDACTED]');
    assert.equal(safeError('plain failure'), 'plain failure');
  });

  it('redacts secret-looking object keys recursively', () => {
    assert.deepEqual(
      redactObject({
        api_key: 'abc',
        nested: {
          Authorization: 'Bearer abc',
          ok: true,
        },
        list: [{ clientSecret: 'hidden' }, 'visible'],
      }),
      {
        api_key: redacted,
        nested: {
          Authorization: redacted,
          ok: true,
        },
        list: [{ clientSecret: redacted }, 'visible'],
      },
    );
  });
});
