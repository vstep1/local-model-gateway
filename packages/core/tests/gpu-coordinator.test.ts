import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initialConfigEntries } from '../src/config.js';
import { GatewayStore } from '../src/db.js';
import { GpuCoordinator, GpuCoordinatorHooks } from '../src/gpu-coordinator.js';
import { ModelRegistry } from '../src/model-registry.js';
import { Scheduler } from '../src/scheduler.js';
import {
  ActiveRuntimeSettings,
  GatewayConfig,
  GenerationBackend,
  GenerationRequest,
  ManagedRuntimeConfig,
} from '../src/types.js';
import { ensureDir } from '../src/utils.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 2000,
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

interface FakeRequest {
  body: Record<string, unknown>;
  release: (text?: string) => void;
}

async function startFakeOpenAiServer(name: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  releaseNext: (text?: string) => void;
  requests: FakeRequest[];
  waitForRequests: (count: number) => Promise<void>;
}> {
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      let release!: (text?: string) => void;
      const released = new Promise<string>((resolve) => {
        release = (text) => resolve(text ?? `${name}:${String(body.model ?? '')}`);
      });
      requests.push({ body, release });

      void released.then((text) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                index: 0,
                message: { content: text, role: 'assistant' },
              },
            ],
            created: 0,
            id: `chatcmpl-${name}`,
            model: body.model,
            object: 'chat.completion',
          }),
        );
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let releaseCursor = 0;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    releaseNext: (text?: string) => {
      const request = requests[releaseCursor];
      assert.ok(request, 'no pending fake upstream request to release');
      releaseCursor += 1;
      request.release(text);
    },
    requests,
    waitForRequests: async (count: number) => {
      await waitFor(
        () => requests.length >= count,
        2000,
        5,
        `fake ${name} upstream did not receive ${count} request(s)`,
      );
    },
  };
}

function runtime(alias: string, baseUrl: string, maxConcurrency = 1): ManagedRuntimeConfig {
  return {
    alias,
    baseUrl,
    contextNotes: null,
    contextWindow: null,
    enabled: true,
    healthUrl: `${baseUrl}/models`,
    idleTtlMs: 60_000,
    loadProgressPath: null,
    loadTimeoutMs: 1000,
    maxConcurrency,
    recommendedPromptBudget: null,
    serviceScript: `/tmp/${alias}-service.sh`,
    startArgs: ['start'],
    stopArgs: ['stop'],
    stopSequences: [],
    stopTimeoutMs: 1000,
    supportsReasoning: false,
    supportsStreaming: true,
    upstreamModel: alias,
  };
}

function createStore(): GatewayStore {
  const store = new GatewayStore(':memory:');
  store.initSchema();
  return store;
}

function createHooks(initialHealthy: string[] = []): {
  commands: string[];
  hooks: GpuCoordinatorHooks;
} {
  const healthy = new Set<string>(initialHealthy);
  const commands: string[] = [];
  return {
    commands,
    hooks: {
      isHealthy: async (config) => healthy.has(config.alias),
      runServiceCommand: async (config, args) => {
        commands.push(`${config.alias}:${args.join(' ')}`);
        if (args[0] === 'start') healthy.add(config.alias);
        if (args[0] === 'stop') healthy.delete(config.alias);
      },
    },
  };
}

