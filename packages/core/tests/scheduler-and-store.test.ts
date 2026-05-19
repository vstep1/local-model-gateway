import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initialConfigEntries } from '../src/config.js';
import { GatewayStore } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';
import { Scheduler } from '../src/scheduler.js';
import { ensureDir, fileSha256 } from '../src/utils.js';
import { ActiveRuntimeSettings, GatewayConfig, GenerationBackend, GenerationRequest } from '../src/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
  pollMs = 10,
  message = 'condition not met',
): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(message);
    }
    await sleep(pollMs);
  }
}

class ControlledBackend implements GenerationBackend {
  readonly calls: string[] = [];
  maxActive = 0;
  private active = 0;
  private readonly blocks = new Map<string, Promise<void>>();
  private readonly delays = new Map<string, number>();
  private readonly resolvers = new Map<string, () => void>();

  blockPrompt(prompt: string): () => void {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.blocks.set(prompt, promise);
    this.resolvers.set(prompt, resolve);
    return () => resolve();
  }

  setDelay(prompt: string, ms: number): void {
    this.delays.set(prompt, ms);
  }

  async generate(request: GenerationRequest) {
    this.calls.push(request.prompt);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    try {
      const blocker = this.blocks.get(request.prompt);
      if (blocker) {
        await blocker;
      }

      const delayMs = this.delays.get(request.prompt);
      if (delayMs) {
        await sleep(delayMs);
      }

      return {
        durationMs: delayMs ?? 0,
        outputText: `ok:${request.prompt}`,
        rawTail: `tail:${request.prompt}`,
      };
    } finally {
      this.active -= 1;
    }
  }
}

async function createHarness(maxQueue = 100): Promise<{
  adapterPath: string;
  backend: ControlledBackend;
  cleanup: () => Promise<void>;
  config: GatewayConfig;
  registry: ModelRegistry;
  scheduler: Scheduler;
  settings: ActiveRuntimeSettings;
  store: GatewayStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-gateway-'));
  const dataDir = path.join(root, 'data');
  const modelsDir = path.join(root, 'models');
  const sourceDir = path.join(root, 'source');
  const adapterPath = path.join(sourceDir, 'ep2.gguf');

  await ensureDir(dataDir);
  await ensureDir(modelsDir);
  await ensureDir(sourceDir);
  await fs.writeFile(adapterPath, 'adapter-ep2-v1', 'utf8');

  const config: GatewayConfig = {
    authToken: '',
    baseModelPath: '/tmp/base.gguf',
    configPath: null,
    ctxSize: 4096,
    dataDir,
    dbPath: path.join(dataDir, 'gateway.sqlite'),
    defaultModel: 'ep2',
    gpuLayers: 'all',
    historyTtlDays: 7,
    host: '127.0.0.1',
    llamaCliPath: '/usr/bin/env',
    allowUnmanagedLocalUpstreams: false,
    maxQueue,
    maxQueueWaitMs: 1000,
    maxTokens: 128,
    modelSourceDir: sourceDir,
    modelsDir,
    port: 8787,
    repeatPenalty: 1.0,
    schedulerPollMs: 5,
    startupModels: {},
    temperature: 0.8,
    timeoutMs: 10_000,
    topP: 0.95,
    waitPollMs: 5,
    openAiUpstreams: [],
    managedRuntimes: [],
  };

  const store = new GatewayStore(config.dbPath);
  store.initSchema();
  store.seedConfig(initialConfigEntries(config));

  const checksum = await fileSha256(adapterPath);
  store.upsertModel({
    adapterPath,
    alias: 'ep2',
    checksumSha256: checksum,
    enabled: true,
    managedPath: adapterPath,
    sourcePath: adapterPath,
  });

  const settings = store.getRuntimeSettings();
  const registry = new ModelRegistry(store, config);
  const backend = new ControlledBackend();
  const scheduler = new Scheduler(
    store,
    registry,
    backend,
    settings,
    config.schedulerPollMs,
    config.waitPollMs,
  );

  const cleanup = async () => {
    await scheduler.stop();
    store.close();
    await fs.rm(root, { force: true, recursive: true });
  };

  return {
    adapterPath,
    backend,
    cleanup,
    config,
    registry,
    scheduler,
    settings,
    store,
  };
}

