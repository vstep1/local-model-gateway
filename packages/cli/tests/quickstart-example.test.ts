import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { resolveGatewayConfig } from '@local-model-gateway/core';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('missing test port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

describe('quickstart example', () => {
  it('ships a managed runtime config that resolves from the repo root', () => {
    const configPath = path.join(repoRoot, 'examples/quickstart/local-model-gateway.config.yaml');
    const config = resolveGatewayConfig({ configPath, rootDir: repoRoot });
    const runtime = config.managedRuntimes.find((item) => item.alias === 'quickstart-mock');

    assert.equal(config.defaultModel, 'quickstart-mock');
    assert.ok(runtime);
    assert.equal(runtime?.baseUrl, 'http://127.0.0.1:18080/v1');
    assert.equal(runtime?.healthUrl, 'http://127.0.0.1:18080/v1/models');
    assert.equal(runtime?.serviceScript, path.join(repoRoot, 'examples/quickstart/mock-runtime-service.mjs'));
  });

  it('starts, answers, and stops the no-GPU mock runtime service', async () => {
    const scriptPath = path.join(repoRoot, 'examples/quickstart/mock-runtime-service.mjs');
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-gateway-quickstart-'));
    const port = await freePort();
    const env = {
      ...process.env,
      LOCAL_MODEL_GATEWAY_QUICKSTART_RUNTIME_PORT: String(port),
      LOCAL_MODEL_GATEWAY_QUICKSTART_STATE_DIR: stateDir,
    };

    try {
      await execFileAsync(process.execPath, [scriptPath, 'start'], { env, timeout: 15000 });
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        body: JSON.stringify({
          model: 'quickstart-mock',
          messages: [{ role: 'user', content: 'hello' }],
          stream: false,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(response.status, 200);
      const body = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      assert.match(body.choices[0].message.content, /gateway reached a managed runtime/);
    } finally {
      await execFileAsync(process.execPath, [scriptPath, 'stop'], { env, timeout: 15000 })
        .catch(() => undefined);
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
