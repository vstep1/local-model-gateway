import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GatewayStore,
  GpuCoordinator,
  ModelRegistry,
  OpenAiUpstreamPool,
  type ActiveRuntimeSettings,
  type GatewayConfig,
} from '@local-model-gateway/core';
import { discoveryManifest } from '../src/server.js';
import { openAiModelAliases } from '../src/server.js';

function config(): GatewayConfig {
  return {
    allowUnmanagedLocalUpstreams: false,
    authToken: '',
    baseModelPath: '/tmp/base.gguf',
    configPath: null,
    ctxSize: 4096,
    dataDir: '/tmp/local-model-gateway',
    dbPath: ':memory:',
    defaultModel: 'ep2',
    gpuLayers: 'all',
    historyTtlDays: 7,
    host: '127.0.0.1',
    llamaCliPath: 'llama-cli',
    managedRuntimes: [
      {
        alias: 'qwen3-32b',
        baseUrl: 'http://127.0.0.1:18001/v1',
        contextNotes: 'test runtime',
        contextWindow: 131072,
        enabled: true,
        healthUrl: 'http://127.0.0.1:18001/v1/models',
        idleTtlMs: 600000,
        loadProgressPath: null,
        loadTimeoutMs: 900000,
        maxConcurrency: 1,
        recommendedPromptBudget: 98304,
        serviceScript: '/tmp/qwen.sh',
        startArgs: ['start'],
        stopArgs: ['stop'],
        stopSequences: [],
        stopTimeoutMs: 60000,
        supportsReasoning: false,
        supportsStreaming: true,
        upstreamModel: 'qwen3-32b',
      },
    ],
    maxQueue: 100,
    maxQueueWaitMs: 300000,
    maxTokens: 128,
    modelSourceDir: '/tmp/source',
    modelsDir: '/tmp/models',
    openAiUpstreams: [],
    port: 8787,
    repeatPenalty: 1,
    schedulerPollMs: 5,
    startupModels: {},
    temperature: 0.8,
    timeoutMs: 10000,
    topP: 0.95,
    waitPollMs: 5,
  };
}

describe('discovery manifest', () => {
  it('returns protocol endpoints and runtime metadata', () => {
    const cfg = config();
    const store = new GatewayStore(':memory:');
    store.initSchema();
    const registry = new ModelRegistry(store, cfg);
    const coordinator = new GpuCoordinator(cfg.managedRuntimes, store);
    const manifest = discoveryManifest(
      cfg,
      {
        backendTimeoutMs: cfg.timeoutMs,
        defaultModel: cfg.defaultModel,
        historyTtlDays: cfg.historyTtlDays,
        maxQueue: cfg.maxQueue,
        maxQueueWaitMs: cfg.maxQueueWaitMs,
        modelSourceDir: cfg.modelSourceDir,
      } satisfies ActiveRuntimeSettings,
      registry,
      new OpenAiUpstreamPool([]),
      coordinator,
    );

    assert.equal(manifest.openai_base_url, 'http://127.0.0.1:8787/v1');
    assert.equal(manifest.mcp_url, 'http://127.0.0.1:8787/mcp');
    assert.equal(manifest.dashboard_url, 'http://127.0.0.1:8787/dashboard');
    const models = manifest.models as Array<Record<string, unknown>>;
    assert.equal(models.some((model) => model.id === 'qwen3-32b'), true);
    assert.equal(models.find((model) => model.id === 'qwen3-32b')?.recommended_prompt_budget, 98304);
  });
});

describe('OpenAI model aliases', () => {
  it('does not advertise the default model when no route can serve it', () => {
    const cfg = {
      ...config(),
      managedRuntimes: [],
      openAiUpstreams: [],
    };
    const store = new GatewayStore(':memory:');
    store.initSchema();
    const aliases = openAiModelAliases(
      new ModelRegistry(store, cfg),
      new OpenAiUpstreamPool([]),
      new GpuCoordinator([], store),
    );

    assert.deepEqual(aliases, []);
  });

  it('advertises only configured LoRA, managed runtime, and upstream models', () => {
    const cfg = config();
    const store = new GatewayStore(':memory:');
    store.initSchema();
    store.upsertModel({
      adapterPath: '/tmp/ep2.gguf',
      alias: 'ep2',
      checksumSha256: 'test',
      enabled: true,
      managedPath: '/tmp/ep2.gguf',
      sourcePath: '/tmp/ep2.gguf',
    });

    const aliases = openAiModelAliases(
      new ModelRegistry(store, cfg),
      new OpenAiUpstreamPool([
        {
          apiKey: '',
          apiKeyEnv: '',
          baseUrl: 'https://example.com/v1',
          models: ['remote-model'],
          name: 'remote',
          timeoutMs: 1000,
          upstreamModel: 'remote-model',
        },
      ]),
      new GpuCoordinator(cfg.managedRuntimes, store),
    );

    assert.deepEqual(aliases, ['ep2', 'qwen3-32b', 'remote-model']);
  });
});
