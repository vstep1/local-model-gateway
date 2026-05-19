import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientRecipe } from '../src/tools/index.js';

describe('gateway setup tools', () => {
  it('generates client configs from the active gateway endpoint', () => {
    const endpoint = { host: '127.0.0.1', port: 18787 };

    assert.equal(
      clientRecipe('generic-openai', endpoint).openai_base_url,
      'http://127.0.0.1:18787/v1',
    );
    assert.equal(
      clientRecipe('generic-mcp', endpoint).mcp_url,
      'http://127.0.0.1:18787/mcp',
    );

    const hermes = clientRecipe('hermes', endpoint);
    assert.equal(
      (hermes.provider as Record<string, unknown>).base_url,
      'http://127.0.0.1:18787/v1',
    );
    assert.equal(
      ((hermes.mcp_servers as Record<string, Record<string, unknown>>)['local-model-gateway']).url,
      'http://127.0.0.1:18787/mcp',
    );
  });
});
