import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { initialConfigEntries } from '@local-model-gateway/core';
import { GatewayStore } from '@local-model-gateway/core';
import { ModelRegistry } from '@local-model-gateway/core';
import { OpenAiUpstreamPool } from '@local-model-gateway/core';
import { registerOpenAiRoutes } from '../src/openai-routes.js';
import { Scheduler } from '@local-model-gateway/core';
import { ensureDir, fileSha256 } from '@local-model-gateway/core';
import { ActiveRuntimeSettings, GatewayConfig, GenerationBackend, GenerationRequest } from '@local-model-gateway/core';

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

class TestBackend implements GenerationBackend {
  private activePrompt: string | null = null;
  private resolver: (() => void) | null = null;

  block(prompt: string): () => void {
    this.activePrompt = prompt;
    return () => {
      if (this.resolver) {
        this.resolver();
      }
      this.activePrompt = null;
      this.resolver = null;
    };
  }

  async generate(request: GenerationRequest) {
    if (this.activePrompt === request.prompt) {
      await new Promise<void>((resolve) => {
        this.resolver = resolve;
      });
    }
    await sleep(5);
    return {
      durationMs: 5,
      outputText: `assistant:${request.prompt}`,
      rawTail: '',
    };
  }
}

async function createOpenAiApp(): Promise<{
  app: Hono;
  cleanup: () => Promise<void>;
  scheduler: Scheduler;
  backend: TestBackend;
  store: GatewayStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-gateway-openai-'));
  const dataDir = path.join(root, 'data');
  const modelsDir = path.join(root, 'models');
  const sourceDir = path.join(root, 'source');
  const adapterPath = path.join(sourceDir, 'ep2.gguf');

  await ensureDir(dataDir);
  await ensureDir(modelsDir);
  await ensureDir(sourceDir);
  await fs.writeFile(adapterPath, 'ep2-adapter', 'utf8');

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
    maxQueue: 100,
    maxQueueWaitMs: 300,
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

  const settings: ActiveRuntimeSettings = store.getRuntimeSettings();
  const registry = new ModelRegistry(store, config);
  const backend = new TestBackend();
  const scheduler = new Scheduler(
    store,
    registry,
    backend,
    settings,
    config.schedulerPollMs,
    config.waitPollMs,
  );
  scheduler.start();

  const app = new Hono();
  registerOpenAiRoutes(app, scheduler, settings, () => ['ep2']);

  const cleanup = async () => {
    await scheduler.stop();
    store.close();
    await fs.rm(root, { force: true, recursive: true });
  };

  return { app, cleanup, scheduler, backend, store };
}