async function createSchedulerHarness(
  runtimes: ManagedRuntimeConfig[],
  hooks: GpuCoordinatorHooks,
): Promise<{
  cleanup: () => Promise<void>;
  coordinator: GpuCoordinator;
  scheduler: Scheduler;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-coordinator-scheduler-'));
  const dataDir = path.join(root, 'data');
  const modelsDir = path.join(root, 'models');
  const sourceDir = path.join(root, 'source');
  await ensureDir(dataDir);
  await ensureDir(modelsDir);
  await ensureDir(sourceDir);

  const config: GatewayConfig = {
    authToken: '',
    baseModelPath: '/tmp/base.gguf',
    configPath: null,
    ctxSize: 4096,
    dataDir,
    dbPath: path.join(dataDir, 'gateway.sqlite'),
    defaultModel: 'qwen3-32b',
    gpuLayers: 'all',
    historyTtlDays: 7,
    host: '127.0.0.1',
    llamaCliPath: '/usr/bin/env',
    allowUnmanagedLocalUpstreams: false,
    managedRuntimes: [],
    maxQueue: 100,
    maxQueueWaitMs: 1000,
    maxTokens: 128,
    modelSourceDir: sourceDir,
    modelsDir,
    openAiUpstreams: [],
    port: 8787,
    repeatPenalty: 1.0,
    schedulerPollMs: 5,
    startupModels: {},
    temperature: 0.8,
    timeoutMs: 10_000,
    topP: 0.95,
    waitPollMs: 5,
  };

  const store = new GatewayStore(config.dbPath);
  store.initSchema();
  store.seedConfig(initialConfigEntries(config));
  const settings: ActiveRuntimeSettings = store.getRuntimeSettings();
  const registry = new ModelRegistry(store, config);
  const coordinator = new GpuCoordinator(runtimes, store, hooks);
  const backend: GenerationBackend = {
    async generate(_request: GenerationRequest) {
      throw new Error('LoRA backend should not run for managed runtime aliases');
    },
  };
  const scheduler = new Scheduler(
    store,
    registry,
    backend,
    settings,
    config.schedulerPollMs,
    config.waitPollMs,
    coordinator,
  );
  scheduler.start();

  return {
    cleanup: async () => {
      await scheduler.stop();
      store.close();
      await fs.rm(root, { force: true, recursive: true });
    },
    coordinator,
    scheduler,
  };
}

