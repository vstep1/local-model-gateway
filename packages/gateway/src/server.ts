import path from 'node:path';
import { FastMCP } from 'fastmcp';
import {
  CONFIG_KEYS,
  GatewayStore,
  GpuCoordinator,
  initialConfigEntries,
  LlamaCliBackend,
  ModelRegistry,
  OpenAiUpstreamPool,
  redactForStatus,
  resolveGatewayConfig,
  ensureDir,
} from '@local-model-gateway/core';
import { registerOpenAiRoutes } from './openai-routes.js';
import { Scheduler } from '@local-model-gateway/core';
import { registerTools } from './tools/index.js';
import type { ActiveRuntimeSettings, GatewayConfig } from '@local-model-gateway/core';

function applyRuntimeSettings(
  envConfig: GatewayConfig,
  runtimeSettings: ActiveRuntimeSettings,
): GatewayConfig {
  return {
    ...envConfig,
    defaultModel: runtimeSettings.defaultModel || envConfig.defaultModel,
    maxQueue: runtimeSettings.maxQueue || envConfig.maxQueue,
    historyTtlDays: runtimeSettings.historyTtlDays || envConfig.historyTtlDays,
    maxQueueWaitMs: runtimeSettings.maxQueueWaitMs || envConfig.maxQueueWaitMs,
    modelSourceDir: runtimeSettings.modelSourceDir || envConfig.modelSourceDir,
    timeoutMs: runtimeSettings.backendTimeoutMs || envConfig.timeoutMs,
  };
}

function authorized(request: Request, authToken: string): boolean {
  if (!authToken) return true;
  const header = request.headers.get('authorization') ?? '';
  return header === `Bearer ${authToken}`;
}

function gatewayUrls(config: GatewayConfig): {
  base: string;
  mcp: string;
  openai: string;
  status: string;
} {
  const base = `http://${config.host}:${config.port}`;
  return {
    base,
    mcp: `${base}/mcp`,
    openai: `${base}/v1`,
    status: `${base}/status`,
  };
}