describe('openai-compatible routes', () => {
  it('returns model list', async () => {
    const harness = await createOpenAiApp();
    try {
      const res = await harness.app.request('/v1/models');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, 'list');
      assert.equal(Array.isArray(body.data), true);
      assert.equal(body.data[0].id, 'ep2');
    } finally {
      await harness.cleanup();
    }
  });

  it('handles chat completions non-stream response', async () => {
    const harness = await createOpenAiApp();
    try {
      const res = await harness.app.request('/v1/chat/completions', {
        body: JSON.stringify({
          messages: [{ content: 'Write one line.', role: 'user' }],
          model: 'ep2',
          stream: false,
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, 'chat.completion');
      assert.equal(body.choices[0].message.role, 'assistant');
      assert.equal(typeof body.choices[0].message.content, 'string');
    } finally {
      await harness.cleanup();
    }
  });

  it('times out queued jobs for chat completions and returns OpenAI-style error', async () => {
    const harness = await createOpenAiApp();
    try {
      const release = harness.backend.block('USER:\nhold the worker');

      const running = harness.scheduler.submitJob({
        prompt: 'USER:\nhold the worker',
        requestedPriority: 1,
        source: 'mcp',
      });
      await waitFor(
        () => harness.scheduler.getJob(running.id)?.state === 'running',
        2000,
        5,
        'running blocker did not start',
      );

      const timeoutRes = await harness.app.request('/v1/chat/completions', {
        body: JSON.stringify({
          max_queue_wait_ms: 30,
          messages: [{ content: 'This should queue timeout.', role: 'user' }],
          stream: false,
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      assert.equal(timeoutRes.status, 504);
      const body = await timeoutRes.json();
      assert.equal(body.error.type, 'rate_limit_error');
      assert.match(body.error.message, /Queue wait timeout/i);

      release();
      await harness.scheduler.waitForJob(running.id, 2000);
    } finally {
      await harness.cleanup();
    }
  });

  it('proxies configured MiniMax aliases through upstreams round-robin', async () => {
    const calls: Array<{ name: string; model: string }> = [];
    const servers: http.Server[] = [];

    async function startUpstream(name: string): Promise<string> {
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
          const body = JSON.parse(raw) as { model?: string };
          calls.push({ model: body.model ?? '', name });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'stop',
                  index: 0,
                  message: { content: name, role: 'assistant' },
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
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      return `http://127.0.0.1:${address.port}/v1`;
    }

    const harness = await createOpenAiApp();
    try {
      const first = await startUpstream('first');
      const second = await startUpstream('second');
      const upstreamPool = new OpenAiUpstreamPool([
        {
          apiKey: '',
          apiKeyEnv: '',
          baseUrl: first,
          models: ['minimax-m2.7', 'MiniMaxAI/MiniMax-M2.7'],
          name: 'first',
          timeoutMs: 1000,
          upstreamModel: 'MiniMaxAI/MiniMax-M2.7',
        },
        {
          apiKey: '',
          apiKeyEnv: '',
          baseUrl: second,
          models: ['minimax-m2.7', 'MiniMaxAI/MiniMax-M2.7'],
          name: 'second',
          timeoutMs: 1000,
          upstreamModel: 'MiniMaxAI/MiniMax-M2.7',
        },
      ]);
      const app = new Hono();
      registerOpenAiRoutes(
        app,
        harness.scheduler,
        harness.store.getRuntimeSettings(),
        () => ['ep2', ...upstreamPool.listModels()],
        upstreamPool,
      );

      const modelsRes = await app.request('/v1/models');
      const modelsBody = await modelsRes.json();
      assert.deepEqual(
        modelsBody.data.map((item: { id: string }) => item.id),
        ['ep2', 'MiniMaxAI/MiniMax-M2.7', 'minimax-m2.7'],
      );

      for (let i = 0; i < 2; i += 1) {
        const res = await app.request('/v1/chat/completions', {
          body: JSON.stringify({
            messages: [{ content: 'ping', role: 'user' }],
            model: 'minimax-m2.7',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        assert.equal(res.status, 200);
      }

      assert.deepEqual(calls, [
        { model: 'MiniMaxAI/MiniMax-M2.7', name: 'first' },
        { model: 'MiniMaxAI/MiniMax-M2.7', name: 'second' },
      ]);
    } finally {
      await harness.cleanup();
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    }
  });

  it('passes through streaming chat completion chunks from upstreams without buffering', async () => {
    let receivedBody: { model?: string; stream?: boolean } | null = null;
    let resolveSecondChunk!: () => void;
    const sendSecondChunk = new Promise<void>((resolve) => {
      resolveSecondChunk = resolve;
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
        void sendSecondChunk.then(() => {
          res.write('data: {"choices":[{"delta":{"content":"second"},"index":0}]}\n\n');
          res.end('data: [DONE]\n\n');
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const harness = await createOpenAiApp();
    try {
      const upstreamPool = new OpenAiUpstreamPool([
        {
          apiKey: '',
          apiKeyEnv: '',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: ['minimax-m2.7'],
          name: 'streaming-upstream',
          timeoutMs: 10_000,
          upstreamModel: 'MiniMaxAI/MiniMax-M2.7',
        },
      ]);
      const app = new Hono();
      registerOpenAiRoutes(
        app,
        harness.scheduler,
        harness.store.getRuntimeSettings(),
        () => ['ep2', ...upstreamPool.listModels()],
        upstreamPool,
      );

      const res = await app.request('/v1/chat/completions', {
        body: JSON.stringify({
          messages: [{ content: 'stream please', role: 'user' }],
          model: 'minimax-m2.7',
          stream: true,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      assert.deepEqual(receivedBody, {
        messages: [{ content: 'stream please', role: 'user' }],
        model: 'MiniMaxAI/MiniMax-M2.7',
        stream: true,
      });

      const reader = res.body?.getReader();
      assert.ok(reader, 'streaming response body missing');
      const decoder = new TextDecoder();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.match(decoder.decode(first.value), /first/);

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
    } finally {
      await harness.cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aborts proxied MiniMax requests when the client disconnects', async () => {
    let resolveReceived: () => void = () => {};
    let resolveClosed: () => void = () => {};
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }

      req.resume();
      req.on('end', () => {
        resolveReceived();
      });
      res.on('close', () => {
        resolveClosed();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const harness = await createOpenAiApp();
    try {
      const upstreamPool = new OpenAiUpstreamPool([
        {
          apiKey: '',
          apiKeyEnv: '',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: ['minimax-m2.7'],
          name: 'held-open-upstream',
          timeoutMs: 10_000,
          upstreamModel: 'MiniMaxAI/MiniMax-M2.7',
        },
      ]);
      const app = new Hono();
      registerOpenAiRoutes(
        app,
        harness.scheduler,
        harness.store.getRuntimeSettings(),
        () => ['ep2', ...upstreamPool.listModels()],
        upstreamPool,
      );

      const abortController = new AbortController();
      const request = Promise.resolve(
        app.request('/v1/chat/completions', {
          body: JSON.stringify({
            messages: [{ content: 'hold open', role: 'user' }],
            model: 'minimax-m2.7',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          signal: abortController.signal,
        }),
      ).catch((error: unknown) => error);

      await Promise.race([
        received,
        sleep(1000).then(() => {
          throw new Error('upstream did not receive request');
        }),
      ]);
      abortController.abort(new Error('test client disconnect'));

      await Promise.race([
        closed,
        sleep(1000).then(() => {
          throw new Error('upstream request was not aborted');
        }),
      ]);

      const result = await request;
      if (result instanceof Response) {
        assert.equal(result.status, 499);
      } else {
        assert.ok(result instanceof Error);
      }
    } finally {
      await harness.cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
