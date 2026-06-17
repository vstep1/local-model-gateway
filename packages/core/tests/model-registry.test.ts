import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GatewayStore } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';
import type { GatewayConfig } from '../src/types.js';

async function createRegistryHarness(): Promise<{
  cleanup: () => Promise<void>;
  config: GatewayConfig;
  registry: ModelRegistry;
  root: string;
  store: GatewayStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-registry-test-'));
  const config: GatewayConfig = {
    authToken: '',
    baseModelPath: path.join(root, 'base.gguf'),
    configPath: null,
    ctxSize: 4096,
    dataDir: path.join(root, 'data'),
    dbPath: path.join(root, 'data', 'gateway.sqlite'),
    defaultModel: 'ep2',
    gpuLayers: 'all',
    historyTtlDays: 7,
    host: '127.0.0.1',
    llamaCliPath: '/usr/bin/env',
    allowUnmanagedLocalUpstreams: false,
    maxQueue: 100,
    maxQueueWaitMs: 1000,
    maxTokens: 128,
    modelSourceDir: path.join(root, 'source'),
    modelsDir: path.join(root, 'models'),
    port: 8787,
    repeatPenalty: 1,
    schedulerPollMs: 5,
    startupModels: {},
    temperature: 0.8,
    timeoutMs: 10_000,
    topP: 0.95,
    waitPollMs: 5,
    openAiUpstreams: [],
    managedRuntimes: [],
  };
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(config.modelSourceDir, { recursive: true });
  await fs.mkdir(config.modelsDir, { recursive: true });

  const store = new GatewayStore(config.dbPath);
  store.initSchema();
  const registry = new ModelRegistry(store, config);

  return {
    cleanup: async () => {
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
    config,
    registry,
    root,
    store,
  };
}

describe('model registry', () => {
  it('imports models into managed storage and removes their managed folder', async () => {
    const harness = await createRegistryHarness();
    try {
      const sourcePath = path.join(harness.config.modelSourceDir, 'ep2.gguf');
      await fs.writeFile(sourcePath, 'adapter contents', 'utf8');

      const imported = await harness.registry.importModel('ep2', sourcePath);

      assert.equal(imported.alias, 'ep2');
      assert.equal(imported.enabled, true);
      assert.notEqual(imported.managedPath, sourcePath);
      assert.equal(await fs.readFile(imported.managedPath, 'utf8'), 'adapter contents');
      assert.deepEqual(harness.registry.listModels(true).map((model) => model.alias), ['ep2']);

      assert.equal(await harness.registry.removeModel('ep2'), true);
      await assert.rejects(fs.stat(path.dirname(imported.managedPath)), { code: 'ENOENT' });
      assert.equal(await harness.registry.removeModel('ep2'), false);
    } finally {
      await harness.cleanup();
    }
  });

  it('reports startup sync imports, skips, updates, and missing sources', async () => {
    const harness = await createRegistryHarness();
    try {
      const sourcePath = path.join(harness.config.modelSourceDir, 'startup.gguf');
      const missingPath = path.join(harness.config.modelSourceDir, 'missing.gguf');
      await fs.writeFile(sourcePath, 'v1', 'utf8');
      harness.config.startupModels = { startup: sourcePath, missing: missingPath };

      assert.deepEqual(await harness.registry.syncStartup(), {
        imported: ['startup'],
        updated: [],
        skipped: [],
        missingSources: [`missing:${missingPath}`],
      });

      assert.deepEqual(await harness.registry.syncFromSourceMap({ startup: sourcePath }), {
        imported: [],
        updated: [],
        skipped: ['startup'],
        missingSources: [],
      });

      await fs.writeFile(sourcePath, 'v2', 'utf8');
      assert.deepEqual(await harness.registry.syncFromSourceMap({ startup: sourcePath }), {
        imported: [],
        updated: ['startup'],
        skipped: [],
        missingSources: [],
      });
    } finally {
      await harness.cleanup();
    }
  });

  it('validates aliases and source paths on direct import', async () => {
    const harness = await createRegistryHarness();
    try {
      await assert.rejects(
        harness.registry.importModel('   ', path.join(harness.config.modelSourceDir, 'ep2.gguf')),
        /alias is required/,
      );
      await assert.rejects(
        harness.registry.importModel('ep2', path.join(harness.config.modelSourceDir, 'missing.gguf')),
        /Model source not found/,
      );
    } finally {
      await harness.cleanup();
    }
  });
});