describe('scheduler/store behavior', () => {
  it('forces OpenAI source jobs to effective priority 2', async () => {
    const harness = await createHarness();
    try {
      harness.scheduler.start();
      const job = harness.scheduler.submitJob({
        model: 'ep2',
        prompt: 'priority-check',
        requestedPriority: 0,
        source: 'openai',
      });

      assert.equal(job.requestedPriority, 0);
      assert.equal(job.effectivePriority, 2);
    } finally {
      await harness.cleanup();
    }
  });

  it('orders queued jobs by priority then FIFO', async () => {
    const harness = await createHarness();
    try {
      const release = harness.backend.blockPrompt('blocker');
      harness.scheduler.start();

      const first = harness.scheduler.submitJob({
        prompt: 'blocker',
        requestedPriority: 0,
        source: 'mcp',
      });

      await waitFor(
        () => harness.scheduler.getJob(first.id)?.state === 'running',
        2000,
        5,
        'first job did not start',
      );

      const second = harness.scheduler.submitJob({
        prompt: 'mcp-p1',
        requestedPriority: 1,
        source: 'mcp',
      });
      const third = harness.scheduler.submitJob({
        prompt: 'openai-p2',
        requestedPriority: 0,
        source: 'openai',
      });
      const fourth = harness.scheduler.submitJob({
        prompt: 'mcp-p1-fifo',
        requestedPriority: 1,
        source: 'mcp',
      });

      release();

      await harness.scheduler.waitForJob(first.id, 2000);
      await harness.scheduler.waitForJob(second.id, 2000);
      await harness.scheduler.waitForJob(third.id, 2000);
      await harness.scheduler.waitForJob(fourth.id, 2000);

      assert.deepEqual(harness.backend.calls, ['blocker', 'openai-p2', 'mcp-p1', 'mcp-p1-fifo']);
    } finally {
      await harness.cleanup();
    }
  });

  it('supports queued-only cancellation and rejects running cancellation', async () => {
    const harness = await createHarness();
    try {
      const release = harness.backend.blockPrompt('running');
      harness.scheduler.start();

      const running = harness.scheduler.submitJob({
        prompt: 'running',
        requestedPriority: 1,
        source: 'mcp',
      });
      await waitFor(
        () => harness.scheduler.getJob(running.id)?.state === 'running',
        2000,
        5,
        'running job did not enter running state',
      );

      const queued = harness.scheduler.submitJob({
        prompt: 'queued',
        requestedPriority: 1,
        source: 'mcp',
      });

      const cancelled = harness.scheduler.cancelQueuedJob(queued.id);
      assert.ok(cancelled);
      assert.equal(cancelled?.state, 'cancelled');

      const cannotCancelRunning = harness.scheduler.cancelQueuedJob(running.id);
      assert.equal(cannotCancelRunning, null);

      release();
      await harness.scheduler.waitForJob(running.id, 2000);
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps single active worker under burst load', async () => {
    const harness = await createHarness();
    try {
      harness.scheduler.start();
      for (let i = 0; i < 30; i += 1) {
        harness.backend.setDelay(`job-${i}`, 15);
      }

      const ids: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        const job = harness.scheduler.submitJob({
          prompt: `job-${i}`,
          requestedPriority: 1,
          source: 'mcp',
        });
        ids.push(job.id);
      }

      for (const id of ids) {
        const waited = await harness.scheduler.waitForJob(id, 5000);
        assert.equal(waited.job.state, 'succeeded');
      }

      assert.equal(harness.backend.maxActive, 1);
    } finally {
      await harness.cleanup();
    }
  });

  it('times out queued OpenAI jobs after max queue wait', async () => {
    const harness = await createHarness();
    try {
      const release = harness.backend.blockPrompt('blocker');
      harness.scheduler.start();

      const running = harness.scheduler.submitJob({
        prompt: 'blocker',
        requestedPriority: 1,
        source: 'mcp',
      });
      await waitFor(
        () => harness.scheduler.getJob(running.id)?.state === 'running',
        2000,
        5,
        'blocking job did not start',
      );

      const waiting = harness.scheduler.submitJob({
        prompt: 'should-timeout',
        requestedPriority: 0,
        source: 'openai',
      });

      const waited = await harness.scheduler.waitForOpenAiJob(waiting.id, 50);
      assert.equal(waited.timedOut, true);
      assert.equal(waited.job.state, 'timed_out');

      release();
      await harness.scheduler.waitForJob(running.id, 2000);
    } finally {
      await harness.cleanup();
    }
  });

  it('updates config values and exposes runtime settings from sqlite', async () => {
    const harness = await createHarness();
    try {
      harness.store.updateConfig({
        default_model: 'ep2',
        max_queue: '77',
        max_queue_wait_ms: '123456',
      });

      const settings = harness.store.getRuntimeSettings();
      assert.equal(settings.defaultModel, 'ep2');
      assert.equal(settings.maxQueue, 77);
      assert.equal(settings.maxQueueWaitMs, 123456);
    } finally {
      await harness.cleanup();
    }
  });

  it('syncs model source changes and updates registry checksum', async () => {
    const harness = await createHarness();
    try {
      const firstSource = path.join(harness.config.modelSourceDir, 'ep2-v1.gguf');
      const secondSource = path.join(harness.config.modelSourceDir, 'ep2-v2.gguf');
      const alias = 'ep2-sync';
      await fs.writeFile(firstSource, 'model-v1', 'utf8');
      await fs.writeFile(secondSource, 'model-v2', 'utf8');

      const firstSync = await harness.registry.syncFromSourceMap({ [alias]: firstSource });
      assert.deepEqual(firstSync.imported, [alias]);

      const firstModel = harness.registry.getModel(alias);
      assert.ok(firstModel);
      const firstChecksum = firstModel!.checksumSha256;

      const secondSync = await harness.registry.syncFromSourceMap({ [alias]: secondSource });
      assert.deepEqual(secondSync.updated, [alias]);

      const secondModel = harness.registry.getModel(alias);
      assert.ok(secondModel);
      assert.notEqual(secondModel!.checksumSha256, firstChecksum);
    } finally {
      await harness.cleanup();
    }
  });

  it('enforces queue depth cap', async () => {
    const harness = await createHarness(2);
    try {
      harness.scheduler.start();
      const release = harness.backend.blockPrompt('running');
      const j1 = harness.scheduler.submitJob({
        prompt: 'running',
        source: 'mcp',
      });

      await waitFor(
        () => harness.scheduler.getJob(j1.id)?.state === 'running',
        2000,
        5,
        'first job did not run',
      );

      harness.scheduler.submitJob({ prompt: 'queued-1', source: 'mcp' });
      harness.scheduler.submitJob({ prompt: 'queued-2', source: 'mcp' });

      assert.throws(() => {
        harness.scheduler.submitJob({ prompt: 'queued-3', source: 'mcp' });
      }, /Queue full/);

      release();
      await harness.scheduler.waitForJob(j1.id, 2000);
    } finally {
      await harness.cleanup();
    }
  });
});
