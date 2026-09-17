import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { installLaunchdService, validateGatewayRuntime } from '../src/service.js';

describe('launchd service installer', () => {
  it('preflights the exact gateway entrypoint with the installer Node runtime', () => {
    assert.doesNotThrow(() => {
      validateGatewayRuntime(
        process.execPath,
        fileURLToPath(import.meta.resolve('@local-model-gateway/gateway')),
        process.cwd(),
      );
    });
  });

  it('does not replace launchd state when the replacement runtime fails preflight', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-gateway-service-'));
    const homeDir = path.join(root, 'home');
    const gatewayDir = path.join(root, 'gateway');
    const coreDir = path.join(gatewayDir, 'node_modules', '@local-model-gateway', 'core');
    const existingPlistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'ai.local.gateway.plist');
    const existingPlist = Buffer.from('healthy gateway plist\n', 'utf8');
    await fs.writeFile(path.join(root, 'local-model-gateway.config.yaml'), 'server:\n  port: 18787\n', 'utf8');
    await fs.mkdir(coreDir, { recursive: true });
    await fs.writeFile(
      path.join(gatewayDir, 'replacement.js'),
      'export {};\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(coreDir, 'package.json'),
      JSON.stringify({ main: 'index.js', type: 'module' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(coreDir, 'index.js'),
      [
        "export class GatewayStore { constructor() { throw new Error('better-sqlite3 ABI mismatch'); } }",
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.mkdir(path.dirname(existingPlistPath), { recursive: true });
    await fs.writeFile(existingPlistPath, existingPlist);
    const launchctlCalls: string[][] = [];

    try {
      await assert.rejects(
        installLaunchdService(root, true, {
          gatewayEntrypoint: path.join(gatewayDir, 'replacement.js'),
          homeDir,
          platform: 'darwin',
          runLaunchctl: (args) => launchctlCalls.push(args),
        }),
        /better-sqlite3 ABI mismatch/,
      );
      assert.deepEqual(launchctlCalls, []);
      assert.deepEqual(await fs.readFile(existingPlistPath), existingPlist);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