export function discoveryManifest(
  config: GatewayConfig,
  activeSettings: ActiveRuntimeSettings,
  registry: ModelRegistry,
  upstreamPool: OpenAiUpstreamPool,
  gpuCoordinator: GpuCoordinator,
): Record<string, unknown> {
  const urls = gatewayUrls(config);
  const loraModels = registry.listModels(true).map((model) => ({
    id: model.alias,
    kind: 'lora',
    supports_streaming: true,
    supports_reasoning: false,
    context_window: config.ctxSize,
    recommended_prompt_budget: Math.max(1024, Math.floor(config.ctxSize * 0.75)),
    timeout_ms: config.timeoutMs,
  }));
  const runtimeModels = gpuCoordinator.listRuntimeModels().map((runtime) => ({
    id: runtime.alias,
    kind: 'managed_runtime',
    state: runtime.state,
    upstream_model: runtime.upstreamModel,
    health_url: runtime.healthUrl,
    max_concurrency: runtime.maxConcurrency,
    context_window: runtime.contextWindow,
    context_notes: runtime.contextNotes,
    recommended_prompt_budget: runtime.recommendedPromptBudget,
    supports_streaming: runtime.supportsStreaming,
    supports_reasoning: runtime.supportsReasoning,
  }));
  const externalModels = upstreamPool.listModels().map((id) => ({
    id,
    kind: 'external_upstream',
    supports_streaming: true,
    supports_reasoning: null,
    context_window: null,
    recommended_prompt_budget: null,
    timeout_ms: config.timeoutMs,
  }));

  return redactForStatus({
    name: 'local-model-gateway',
    version: '0.1.0',
    openai_base_url: urls.openai,
    mcp_url: urls.mcp,
    status_url: urls.status,
    default_model: activeSettings.defaultModel,
    auth_required: Boolean(config.authToken),
    models: [...loraModels, ...runtimeModels, ...externalModels].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function openAiModelAliases(
  registry: ModelRegistry,
  upstreamPool: OpenAiUpstreamPool,
  gpuCoordinator: GpuCoordinator,
): string[] {
  const enabled = registry.listModels(true).map((model) => model.alias);
  const remote = upstreamPool.listModels();
  const managed = gpuCoordinator.listModels();
  return Array.from(new Set([...enabled, ...managed, ...remote])).sort();
}

export async function startGateway(): Promise<void> {
  const envConfig = resolveGatewayConfig();
  await ensureDir(envConfig.dataDir);
  await ensureDir(path.dirname(envConfig.dbPath));
  await ensureDir(envConfig.modelsDir);

  const store = new GatewayStore(envConfig.dbPath);
  store.initSchema();
  store.seedConfig(initialConfigEntries(envConfig));

  const runtimeSettings = store.getRuntimeSettings();
  const config = applyRuntimeSettings(envConfig, runtimeSettings);
  const activeSettings: ActiveRuntimeSettings = {
    backendTimeoutMs: config.timeoutMs,
    defaultModel: config.defaultModel,
    historyTtlDays: config.historyTtlDays,
    maxQueue: config.maxQueue,
    maxQueueWaitMs: config.maxQueueWaitMs,
    modelSourceDir: config.modelSourceDir,
  };

  const registry = new ModelRegistry(store, config);
  const syncResult = await registry.syncStartup();
  if (syncResult.missingSources.length > 0) {
    console.warn(
      '[local-model-gateway] Missing startup model sources:',
      syncResult.missingSources.join(', '),
    );
  }

  const recoveredGpu = store.recoverInterruptedGpuWork();
  if (recoveredGpu.workItemsFailed > 0 || recoveredGpu.jobsFailed > 0) {
    console.warn(
      `[local-model-gateway] Recovered ${recoveredGpu.workItemsFailed} GPU work items and ${recoveredGpu.jobsFailed} jobs after restart.`,
    );
  }
  const recovered = store.failRunningJobsOnStartup();
  if (recovered > 0) {
    console.warn(
      `[local-model-gateway] Recovered ${recovered} running jobs as failed after restart.`,
    );
  }

  const backend = new LlamaCliBackend(config);
  const gpuCoordinator = new GpuCoordinator(config.managedRuntimes, store);
  const upstreamPool = new OpenAiUpstreamPool(config.openAiUpstreams);
  const scheduler = new Scheduler(
    store,
    registry,
    backend,
    activeSettings,
    config.schedulerPollMs,
    config.waitPollMs,
    gpuCoordinator,
  );
  scheduler.start();

  const server = new FastMCP({
    health: {
      enabled: true,
      message: 'ok',
      path: '/health',
      status: 200,
    },
    instructions:
      'Local Model Gateway MCP server with shared local GPU runtime scheduling and OpenAI-compatible endpoints.',
    name: 'local-model-gateway',
    version: '0.1.0',
  });

  registerTools(server, scheduler, store, registry, config, gpuCoordinator);

  const app = server.getApp();
  app.use('*', async (c, next) => {
    if (
      c.req.path === '/health' ||
      c.req.path === '/.well-known/local-model-gateway.json'
    ) {
      await next();
      return;
    }
    if (!authorized(c.req.raw, config.authToken)) {
      return c.json(
        { error: { message: 'Missing or invalid bearer token', type: 'authentication_error' } },
        401,
      );
    }
    await next();
  });

  registerOpenAiRoutes(
    app,
    scheduler,
    activeSettings,
    () => openAiModelAliases(registry, upstreamPool, gpuCoordinator),
    upstreamPool,
    gpuCoordinator,
  );

  app.get('/.well-known/local-model-gateway.json', async (c) => c.json(
    discoveryManifest(config, activeSettings, registry, upstreamPool, gpuCoordinator),
  ));

  app.get('/status', async (c) => {
    return c.json(redactForStatus({
      config: {
        [CONFIG_KEYS.DEFAULT_MODEL]: activeSettings.defaultModel,
        [CONFIG_KEYS.HISTORY_TTL_DAYS]: activeSettings.historyTtlDays,
        [CONFIG_KEYS.MAX_QUEUE]: activeSettings.maxQueue,
        [CONFIG_KEYS.MAX_QUEUE_WAIT_MS]: activeSettings.maxQueueWaitMs,
      },
      queue: scheduler.queueStatus(),
      service: 'local-model-gateway',
      ...gpuCoordinator.status(),
      upstreams: upstreamPool.describe(),
      uptime_seconds: Math.floor(process.uptime()),
    }));
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`[local-model-gateway] ${signal}: shutting down`);
    try {
      await scheduler.stop();
      await server.stop();
      store.close();
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error('[local-model-gateway] shutdown error:', message);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('uncaughtException', (error) => {
    console.error('[local-model-gateway] uncaught exception:', error);
  });
  process.on('unhandledRejection', (error) => {
    console.error('[local-model-gateway] unhandled rejection:', error);
  });

  await server.start({
    httpStream: {
      endpoint: '/mcp',
      host: config.host,
      port: config.port,
    },
    transportType: 'httpStream',
  });

  console.error(
    `[local-model-gateway] listening on http://${config.host}:${config.port} (MCP /mcp, OpenAI /v1/*)`,
  );
}
