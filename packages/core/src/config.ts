import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { GatewayConfig, ManagedRuntimeConfig, OpenAiUpstreamConfig } from './types.js';

export const DEFAULT_CONFIG_FILE = 'local-ai-gateway.config.yaml';

type JsonRecord = Record<string, unknown>;

export interface ResolveGatewayConfigOptions {
  configPath?: string | null;
  rootDir?: string;
}

function rootDirFromOptions(options: ResolveGatewayConfigOptions = {}): string {
  return path.resolve(options.rootDir ?? process.cwd());
}

function readNumberEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readStringEnv(names: string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name];
    if (!value) continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

function readBoolEnv(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    return asBoolean(raw, fallback);
  }
  return fallback;
}

function splitCsvEnv(names: string[]): string[] {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  const parsed = asStringList(value);
  return parsed.length > 0 ? parsed : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveMaybeRelative(value: string, baseDir: string): string {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function findConfigPath(options: ResolveGatewayConfigOptions, rootDir: string): string | null {
  const explicit = options.configPath ?? readStringEnv(
    ['LOCAL_AI_GATEWAY_CONFIG', 'LOCAL_GPU_GATEWAY_CONFIG'],
    '',
  );
  if (explicit) return path.resolve(rootDir, explicit);

  for (const fileName of [DEFAULT_CONFIG_FILE, 'local-ai-gateway.config.yml']) {
    const candidate = path.resolve(rootDir, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadConfigFile(configPath: string | null): JsonRecord {
  if (!configPath || !existsSync(configPath)) return {};
  const parsed = YAML.parse(readFileSync(configPath, 'utf8')) as unknown;
  return asRecord(parsed);
}

function parseOpenAiUpstreamsFromValue(value: unknown, timeoutMs: number): OpenAiUpstreamConfig[] {
  const records = Array.isArray(value) ? value : [];
  const upstreams: OpenAiUpstreamConfig[] = [];
  for (const [index, item] of records.entries()) {
    const record = asRecord(item);
    const baseUrl = String(record.baseUrl ?? record.base_url ?? '').trim();
    const models = asStringList(record.models ?? record.model);
    if (!baseUrl || models.length === 0) continue;

    const apiKeyEnv = String(record.apiKeyEnv ?? record.api_key_env ?? '').trim();
    const apiKey = String(
      record.apiKey ?? record.api_key ?? (apiKeyEnv ? process.env[apiKeyEnv] : '') ?? '',
    );
    upstreams.push({
      apiKey,
      apiKeyEnv,
      baseUrl,
      models,
      name: String(record.name ?? `upstream-${index + 1}`).trim() || `upstream-${index + 1}`,
      timeoutMs: asNumber(record.timeoutMs ?? record.timeout_ms, timeoutMs),
      upstreamModel: String(record.upstreamModel ?? record.upstream_model ?? models[0] ?? '').trim(),
    });
  }
  return upstreams;
}

function parseOpenAiUpstreams(configFile: JsonRecord, timeoutMs: number): OpenAiUpstreamConfig[] {
  const rawJson = readStringEnv(['LOCAL_AI_GATEWAY_OPENAI_UPSTREAMS', 'LOCAL_GPU_GATEWAY_OPENAI_UPSTREAMS'], '');
  if (rawJson) {
    try {
      return parseOpenAiUpstreamsFromValue(JSON.parse(rawJson) as unknown, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[local-ai-gateway] Ignoring invalid OpenAI upstream JSON: ${message}`);
    }
  }

  return parseOpenAiUpstreamsFromValue(
    configFile.openai_upstreams ?? configFile.openAiUpstreams ?? [],
    timeoutMs,
  );
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]';
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function validateOpenAiUpstreams(
  upstreams: OpenAiUpstreamConfig[],
  managedRuntimes: ManagedRuntimeConfig[],
  allowUnmanagedLocalUpstreams: boolean,
): OpenAiUpstreamConfig[] {
  const managedAliases = new Set(
    managedRuntimes.flatMap((runtime) => [
      runtime.alias.toLowerCase(),
      runtime.upstreamModel.toLowerCase(),
    ]),
  );

  return upstreams.filter((upstream) => {
    const aliases = upstream.models.map((model) => model.toLowerCase());
    if (aliases.some((alias) => managedAliases.has(alias))) {
      console.warn(
        `[local-ai-gateway] Ignoring unmanaged upstream ${upstream.name}: alias is managed by the GPU coordinator`,
      );
      return false;
    }

    if (!allowUnmanagedLocalUpstreams && isLoopbackUrl(upstream.baseUrl)) {
      console.warn(
        `[local-ai-gateway] Ignoring unmanaged loopback upstream ${upstream.name}: set allow_unmanaged_local_upstreams=true to allow`,
      );
      return false;
    }

    return true;
  });
}

function runtimeRecords(configFile: JsonRecord): JsonRecord[] {
  const raw = configFile.runtimes ?? configFile.managed_runtimes ?? configFile.managedRuntimes;
  if (Array.isArray(raw)) return raw.map(asRecord);
  return Object.entries(asRecord(raw)).map(([alias, value]) => ({
    ...asRecord(value),
    alias,
  }));
}

function parseManagedRuntimes(configFile: JsonRecord, timeoutMs: number, configDir: string): ManagedRuntimeConfig[] {
  let records = runtimeRecords(configFile);
  const rawJson = readStringEnv(['LOCAL_AI_GATEWAY_MANAGED_RUNTIMES', 'LOCAL_GPU_GATEWAY_MANAGED_RUNTIMES'], '');
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      records = Array.isArray(parsed)
        ? parsed.map(asRecord)
        : Object.entries(asRecord(parsed)).map(([alias, value]) => ({
            ...asRecord(value),
            alias,
          }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[local-ai-gateway] Ignoring invalid managed runtime JSON: ${message}`);
    }
  }

  return records
    .map((record): ManagedRuntimeConfig | null => {
      const alias = String(record.alias ?? record.model ?? '').trim();
      if (!alias) return null;
      const baseUrl = String(record.baseUrl ?? record.base_url ?? '').trim();
      const healthUrl = String(record.healthUrl ?? record.health_url ?? '').trim();
      const serviceScriptRaw = String(record.serviceScript ?? record.service_script ?? '').trim();
      if (!baseUrl || !healthUrl || !serviceScriptRaw) return null;

      return {
        alias,
        baseUrl,
        contextNotes: record.contextNotes || record.context_notes
          ? String(record.contextNotes ?? record.context_notes)
          : null,
        contextWindow: asNullableNumber(record.contextWindow ?? record.context_window),
        enabled: asBoolean(record.enabled, true),
        healthUrl,
        idleTtlMs: asNumber(record.idleTtlMs ?? record.idle_ttl_ms, 600_000),
        loadTimeoutMs: asNumber(record.loadTimeoutMs ?? record.load_timeout_ms, timeoutMs),
        maxConcurrency: Math.max(1, asNumber(record.maxConcurrency ?? record.max_concurrency, 1)),
        recommendedPromptBudget: asNullableNumber(
          record.recommendedPromptBudget ?? record.recommended_prompt_budget,
        ),
        serviceScript: resolveMaybeRelative(serviceScriptRaw, configDir),
        startArgs: asStringArray(record.startArgs ?? record.start_args, ['start']),
        stopArgs: asStringArray(record.stopArgs ?? record.stop_args, ['stop']),
        stopTimeoutMs: asNumber(record.stopTimeoutMs ?? record.stop_timeout_ms, 60_000),
        supportsReasoning: asBoolean(record.supportsReasoning ?? record.supports_reasoning, false),
        supportsStreaming: asBoolean(record.supportsStreaming ?? record.supports_streaming, true),
        upstreamModel: String(record.upstreamModel ?? record.upstream_model ?? alias).trim(),
      };
    })
    .filter((runtime): runtime is ManagedRuntimeConfig => Boolean(runtime && runtime.enabled));
}

export function validateGatewayConfig(config: GatewayConfig): void {
  if (!isLoopbackHost(config.host) && !config.authToken) {
    throw new Error(
      `Refusing to bind ${config.host}:${config.port} without auth. Set server.auth_token or LOCAL_AI_GATEWAY_AUTH_TOKEN.`,
    );
  }
}

export function resolveGatewayConfig(options: ResolveGatewayConfigOptions = {}): GatewayConfig {
  const rootDir = rootDirFromOptions(options);
  const configPath = findConfigPath(options, rootDir);
  const configFile = loadConfigFile(configPath);
  const configDir = configPath ? path.dirname(configPath) : rootDir;
  const server = asRecord(configFile.server);
  const paths = asRecord(configFile.paths);
  const queue = asRecord(configFile.queue);
  const generation = asRecord(configFile.generation);

  const timeoutMs = readNumberEnv(
    ['LOCAL_AI_GATEWAY_TIMEOUT_MS', 'LOCAL_GPU_GATEWAY_TIMEOUT_MS'],
    asNumber(configFile.timeout_ms ?? configFile.timeoutMs, 180_000),
  );
  const managedRuntimes = parseManagedRuntimes(configFile, timeoutMs, configDir);
  const allowUnmanagedLocalUpstreams = readBoolEnv(
    ['LOCAL_AI_GATEWAY_ALLOW_UNMANAGED_LOCAL_UPSTREAMS', 'LOCAL_GPU_GATEWAY_ALLOW_UNMANAGED_LOCAL_UPSTREAMS'],
    asBoolean(configFile.allow_unmanaged_local_upstreams ?? configFile.allowUnmanagedLocalUpstreams, false),
  );
  const openAiUpstreams = validateOpenAiUpstreams(
    parseOpenAiUpstreams(configFile, timeoutMs),
    managedRuntimes,
    allowUnmanagedLocalUpstreams,
  );

  const dataDir = resolveMaybeRelative(
    readStringEnv(
      ['LOCAL_AI_GATEWAY_DATA_DIR', 'LOCAL_GPU_GATEWAY_DATA_DIR'],
      String(paths.data_dir ?? paths.dataDir ?? './data'),
    ),
    configDir,
  );
  const modelsDir = resolveMaybeRelative(
    readStringEnv(
      ['LOCAL_AI_GATEWAY_MODELS_DIR', 'LOCAL_GPU_GATEWAY_MODELS_DIR'],
      String(paths.models_dir ?? paths.modelsDir ?? './models'),
    ),
    configDir,
  );
  const dbPath = resolveMaybeRelative(
    readStringEnv(
      ['LOCAL_AI_GATEWAY_DB_PATH', 'LOCAL_GPU_GATEWAY_DB_PATH'],
      String(paths.db_path ?? paths.dbPath ?? './data/gateway.sqlite'),
    ),
    configDir,
  );

  const config: GatewayConfig = {
    authToken: readStringEnv(
      ['LOCAL_AI_GATEWAY_AUTH_TOKEN', 'LOCAL_GPU_GATEWAY_AUTH_TOKEN'],
      String(server.auth_token ?? server.authToken ?? ''),
    ),
    baseModelPath: resolveMaybeRelative(
      readStringEnv(
        ['LOCAL_AI_GATEWAY_BASE_MODEL_PATH', 'LOCAL_GPU_GATEWAY_BASE_MODEL_PATH'],
        String(paths.base_model_path ?? paths.baseModelPath ?? './runtime/base.gguf'),
      ),
      configDir,
    ),
    configPath,
    ctxSize: readNumberEnv(
      ['LOCAL_AI_GATEWAY_CTX_SIZE', 'LOCAL_GPU_GATEWAY_CTX_SIZE'],
      asNumber(generation.ctx_size ?? generation.ctxSize, 4096),
    ),
    dataDir,
    dbPath,
    defaultModel: readStringEnv(
      ['LOCAL_AI_GATEWAY_DEFAULT_MODEL', 'LOCAL_GPU_GATEWAY_DEFAULT_MODEL'],
      String(configFile.default_model ?? configFile.defaultModel ?? 'ep2'),
    ),
    gpuLayers: readStringEnv(
      ['LOCAL_AI_GATEWAY_GPU_LAYERS', 'LOCAL_GPU_GATEWAY_GPU_LAYERS'],
      String(generation.gpu_layers ?? generation.gpuLayers ?? 'all'),
    ),
    historyTtlDays: readNumberEnv(
      ['LOCAL_AI_GATEWAY_HISTORY_TTL_DAYS', 'LOCAL_GPU_GATEWAY_HISTORY_TTL_DAYS'],
      asNumber(queue.history_ttl_days ?? queue.historyTtlDays, 7),
    ),
    host: readStringEnv(
      ['LOCAL_AI_GATEWAY_HOST', 'LOCAL_GPU_GATEWAY_HOST'],
      String(server.host ?? '127.0.0.1'),
    ),
    llamaCliPath: readStringEnv(
      ['LOCAL_AI_GATEWAY_LLAMA_CLI', 'LOCAL_GPU_GATEWAY_LLAMA_CLI'],
      String(paths.llama_cli ?? paths.llamaCli ?? 'llama-cli'),
    ),
    managedRuntimes,
    maxQueue: readNumberEnv(
      ['LOCAL_AI_GATEWAY_MAX_QUEUE', 'LOCAL_GPU_GATEWAY_MAX_QUEUE'],
      asNumber(queue.max_queue ?? queue.maxQueue, 100),
    ),
    maxQueueWaitMs: readNumberEnv(
      ['LOCAL_AI_GATEWAY_MAX_QUEUE_WAIT_MS', 'LOCAL_GPU_GATEWAY_MAX_QUEUE_WAIT_MS'],
      asNumber(queue.max_queue_wait_ms ?? queue.maxQueueWaitMs, 300_000),
    ),
    maxTokens: readNumberEnv(
      ['LOCAL_AI_GATEWAY_MAX_TOKENS', 'LOCAL_GPU_GATEWAY_MAX_TOKENS'],
      asNumber(generation.max_tokens ?? generation.maxTokens, 360),
    ),
    modelSourceDir: resolveMaybeRelative(
      readStringEnv(
        ['LOCAL_AI_GATEWAY_MODEL_SOURCE_DIR', 'LOCAL_GPU_GATEWAY_MODEL_SOURCE_DIR'],
        String(paths.model_source_dir ?? paths.modelSourceDir ?? './runtime/model-source'),
      ),
      configDir,
    ),
    modelsDir,
    openAiUpstreams,
    port: readNumberEnv(
      ['LOCAL_AI_GATEWAY_PORT', 'LOCAL_GPU_GATEWAY_PORT'],
      asNumber(server.port, 8787),
    ),
    repeatPenalty: readNumberEnv(
      ['LOCAL_AI_GATEWAY_REPEAT_PENALTY', 'LOCAL_GPU_GATEWAY_REPEAT_PENALTY'],
      asNumber(generation.repeat_penalty ?? generation.repeatPenalty, 1.0),
    ),
    schedulerPollMs: asNumber(queue.scheduler_poll_ms ?? queue.schedulerPollMs, 250),
    temperature: readNumberEnv(
      ['LOCAL_AI_GATEWAY_TEMPERATURE', 'LOCAL_GPU_GATEWAY_TEMPERATURE'],
      asNumber(generation.temperature, 0.8),
    ),
    timeoutMs,
    topP: readNumberEnv(
      ['LOCAL_AI_GATEWAY_TOP_P', 'LOCAL_GPU_GATEWAY_TOP_P'],
      asNumber(generation.top_p ?? generation.topP, 0.95),
    ),
    waitPollMs: asNumber(queue.wait_poll_ms ?? queue.waitPollMs, 200),
    allowUnmanagedLocalUpstreams,
  };

  validateGatewayConfig(config);
  return config;
}

export const CONFIG_KEYS = {
  DEFAULT_MODEL: 'default_model',
  MAX_QUEUE: 'max_queue',
  HISTORY_TTL_DAYS: 'history_ttl_days',
  MAX_QUEUE_WAIT_MS: 'max_queue_wait_ms',
  MODEL_SOURCE_DIR: 'model_source_dir',
  BACKEND_TIMEOUT_MS: 'backend_timeout_ms',
} as const;

export function initialConfigEntries(config: GatewayConfig): Record<string, string> {
  return {
    [CONFIG_KEYS.DEFAULT_MODEL]: config.defaultModel,
    [CONFIG_KEYS.MAX_QUEUE]: String(config.maxQueue),
    [CONFIG_KEYS.HISTORY_TTL_DAYS]: String(config.historyTtlDays),
    [CONFIG_KEYS.MAX_QUEUE_WAIT_MS]: String(config.maxQueueWaitMs),
    [CONFIG_KEYS.MODEL_SOURCE_DIR]: config.modelSourceDir,
    [CONFIG_KEYS.BACKEND_TIMEOUT_MS]: String(config.timeoutMs),
  };
}
