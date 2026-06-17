import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { compilePromptFromMessages, parseResponsesInputToMessages } from '../src/prompt.js';
import { copyFileAtomic, ensureDir, fileSha256, safeJsonParse } from '../src/utils.js';

describe('prompt helpers', () => {
  it('normalizes OpenAI chat message content into prompt blocks', () => {
    assert.equal(
      compilePromptFromMessages([
        { role: 'system', content: { text: 'Be direct.' } },
        {
          role: 'user',
          content: [
            'First line',
            { type: 'text', text: 'Second line' },
            { type: 'image_url', image_url: { url: 'ignored' } },
          ],
        },
        { role: 'assistant', content: null },
      ]),
      'SYSTEM:\nBe direct.\n\nUSER:\nFirst line\nSecond line\n\nASSISTANT:',
    );
  });

  it('parses Responses API input forms into chat messages', () => {
    assert.deepEqual(parseResponsesInputToMessages('hello'), [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(parseResponsesInputToMessages(null), [{ role: 'user', content: '' }]);
    assert.deepEqual(parseResponsesInputToMessages(['skip', null]), [{ role: 'user', content: '' }]);
    assert.deepEqual(
      parseResponsesInputToMessages([
        { role: 'assistant', content: 'prior answer' },
        { role: 'invalid', content: 'fallback user' },
        { role: 'tool', content: [{ type: 'text', text: 'tool text' }] },
      ]),
      [
        { role: 'assistant', content: 'prior answer' },
        { role: 'user', content: 'fallback user' },
        { role: 'tool', content: [{ type: 'text', text: 'tool text' }] },
      ],
    );
  });
});

describe('utility helpers', () => {
  it('parses JSON with a fallback', () => {
    assert.deepEqual(safeJsonParse('{"ok":true}', {}), { ok: true });
    assert.deepEqual(safeJsonParse('not json', { ok: false }), { ok: false });
  });

  it('creates directories, hashes files, and copies atomically', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-gateway-utils-'));
    try {
      const source = path.join(root, 'source.txt');
      const target = path.join(root, 'nested/target.txt');
      await ensureDir(path.dirname(source));
      await fs.writeFile(source, 'hello', 'utf8');

      assert.equal(
        await fileSha256(source),
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );

      await copyFileAtomic(source, target);
      assert.equal(await fs.readFile(target, 'utf8'), 'hello');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
