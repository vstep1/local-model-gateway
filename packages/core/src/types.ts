export type JobSource = 'openai' | 'mcp';

// Internal SQLite scheduler discriminator. Public status uses runtime adapter/mode fields.
export type GpuWorkKind = 'runtime' | 'exclusive';
export type RuntimeAdapterKind = 'openai_service' | 'llama_cli';
export type RuntimeMode = 'resident_service' | 'one_shot_command';
export type RuntimeTimelineEventType =
  | 'work_queued'
  | 'work_started'
  | 'work_succeeded'
  | 'work_failed'
  | 'work_cancelled'
  | 'work_timed_out'
  | 'runtime_adopted_loaded'
  | 'runtime_load_started'
  | 'runtime_load_succeeded'
  | 'runtime_load_failed'
  | 'runtime_unload_started'
  | 'runtime_unload_succeeded'
  | 'runtime_unload_failed';

export type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type PriorityTier = 0 | 1 | 2;

export type GpuWorkState = JobState;

export interface JobRecord {
  id: string;
  source: JobSource;
  state: JobState;
  requestedPriority: PriorityTier;
  effectivePriority: PriorityTier;
  model: string;
  prompt: string;
  metadataJson: string;
  resultText: string | null;
  errorText: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobEventRecord {
  id: number;
  jobId: string;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

export interface SubmitJobInput {
  source: JobSource;
  requestedPriority?: PriorityTier;
  model?: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface GenerationOverrides {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  repeatPenalty?: number;
}

export interface QueueStatus {
  queued: number;
  running: number;
  maxQueue: number;
  newestQueuedAt: string | null;
  oldestQueuedAt: string | null;
}

export interface GpuWorkItem {
  id: string;
  source: JobSource;
  model: string;
  kind: GpuWorkKind;
  priority: PriorityTier;
  state: GpuWorkState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  publicJobId: string | null;
  metadataJson: string;
  errorText: string | null;
}

export interface RuntimeTimelineEvent {
  id: number;
  eventType: RuntimeTimelineEventType;
  runtimeAlias: string | null;
  workItemId: string | null;
  source: JobSource | null;
  state: GpuWorkState | ManagedRuntimeState | null;
  message: string;
  metadataJson: string;
  createdAt: string;
}

export interface CreateRuntimeTimelineEventInput {
  eventType: RuntimeTimelineEventType;
  runtimeAlias?: string | null;
  workItemId?: string | null;
  source?: JobSource | null;
  state?: GpuWorkState | ManagedRuntimeState | null;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ListRuntimeTimelineEventsOptions {
  limit?: number;
  runtimeAlias?: string;
  workItemId?: string;
}

export interface CreateGpuWorkItemInput {
  source: JobSource;
  model: string;
  kind: GpuWorkKind;
  priority: PriorityTier;
  deadlineAt?: string | null;
  publicJobId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ModelRecord {
  alias: string;
  adapterPath: string;
  sourcePath: string;
  managedPath: string;
  checksumSha256: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigRecord {
  key: string;
  value: string;
  updatedAt: string;
}

export interface GatewayConfig {
  authToken: string;
  host: string;
  port: number;
  configPath: string | null;
  dbPath: string;
  dataDir: string;
  modelsDir: string;
  modelSourceDir: string;
  defaultModel: string;
  maxQueue: number;
  historyTtlDays: number;
  maxQueueWaitMs: number;
  llamaCliPath: string;
  baseModelPath: string;
  ctxSize: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  repeatPenalty: number;
  gpuLayers: string;
  timeoutMs: number;
  schedulerPollMs: number;
  waitPollMs: number;
  openAiUpstreams: OpenAiUpstreamConfig[];
  managedRuntimes: ManagedRuntimeConfig[];
  allowUnmanagedLocalUpstreams: boolean;
  startupModels: Record<string, string>;
}

export interface OpenAiUpstreamConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  models: string[];
  upstreamModel: string;
  timeoutMs: number;
}

export interface ManagedRuntimeConfig {
  alias: string;
  baseUrl: string;
  contextNotes: string | null;
  contextWindow: number | null;
  enabled: boolean;
  healthUrl: string;
  idleTtlMs: number;
  loadProgressPath: string | null;
  loadTimeoutMs: number;
  maxConcurrency: number;
  serviceScript: string;
  startArgs: string[];
  stopArgs: string[];
  stopTimeoutMs: number;
  stopSequences: string[];
  recommendedPromptBudget: number | null;
  supportsReasoning: boolean;
  supportsStreaming: boolean;
  upstreamModel: string;
}

export type ManagedRuntimeState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'failed';

export interface RuntimeProgressTelemetry {
  loadPhase: string | null;
  loadProgress: number | null;
  prefillProgress: number | null;
  prefillTaskId: number | null;
  prefillTokensDone: number | null;
  prefillTokensTotal: number | null;
  telemetryUpdatedAt: string | null;
}

export interface ManagedRuntimeStatus {
  activeRequests: number;
  activeWorkItemIds: string[];
  alias: string;
  baseUrl: string;
  enabled: boolean;
  healthUrl: string;
  idleTtlMs: number;
  lastLoadError: string | null;
  lastError: string | null;
  lastUpstreamError: string | null;
  lastUsedAt: string | null;
  loadElapsedMs: number | null;
  loadPhase: string | null;
  loadProgress: number | null;
  loadProgressSource: string | null;
  loadStartedAt: string | null;
  loadTimeoutMs: number;
  maxConcurrency: number;
  prefillInputDone: number | null;
  prefillInputTotal: number | null;
  prefillProgress: number | null;
  prefillTaskId: number | null;
  queuedRequests: number;
  state: ManagedRuntimeState;
  telemetryUpdatedAt: string | null;
  upstreamModel: string;
}

export interface GpuQueueStatusItem {
  activeDurationMs?: number | null;
  ageMs: number;
  bandwidthBps?: number;
  createdAt: string;
  deadlineAt: string | null;
  errorText?: string | null;
  failureCategory?: string | null;
  finishedAt?: string | null;
  id: string;
  model: string;
  phase?: string;
  priority: PriorityTier;
  publicJobId: string | null;
  prefillInputDone?: number | null;
  prefillInputTotal?: number | null;
  prefillProgress?: number | null;
  prefillTaskId?: number | null;
  requestBytes?: number;
  responseBytes?: number;
  runtimeAdapter: RuntimeAdapterKind;
  runtimeAlias: string;
  runtimeMode: RuntimeMode;
  source: JobSource;
  startedAt?: string | null;
  state: GpuWorkState;
  timeToFirstByteMs?: number | null;
  upstreamElapsedMs?: number | null;
  upstreamName?: string | null;
}

export interface ActiveRuntimeSettings {
  defaultModel: string;
  maxQueue: number;
  historyTtlDays: number;
  maxQueueWaitMs: number;
  modelSourceDir: string;
  backendTimeoutMs: number;
}

export interface GenerationRequest {
  prompt: string;
  modelAlias: string;
  adapterPath: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  repeatPenalty?: number;
  signal?: AbortSignal;
}

export interface GenerationResult {
  outputText: string;
  rawTail: string;
  durationMs: number;
}

export interface GenerationBackend {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

export interface WaitJobResult {
  job: JobRecord;
  timedOut: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
}