describe('gpu coordinator', () => {
  it('stores filters and prunes runtime timeline events', () => {
    const store = createStore();
    try {
      const first = store.insertRuntimeTimelineEvent({
        eventType: 'work_queued',
        message: 'Queued ep2',
        metadata: { priority: 1 },
        runtimeAlias: 'ep2',
        source: 'mcp',
        state: 'queued',
        workItemId: 'work-1',
      });
      store.insertRuntimeTimelineEvent({
        eventType: 'runtime_load_started',
        message: 'qwen3-32b: Load started',
        runtimeAlias: 'qwen3-32b',
        state: 'loading',
      });

      assert.equal(store.listRuntimeTimelineEvents({ limit: 10 }).length, 2);
      assert.equal(store.listRuntimeTimelineEvents({ runtimeAlias: 'ep2' })[0].id, first.id);
      assert.equal(store.listRuntimeTimelineEvents({ workItemId: 'work-1' })[0].eventType, 'work_queued');

      store.db
        .prepare("UPDATE gpu_timeline_events SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?")
        .run(first.id);
      assert.equal(store.pruneRuntimeTimelineEvents(7), 1);
      assert.equal(store.listRuntimeTimelineEvents({ limit: 10 }).some((event) => event.id === first.id), false);
    } finally {
      store.close();
    }
  });

  it('adopts an already-healthy target runtime without restarting it', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const store = createStore();
    const { commands, hooks } = createHooks(['qwen3-32b']);
    const coordinator = new GpuCoordinator([runtime('qwen3-32b', qwen.baseUrl)], store, hooks);

    try {
      const request = coordinator.proxyChatCompletions(
        { messages: [{ content: 'already up', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      await qwen.waitForRequests(1);
      qwen.releaseNext('adopted');

      assert.equal(await (await request).json().then((body: any) => body.choices[0].message.content), 'adopted');
      assert.deepEqual(commands, []);
      assert.equal(coordinator.status().runtime_timeline.some((event) => event.eventType === 'runtime_adopted_loaded'), true);
    } finally {
      store.close();
      await qwen.close();
    }
  });

  it('refreshes status state for an already-running healthy runtime', async () => {
    const store = createStore();
    const { commands, hooks } = createHooks(['qwen3-32b']);
    const coordinator = new GpuCoordinator([runtime('qwen3-32b', 'http://127.0.0.1:1/v1')], store, hooks);

    try {
      assert.equal(coordinator.status().managed_runtimes[0].state, 'unloaded');
      await coordinator.refreshRuntimeHealth();
      const status = coordinator.status().managed_runtimes[0];
      assert.equal(status.state, 'loaded');
      assert.equal(status.loadPhase, 'ready');
      assert.deepEqual(commands, []);
    } finally {
      store.close();
    }
  });

  it('reports model load progress while a runtime is starting', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-load-progress-'));
    const progressPath = path.join(root, 'qwen-progress.json');
    const store = createStore();
    let healthy = false;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const coordinator = new GpuCoordinator(
      [{ ...runtime('qwen3-32b', qwen.baseUrl), loadProgressPath: progressPath }],
      store,
      {
        isHealthy: async () => healthy,
        runServiceCommand: async (_config, args) => {
          if (args[0] === 'start') {
            await fs.writeFile(progressPath, JSON.stringify({ progress: 0.42 }), 'utf8');
            await startGate;
            healthy = true;
          }
        },
      },
    );

    try {
      const request = coordinator.proxyChatCompletions(
        { messages: [{ content: 'load telemetry', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );

      await waitFor(() => coordinator.status().managed_runtimes[0].state === 'loading');
      const loading = coordinator.status().managed_runtimes[0];
      assert.equal(loading.loadPhase, 'starting_service');
      assert.equal(typeof loading.loadElapsedMs, 'number');
      assert.equal(loading.loadProgress, 0.42);
      assert.equal(loading.loadProgressSource, 'progress_file');

      releaseStart();
      await qwen.waitForRequests(1);
      qwen.releaseNext('loaded');
      assert.equal(await (await request).json().then((body: any) => body.choices[0].message.content), 'loaded');
      const events = coordinator.status().runtime_timeline.map((event) => event.eventType);
      assert.equal(events.includes('runtime_load_started'), true);
      assert.equal(events.includes('runtime_load_succeeded'), true);
    } finally {
      store.close();
      await fs.rm(root, { force: true, recursive: true });
      await qwen.close();
    }
  });

  it('reports active prefill progress from runtime telemetry', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-prefill-progress-'));
    const progressPath = path.join(root, 'qwen-progress.json');
    const store = createStore();
    const { hooks } = createHooks(['qwen3-32b']);
    const coordinator = new GpuCoordinator(
      [{ ...runtime('qwen3-32b', qwen.baseUrl), loadProgressPath: progressPath }],
      store,
      hooks,
    );

    try {
      const request = coordinator.proxyChatCompletions(
        { messages: [{ content: 'prefill telemetry', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      await qwen.waitForRequests(1);
      await fs.writeFile(
        progressPath,
        JSON.stringify({
          load_phase: 'ready',
          load_progress: 1,
          prefill_progress: 0.5,
          prefill_task_id: 87,
          prefill_tokens_done: 4096,
          prefill_tokens_total: 8192,
          updated_at: new Date().toISOString(),
        }),
        'utf8',
      );

      const active = coordinator.status().active_work[0];
      assert.ok(active);
      assert.equal(active.phase, 'prefill');
      assert.equal(active.prefillProgress, 0.5);
      assert.equal(active.prefillTaskId, 87);
      assert.equal(active.prefillInputDone, 4096);
      assert.equal(active.prefillInputTotal, 8192);

      const runtimeStatus = coordinator.status().managed_runtimes[0];
      assert.equal(runtimeStatus.prefillProgress, 0.5);
      assert.equal(runtimeStatus.prefillInputDone, 4096);

      qwen.releaseNext('done');
      assert.equal(await (await request).json().then((body: any) => body.choices[0].message.content), 'done');
    } finally {
      store.close();
      await fs.rm(root, { force: true, recursive: true });
      await qwen.close();
    }
  });

  it('does not coerce null runtime telemetry values to zero progress', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-null-progress-'));
    const progressPath = path.join(root, 'qwen-progress.json');
    const store = createStore();
    const { hooks } = createHooks();
    const coordinator = new GpuCoordinator(
      [{ ...runtime('qwen3-32b', 'http://127.0.0.1:1/v1'), loadProgressPath: progressPath }],
      store,
      hooks,
    );

    try {
      await fs.writeFile(
        progressPath,
        JSON.stringify({
          load_phase: 'starting',
          load_progress: null,
          prefill_progress: null,
          updated_at: new Date().toISOString(),
        }),
        'utf8',
      );
      const status = coordinator.status().managed_runtimes[0];
      assert.equal(status.loadProgress, null);
      assert.equal(status.prefillProgress, null);
    } finally {
      store.close();
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it('streams managed runtime responses and holds the lease until the stream closes', async () => {
    let receivedBody: { model?: string; stream?: boolean } | null = null;
    let resolveSecondChunk!: () => void;
    const sendSecondChunk = new Promise<void>((resolve) => {
      resolveSecondChunk = resolve;
    });
    let resolveReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }

      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        receivedBody = JSON.parse(raw) as { model?: string; stream?: boolean };
        res.writeHead(200, {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream',
        });
        res.write('data: {"choices":[{"delta":{"content":"first"},"index":0}]}\n\n');
        resolveReceived();
        void sendSecondChunk.then(() => {
          res.write('data: {"choices":[{"delta":{"content":"second"},"index":0}]}\n\n');
          res.end('data: [DONE]\n\n');
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const store = createStore();
    const { hooks } = createHooks();
    const coordinator = new GpuCoordinator(
      [runtime('qwen3-32b', `http://127.0.0.1:${address.port}/v1`)],
      store,
      hooks,
    );

    try {
      const responsePromise = coordinator.proxyChatCompletions(
        {
          messages: [{ content: 'stream please', role: 'user' }],
          model: 'qwen3-32b',
          stream: true,
        },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );

      await received;
      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.deepEqual(receivedBody, {
        messages: [{ content: 'stream please', role: 'user' }],
        model: 'qwen3-32b',
        stream: true,
      });
      assert.equal(coordinator.status().managed_runtimes[0].activeRequests, 1);

      const reader = response.body?.getReader();
      assert.ok(reader, 'streaming response body missing');
      const decoder = new TextDecoder();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.match(decoder.decode(first.value), /first/);
      assert.equal(coordinator.status().managed_runtimes[0].activeRequests, 1);
      const streamingStatus = coordinator.status().active_work[0];
      assert.ok(streamingStatus);
      assert.equal(streamingStatus.phase, 'streaming');
      assert.equal(typeof streamingStatus.requestBytes, 'number');
      assert.ok((streamingStatus.requestBytes as number) > 0);
      assert.equal(typeof streamingStatus.responseBytes, 'number');
      assert.ok((streamingStatus.responseBytes as number) > 0);
      assert.equal(typeof streamingStatus.bandwidthBps, 'number');
      assert.equal(typeof streamingStatus.timeToFirstByteMs, 'number');

      const secondRead = reader.read();
      const early = await Promise.race([
        secondRead.then(() => 'chunk' as const),
        sleep(30).then(() => 'waiting' as const),
      ]);
      assert.equal(early, 'waiting');

      resolveSecondChunk();
      let streamed = decoder.decode((await secondRead).value ?? new Uint8Array());
      while (!streamed.includes('[DONE]')) {
        const next = await reader.read();
        if (next.done) break;
        streamed += decoder.decode(next.value);
      }
      assert.match(streamed, /second/);
      assert.match(streamed, /\[DONE\]/);
      await waitFor(
        () => coordinator.status().managed_runtimes[0].activeRequests === 0,
        1000,
        5,
        'managed runtime lease was not released after stream close',
      );
    } finally {
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks MCP work for a different model behind an active URL request, then swaps models', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const minimax = await startFakeOpenAiServer('minimax');
    const store = createStore();
    const { commands, hooks } = createHooks();
    const coordinator = new GpuCoordinator(
      [runtime('qwen3-32b', qwen.baseUrl), runtime('minimax-m2.7', minimax.baseUrl)],
      store,
      hooks,
    );

    try {
      const first = coordinator.proxyChatCompletions(
        { messages: [{ content: 'first', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      await qwen.waitForRequests(1);

      const second = coordinator.proxyChatCompletions(
        { messages: [{ content: 'second', role: 'user' }], model: 'minimax-m2.7' },
        'minimax-m2.7',
        'mcp',
        1,
        1000,
      );
      await sleep(30);
      assert.equal(minimax.requests.length, 0);
      assert.equal(coordinator.status().gpu_queue.filter((item) => item.state === 'queued').length, 1);

      qwen.releaseNext('qwen-done');
      assert.equal(await (await first).json().then((body: any) => body.choices[0].message.content), 'qwen-done');

      await minimax.waitForRequests(1);
      minimax.releaseNext('minimax-done');
      assert.equal(await (await second).json().then((body: any) => body.choices[0].message.content), 'minimax-done');
      assert.deepEqual(commands, [
        'qwen3-32b:start',
        'qwen3-32b:stop',
        'minimax-m2.7:start',
      ]);
    } finally {
      store.close();
      await qwen.close();
      await minimax.close();
    }
  });

  it('lets same-model URL and MCP requests share the loaded runtime without unload/reload', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const store = createStore();
    const { commands, hooks } = createHooks();
    const coordinator = new GpuCoordinator([runtime('qwen3-32b', qwen.baseUrl, 2)], store, hooks);

    try {
      const first = coordinator.proxyChatCompletions(
        { messages: [{ content: 'url', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      await qwen.waitForRequests(1);

      const second = coordinator.proxyChatCompletions(
        { messages: [{ content: 'mcp', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'mcp',
        1,
        1000,
      );
      await qwen.waitForRequests(2);
      assert.deepEqual(commands, ['qwen3-32b:start']);
      assert.equal(coordinator.status().managed_runtimes[0].activeRequests, 2);

      qwen.releaseNext('url-done');
      qwen.releaseNext('mcp-done');
      assert.equal(await (await first).json().then((body: any) => body.choices[0].message.content), 'url-done');
      assert.equal(await (await second).json().then((body: any) => body.choices[0].message.content), 'mcp-done');
      assert.deepEqual(commands, ['qwen3-32b:start']);
    } finally {
      store.close();
      await qwen.close();
    }
  });

  it('keeps same-model work queued when maxConcurrency is 1', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const store = createStore();
    const { hooks } = createHooks();
    const coordinator = new GpuCoordinator([runtime('qwen3-32b', qwen.baseUrl, 1)], store, hooks);

    try {
      const first = coordinator.proxyChatCompletions(
        { messages: [{ content: 'first', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      await qwen.waitForRequests(1);

      const second = coordinator.proxyChatCompletions(
        { messages: [{ content: 'second', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'mcp',
        1,
        1000,
      );
      await sleep(30);
      assert.equal(qwen.requests.length, 1);
      assert.equal(coordinator.status().gpu_queue.filter((item) => item.state === 'queued').length, 1);

      qwen.releaseNext('first-done');
      assert.equal(await (await first).json().then((body: any) => body.choices[0].message.content), 'first-done');
      await qwen.waitForRequests(2);
      qwen.releaseNext('second-done');
      assert.equal(await (await second).json().then((body: any) => body.choices[0].message.content), 'second-done');
    } finally {
      store.close();
      await qwen.close();
    }
  });

  it('admits up to maxConcurrency same-model requests and queues the rest', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const store = createStore();
    const { hooks } = createHooks();
    const coordinator = new GpuCoordinator([runtime('qwen3-32b', qwen.baseUrl, 2)], store, hooks);

    try {
      const first = coordinator.proxyChatCompletions(
        { messages: [{ content: 'first', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      const second = coordinator.proxyChatCompletions(
        { messages: [{ content: 'second', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'mcp',
        1,
        1000,
      );
      const third = coordinator.proxyChatCompletions(
        { messages: [{ content: 'third', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'mcp',
        1,
        1000,
      );

      await qwen.waitForRequests(2);
      assert.equal(qwen.requests.length, 2);
      assert.equal(coordinator.status().gpu_queue.filter((item) => item.state === 'queued').length, 1);

      qwen.releaseNext('first-done');
      assert.equal(await (await first).json().then((body: any) => body.choices[0].message.content), 'first-done');
      await qwen.waitForRequests(3);
      qwen.releaseNext('second-done');
      qwen.releaseNext('third-done');
      const remaining = [
        await (await second).json().then((body: any) => body.choices[0].message.content),
        await (await third).json().then((body: any) => body.choices[0].message.content),
      ].sort();
      assert.deepEqual(remaining, ['second-done', 'third-done']);
    } finally {
      store.close();
      await qwen.close();
    }
  });

  it('keeps lower-priority same-model work queued when higher-priority different-model work is waiting', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const minimax = await startFakeOpenAiServer('minimax');
    const store = createStore();
    const { hooks } = createHooks();
    const coordinator = new GpuCoordinator(
      [runtime('qwen3-32b', qwen.baseUrl), runtime('minimax-m2.7', minimax.baseUrl)],
      store,
      hooks,
    );

    try {
      const first = coordinator.proxyChatCompletions(
        { messages: [{ content: 'first', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      await qwen.waitForRequests(1);

      const highPriorityDifferentModel = coordinator.proxyChatCompletions(
        { messages: [{ content: 'minimax', role: 'user' }], model: 'minimax-m2.7' },
        'minimax-m2.7',
        'mcp',
        2,
        1000,
      );
      const lowPrioritySameModel = coordinator.proxyChatCompletions(
        { messages: [{ content: 'qwen-low', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'mcp',
        0,
        1000,
      );

      await sleep(30);
      assert.equal(qwen.requests.length, 1);
      assert.equal(minimax.requests.length, 0);

      qwen.releaseNext('first-done');
      assert.equal(await (await first).json().then((body: any) => body.choices[0].message.content), 'first-done');

      await minimax.waitForRequests(1);
      assert.equal(qwen.requests.length, 1);
      minimax.releaseNext('minimax-done');
      assert.equal(await (await highPriorityDifferentModel).json().then((body: any) => body.choices[0].message.content), 'minimax-done');

      await qwen.waitForRequests(2);
      qwen.releaseNext('qwen-low-done');
      assert.equal(await (await lowPrioritySameModel).json().then((body: any) => body.choices[0].message.content), 'qwen-low-done');
    } finally {
      store.close();
      await qwen.close();
      await minimax.close();
    }
  });

  it('blocks URL work for Qwen behind an active MCP MiniMax request, then swaps models', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const minimax = await startFakeOpenAiServer('minimax');
    const store = createStore();
    const { commands, hooks } = createHooks();
    const coordinator = new GpuCoordinator(
      [runtime('qwen3-32b', qwen.baseUrl), runtime('minimax-m2.7', minimax.baseUrl)],
      store,
      hooks,
    );

    try {
      const first = coordinator.proxyChatCompletions(
        { messages: [{ content: 'mcp-first', role: 'user' }], model: 'minimax-m2.7' },
        'minimax-m2.7',
        'mcp',
        2,
        1000,
      );
      await minimax.waitForRequests(1);

      const second = coordinator.proxyChatCompletions(
        { messages: [{ content: 'url-second', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      await sleep(30);
      assert.equal(qwen.requests.length, 0);

      minimax.releaseNext('minimax-done');
      assert.equal(await (await first).json().then((body: any) => body.choices[0].message.content), 'minimax-done');

      await qwen.waitForRequests(1);
      qwen.releaseNext('qwen-done');
      assert.equal(await (await second).json().then((body: any) => body.choices[0].message.content), 'qwen-done');
      assert.deepEqual(commands, [
        'minimax-m2.7:start',
        'minimax-m2.7:stop',
        'qwen3-32b:start',
      ]);
    } finally {
      store.close();
      await qwen.close();
      await minimax.close();
    }
  });

  it('removes aborted queued URL requests from the shared queue', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const minimax = await startFakeOpenAiServer('minimax');
    const store = createStore();
    const { hooks } = createHooks();
    const coordinator = new GpuCoordinator(
      [runtime('qwen3-32b', qwen.baseUrl), runtime('minimax-m2.7', minimax.baseUrl)],
      store,
      hooks,
    );

    try {
      const first = coordinator.proxyChatCompletions(
        { messages: [{ content: 'hold', role: 'user' }], model: 'qwen3-32b' },
        'qwen3-32b',
        'openai',
        2,
        1000,
      );
      await qwen.waitForRequests(1);

      const abortController = new AbortController();
      const queued = coordinator.proxyChatCompletions(
        { messages: [{ content: 'abort', role: 'user' }], model: 'minimax-m2.7' },
        'minimax-m2.7',
        'openai',
        2,
        1000,
        abortController.signal,
      );
      await waitFor(() => coordinator.status().gpu_queue.filter((item) => item.state === 'queued').length === 1);
      abortController.abort(new Error('test abort'));

      const aborted = await queued;
      assert.equal(aborted.status, 499);
      assert.equal(coordinator.status().gpu_queue.filter((item) => item.state === 'queued').length, 0);
      assert.equal(store.listGpuWorkItems(10, 'cancelled').length, 1);
      assert.equal(coordinator.status().recent_work[0].failureCategory, 'client_cancelled');
      assert.equal(coordinator.status().runtime_timeline[0].eventType, 'work_cancelled');
      assert.equal(minimax.requests.length, 0);

      qwen.releaseNext('held-done');
      await (await first).text();
    } finally {
      store.close();
      await qwen.close();
      await minimax.close();
    }
  });

  it('executes submit_job for managed runtime aliases through the coordinator', async () => {
    const qwen = await startFakeOpenAiServer('qwen');
    const { hooks } = createHooks();
    const harness = await createSchedulerHarness([runtime('qwen3-32b', qwen.baseUrl)], hooks);

    try {
      const job = harness.scheduler.submitJob({
        model: 'qwen3-32b',
        prompt: 'managed prompt',
        requestedPriority: 1,
        source: 'mcp',
      });
      await qwen.waitForRequests(1);
      qwen.releaseNext('managed-runtime-output');

      const waited = await harness.scheduler.waitForJob(job.id, 2000);
      assert.equal(waited.job.state, 'succeeded');
      assert.equal(waited.job.resultText, 'managed-runtime-output');
    } finally {
      await harness.cleanup();
      await qwen.close();
    }
  });

  it('reports one-shot command runtime adapter work without exposing exclusive kind publicly', async () => {
    const store = createStore();
    const { hooks } = createHooks();
    const coordinator = new GpuCoordinator([], store, hooks);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const running = coordinator.runOneShotCommand(
        {
          model: 'ep2',
          priority: 1,
          source: 'mcp',
        },
        async () => {
          await blocker;
          return 'done';
        },
      );

      await waitFor(() => coordinator.status().active_work.length === 1);
      const active = coordinator.status().active_work[0];
      assert.equal(active.runtimeAlias, 'ep2');
      assert.equal(active.runtimeAdapter, 'llama_cli');
      assert.equal(active.runtimeMode, 'one_shot_command');
      assert.equal(active.phase, 'command_running');
      assert.equal('kind' in active, false);
      assert.equal('type' in active, false);
      const activeEvents = coordinator.status().runtime_timeline.map((event) => event.eventType);
      assert.equal(activeEvents.includes('work_queued'), true);
      assert.equal(activeEvents.includes('work_started'), true);

      release();
      assert.equal(await running, 'done');
      assert.equal(coordinator.status().active_work.length, 0);
      const recent = coordinator.status().recent_work[0];
      assert.equal(recent.runtimeAlias, 'ep2');
      assert.equal(recent.runtimeAdapter, 'llama_cli');
      assert.equal(recent.runtimeMode, 'one_shot_command');
      assert.equal(recent.phase, 'command_running');
      assert.equal(recent.state, 'succeeded');
      assert.equal('kind' in recent, false);
      assert.equal('type' in recent, false);
      assert.equal(coordinator.status().runtime_timeline[0].eventType, 'work_succeeded');
    } finally {
      store.close();
    }
  });

  it('recovers queued and running GPU work items on startup', async () => {
    const store = createStore();
    try {
      const queued = store.createGpuWorkItem({
        kind: 'runtime',
        model: 'qwen3-32b',
        priority: 1,
        source: 'openai',
      });
      const running = store.createGpuWorkItem({
        kind: 'exclusive',
        model: 'ep2',
        priority: 1,
        source: 'mcp',
      });
      assert.ok(store.startGpuWorkItem(running.id));

      const recovered = store.recoverInterruptedGpuWork();
      assert.equal(recovered.workItemsFailed, 2);
      assert.equal(store.getGpuWorkItemById(queued.id)?.state, 'failed');
      assert.equal(store.getGpuWorkItemById(running.id)?.state, 'failed');
      assert.match(store.getGpuWorkItemById(queued.id)?.errorText ?? '', /gateway_restarted/);
    } finally {
      store.close();
    }
  });
});
