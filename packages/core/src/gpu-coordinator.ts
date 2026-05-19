import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { GatewayStore } from './db.js';
import {
  GpuQueueStatusItem,
  GpuWorkItem,
  GpuWorkKind,
  GpuWorkState,
  JobSource,
  ManagedRuntimeConfig,
  ManagedRuntimeState,
  ManagedRuntimeStatus,
  OpenAiUpstreamConfig,
  PriorityTier,
} from './types.js';
import { makeProxyError, proxyOpenAiJson, type ProxyTelemetryCallbacks } from './openai-upstreams.js';

const execFileAsync = promisify(execFile);

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadlineFromNow(ms?: number): string | null {
  if (ms === undefined) return null;
  return new Date(Date.now() + ms).toISOString();
}

function ageMs(iso: string | null): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Date.now() - time);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

class GpuAdmissionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface RuntimeState {
  activeRequests: number;
  activeWorkItemIds: Set<string>;
  config: ManagedRuntimeConfig;
  idleTimer: NodeJS.Timeout | null;
  lastError: string | null;
  lastLoadError: string | null;
  lastUpstreamError: string | null;
  lastUsedAt: string | null;
  loadPhase: string | null;
  loadStartedAt: string | null;
  state: ManagedRuntimeState;
}

interface WorkTelemetry {
  firstByteAt: string | null;
  phase: string;
  requestBytes: number;
  responseBytes: number;
  upstreamName: string | null;
  upstreamStartedAt: string | null;
}

function mergeStopSequences(body: Record<string, unknown>, stopSequences: string[]): Record<string, unknown> {
  if (stopSequences.length === 0) return body;

  const existing = body.stop;
  const merged = new Set<string>(stopSequences);
  if (typeof existing === 'string' && existing.trim()) {
    merged.add(existing);
  } else if (Array.isArray(existing)) {
    for (const item of existing) {
      if (typeof item === 'string' && item.trim()) merged.add(item);
    }
  }

  return {
    ...body,
    stop: Array.from(merged),
  };
}

interface PendingWork {
  clientAbort?: () => void;
  clientSignal?: AbortSignal;
  controller: AbortController;
  kind: GpuWorkKind;
  model: string;
  reject: (error: Error) => void;
  resolve: (lease: GpuLease) => void;
  timeout: NodeJS.Timeout | null;
}

interface GpuLease {
  model: string;
  release: (state?: Exclude<GpuWorkState, 'queued' | 'running'>, errorText?: string) => void;
  runtime?: ManagedRuntimeConfig;
  signal: AbortSignal;
  workItemId: string;
}

interface AcquireOptions {
  maxQueueWaitMs?: number;
  metadata?: Record<string, unknown>;
  model: string;
  priority: PriorityTier;
  publicJobId?: string | null;
  signal?: AbortSignal;
  source: JobSource;
}

export interface GpuCoordinatorHooks {
  isHealthy?: (runtime: ManagedRuntimeConfig) => Promise<boolean>;
  runServiceCommand?: (
    runtime: ManagedRuntimeConfig,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export class GpuCoordinator {
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly pending = new Map<string, PendingWork>();
  private readonly workTelemetry = new Map<string, WorkTelemetry>();
  private activeExclusiveWorkItemId: string | null = null;
  private admitting = false;

  constructor(
    runtimes: ManagedRuntimeConfig[],
    private readonly store: GatewayStore,
    private readonly hooks: GpuCoordinatorHooks = {},
  ) {
    for (const runtime of runtimes) {
      this.runtimes.set(runtime.alias.toLowerCase(), {
        activeRequests: 0,
        activeWorkItemIds: new Set(),
        config: runtime,
        idleTimer: null,
        lastError: null,
        lastLoadError: null,
        lastUpstreamError: null,
        lastUsedAt: null,
        loadPhase: null,
        loadStartedAt: null,
        state: 'unloaded',
      });
    }
  }

  hasModel(model: string | undefined): boolean {
    return Boolean(model && this.runtimes.has(model.toLowerCase()));
  }

  listModels(): string[] {
    return Array.from(this.runtimes.values())
      .filter((runtime) => runtime.config.enabled)
      .map((runtime) => runtime.config.alias)
      .sort();
  }

  listRuntimeModels(): Array<{
    alias: string;
    contextNotes: string | null;
    contextWindow: number | null;
    state: ManagedRuntimeState;
    healthUrl: string;
    upstreamModel: string;
    maxConcurrency: number;
    activeRequests: number;
    recommendedPromptBudget: number | null;
    supportsReasoning: boolean;
    supportsStreaming: boolean;
  }> {
    return Array.from(this.runtimes.values())
      .map((runtime) => ({
        activeRequests: runtime.activeRequests,
        alias: runtime.config.alias,
        contextNotes: runtime.config.contextNotes,
        contextWindow: runtime.config.contextWindow,
        healthUrl: runtime.config.healthUrl,
        maxConcurrency: runtime.config.maxConcurrency,
        recommendedPromptBudget: runtime.config.recommendedPromptBudget,
        state: runtime.state,
        supportsReasoning: runtime.config.supportsReasoning,
        supportsStreaming: runtime.config.supportsStreaming,
        upstreamModel: runtime.config.upstreamModel,
      }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
  }

  status(): {
    active_work: Array<Record<string, unknown>>;
    gpu_queue: GpuQueueStatusItem[];
    loaded_model: string | null;
    loading_model: string | null;
    managed_runtimes: ManagedRuntimeStatus[];
  } {
    const queued = this.store.listGpuWorkItems(500).filter((item) => (
      item.state === 'queued' || item.state === 'running'
    ));

    const queue = queued
      .map((item) => ({
        ageMs: ageMs(item.createdAt) ?? 0,
        createdAt: item.createdAt,
        deadlineAt: item.deadlineAt,
        id: item.id,
        model: item.model,
        priority: item.priority,
        publicJobId: item.publicJobId,
        source: item.source,
        state: item.state,
        type: item.kind,
        ...this.telemetryStatus(item.id),
      }))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));

    const runtimes = Array.from(this.runtimes.values())
      .map((runtime) => ({
        activeRequests: runtime.activeRequests,
        activeWorkItemIds: Array.from(runtime.activeWorkItemIds).sort(),
        alias: runtime.config.alias,
        baseUrl: runtime.config.baseUrl,
        enabled: runtime.config.enabled,
        healthUrl: runtime.config.healthUrl,
        idleTtlMs: runtime.config.idleTtlMs,
        lastError: runtime.lastError,
        lastLoadError: runtime.lastLoadError,
        lastUpstreamError: runtime.lastUpstreamError,
        lastUsedAt: runtime.lastUsedAt,
        ...this.runtimeLoadStatus(runtime),
        loadTimeoutMs: runtime.config.loadTimeoutMs,
        maxConcurrency: runtime.config.maxConcurrency,
        queuedRequests: this.store
          .listQueuedGpuWorkItems()
          .filter((item) => item.model.toLowerCase() === runtime.config.alias.toLowerCase())
          .length,
        state: runtime.state,
        upstreamModel: runtime.config.upstreamModel,
      }))
      .sort((a, b) => a.alias.localeCompare(b.alias));

    const activeWork = this.store.listRunningGpuWorkItems().map((item) => ({
      activeDurationMs: ageMs(item.startedAt),
      ageMs: ageMs(item.createdAt) ?? 0,
      id: item.id,
      kind: item.kind,
      model: item.model,
      priority: item.priority,
      publicJobId: item.publicJobId,
      source: item.source,
      state: item.state,
      type: item.kind,
      ...this.telemetryStatus(item.id),
    }));

    return {
      active_work: activeWork,
      gpu_queue: queue,
      loaded_model: this.loadedRuntimeModel(),
      loading_model: this.loadingRuntimeModel(),
      managed_runtimes: runtimes,
    };
  }

  async proxyChatCompletions(
    body: Record<string, unknown>,
    model: string,
    source: JobSource,
    priority: PriorityTier,
    maxQueueWaitMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.proxyRuntime('/chat/completions', body, model, source, priority, maxQueueWaitMs, signal);
  }

  async proxyResponses(
    body: Record<string, unknown>,
    model: string,
    source: JobSource,
    priority: PriorityTier,
    maxQueueWaitMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.proxyRuntime('/responses', body, model, source, priority, maxQueueWaitMs, signal);
  }

  async generateText(
    prompt: string,
    model: string,
    source: JobSource,
    priority: PriorityTier,
    publicJobId?: string | null,
    signal?: AbortSignal,
    onAdmitted?: () => void,
  ): Promise<string> {
    return this.withRuntime(
      { model, priority, publicJobId, signal, source },
      async (runtime, runtimeSignal, lease) => {
        onAdmitted?.();
        const parsed = await this.callRuntimeChatJson(
          runtime,
          {
            messages: [{ content: prompt, role: 'user' }],
            model,
            stream: false,
          },
          runtimeSignal,
          lease.workItemId,
        );

        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content === 'string') return content;

        const outputText = parsed.output?.[0]?.content?.[0]?.text;
        if (typeof outputText === 'string') return outputText;

        return JSON.stringify(parsed);
      },
    );
  }

  async withRuntime<T>(
    options: AcquireOptions,
    handler: (runtime: ManagedRuntimeConfig, signal: AbortSignal, lease: GpuLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire('runtime', options);
    let releaseState: Exclude<GpuWorkState, 'queued' | 'running'> = 'succeeded';
    let errorText: string | undefined;
    try {
      return await handler(lease.runtime!, lease.signal, lease);
    } catch (error) {
      const runtime = lease.runtime ? this.getRuntime(lease.runtime.alias) : null;
      releaseState = lease.signal.aborted ? 'cancelled' : 'failed';
      errorText = error instanceof Error ? error.message : String(error);
      if (runtime) {
        runtime.lastUpstreamError = errorText;
      }
      throw error;
    } finally {
      lease.release(releaseState, errorText);
    }
  }

  async runExclusive<T>(
    options: AcquireOptions,
    handler: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire('exclusive', options);
    let releaseState: Exclude<GpuWorkState, 'queued' | 'running'> = 'succeeded';
    let errorText: string | undefined;
    try {
      return await handler(lease.signal);
    } catch (error) {
      releaseState = lease.signal.aborted ? 'cancelled' : 'failed';
      errorText = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      lease.release(releaseState, errorText);
    }
  }

  cancelRuntimeRequest(workItemId: string, reason = 'Cancelled by user'): GpuWorkItem | null {
    return this.cancelWorkItem(workItemId, reason, 'cancelled');
  }

  cancelPublicJob(publicJobId: string, reason = 'Cancelled by user'): GpuWorkItem | null {
    const workItem = this.store.getGpuWorkItemForPublicJob(publicJobId);
    if (!workItem) return null;
    return this.cancelWorkItem(workItem.id, reason, 'cancelled');
  }

  timeoutPublicJob(publicJobId: string, reason = 'Queue wait timeout exceeded'): GpuWorkItem | null {
    const workItem = this.store.getGpuWorkItemForPublicJob(publicJobId);
    if (!workItem) return null;
    return this.cancelWorkItem(workItem.id, reason, 'timed_out');
  }

  async forceUnloadRuntime(alias: string, reason = 'Force unload requested'): Promise<Record<string, unknown>> {
    const runtime = this.getRuntime(alias);
    const affected = Array.from(runtime.activeWorkItemIds);
    for (const workItemId of affected) {
      this.cancelWorkItem(workItemId, reason, 'failed');
    }
    runtime.activeRequests = 0;
    runtime.activeWorkItemIds.clear();
    await this.stopRuntime(runtime, true);
    this.pump();
    return {
      alias: runtime.config.alias,
      affected_work_item_ids: affected,
      state: runtime.state,
    };
  }

  private async proxyRuntime(
    path: '/chat/completions' | '/responses',
    body: Record<string, unknown>,
    model: string,
    source: JobSource,
    priority: PriorityTier,
    maxQueueWaitMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lease: GpuLease;
    try {
      lease = await this.acquire('runtime', {
        maxQueueWaitMs,
        metadata: { endpoint: `/v1${path}` },
        model,
        priority,
        signal,
        source,
      });
    } catch (error) {
      if (error instanceof GpuAdmissionError) {
        return makeProxyError(error.status, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return makeProxyError(503, message);
    }

    try {
      const upstream = this.runtimeToUpstream(lease.runtime!);
      const requestBody = mergeStopSequences(body, lease.runtime!.stopSequences);
      const telemetry = this.proxyTelemetryCallbacks(lease.workItemId);
      this.updateTelemetry(lease.workItemId, {
        phase: 'prefill',
        upstreamStartedAt: nowIso(),
      });
      const response = await proxyOpenAiJson(
        [upstream],
        path,
        requestBody,
        model,
        lease.signal,
        () => lease.release(lease.signal.aborted ? 'cancelled' : 'succeeded'),
        telemetry,
      );
      if (!response.ok) {
        this.getRuntime(model).lastUpstreamError = `HTTP ${response.status}`;
      } else {
        this.getRuntime(model).lastUpstreamError = null;
      }
      return response;
    } catch (error) {
      lease.release('failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private acquire(type: GpuWorkKind, options: AcquireOptions): Promise<GpuLease> {
    const model = options.model.trim();
    if (type === 'runtime' && !this.hasModel(model)) {
      return Promise.reject(new GpuAdmissionError(`No managed runtime configured for model: ${model}`, 404));
    }

    if (options.signal?.aborted) {
      return Promise.reject(new GpuAdmissionError('Client cancelled request', 499));
    }

    const workItem = this.store.createGpuWorkItem({
      deadlineAt: deadlineFromNow(options.maxQueueWaitMs),
      kind: type,
      metadata: options.metadata,
      model,
      priority: options.priority,
      publicJobId: options.publicJobId,
      source: options.source,
    });
    this.workTelemetry.set(workItem.id, {
      firstByteAt: null,
      phase: 'queued',
      requestBytes: 0,
      responseBytes: 0,
      upstreamName: null,
      upstreamStartedAt: null,
    });

    return new Promise<GpuLease>((resolve, reject) => {
      const controller = new AbortController();
      const pending: PendingWork = {
        controller,
        kind: type,
        model,
        reject,
        resolve,
        timeout: null,
      };

      const onClientAbort = () => {
        this.cancelWorkItem(workItem.id, 'Client cancelled request', 'cancelled');
      };
      if (options.signal) {
        pending.clientAbort = onClientAbort;
        pending.clientSignal = options.signal;
        options.signal.addEventListener('abort', onClientAbort, { once: true });
      }

      if (options.maxQueueWaitMs !== undefined) {
        pending.timeout = setTimeout(() => {
          this.cancelWorkItem(workItem.id, 'GPU queue wait timeout exceeded', 'timed_out');
        }, options.maxQueueWaitMs);
        pending.timeout.unref?.();
      }

      this.pending.set(workItem.id, pending);
      this.pump();
    });
  }

  private pump(): void {
    if (this.admitting || this.activeExclusiveWorkItemId) return;
    const item = this.takeNextAdmissibleQueued();
    if (!item) return;

    this.admitting = true;
    void this.admit(item).finally(() => {
      this.admitting = false;
      this.pump();
    });
  }

  private async admit(item: GpuWorkItem): Promise<void> {
    const pending = this.pending.get(item.id);
    if (!pending) return;
    this.clearPendingTimeout(pending);

    if (pending.controller.signal.aborted) {
      pending.reject(new GpuAdmissionError('Client cancelled request', 499));
      this.cleanupPending(item.id);
      return;
    }

    const running = this.store.startGpuWorkItem(item.id);
    if (!running) {
      pending.reject(new GpuAdmissionError(`GPU work item is no longer queued: ${item.id}`, 409));
      this.cleanupPending(item.id);
      return;
    }

    try {
      if (item.kind === 'runtime') {
        this.updateTelemetry(item.id, { phase: 'loading_model' });
        const runtime = await this.ensureRuntimeReady(item.model, pending.controller.signal);
        if (pending.controller.signal.aborted) {
          this.store.finishGpuWorkItem(item.id, 'cancelled', 'Client cancelled request');
          this.scheduleIdleUnload(runtime);
          pending.reject(new GpuAdmissionError('Client cancelled request', 499));
          this.cleanupPending(item.id);
          return;
        }

        runtime.activeRequests += 1;
        runtime.activeWorkItemIds.add(item.id);
        runtime.lastUsedAt = nowIso();
        this.updateTelemetry(item.id, { phase: 'admitted' });
        pending.resolve({
          model: runtime.config.alias,
          release: this.once((state = 'succeeded', errorText?: string) => {
            runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
            runtime.activeWorkItemIds.delete(item.id);
            runtime.lastUsedAt = nowIso();
            if (state === 'failed') runtime.lastError = errorText ?? 'Runtime request failed';
            this.store.finishGpuWorkItem(item.id, state, errorText);
            this.cleanupPending(item.id);
            this.scheduleIdleUnload(runtime);
            this.pump();
          }),
          runtime: runtime.config,
          signal: pending.controller.signal,
          workItemId: item.id,
        });
        return;
      }

      await this.unloadLoadedRuntime();
      if (pending.controller.signal.aborted) {
        this.store.finishGpuWorkItem(item.id, 'cancelled', 'Client cancelled request');
        pending.reject(new GpuAdmissionError('Client cancelled request', 499));
        this.cleanupPending(item.id);
        return;
      }

      this.activeExclusiveWorkItemId = item.id;
      this.updateTelemetry(item.id, { phase: 'exclusive_running' });
      pending.resolve({
        model: item.model,
        release: this.once((state = 'succeeded', errorText?: string) => {
          if (this.activeExclusiveWorkItemId === item.id) {
            this.activeExclusiveWorkItemId = null;
          }
          this.store.finishGpuWorkItem(item.id, state, errorText);
          this.cleanupPending(item.id);
          this.pump();
        }),
        signal: pending.controller.signal,
        workItemId: item.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.finishGpuWorkItem(item.id, 'failed', message);
      pending.reject(
        error instanceof GpuAdmissionError ? error : new GpuAdmissionError(message, 503),
      );
      this.cleanupPending(item.id);
    }
  }

  private async ensureRuntimeReady(model: string, signal?: AbortSignal): Promise<RuntimeState> {
    const runtime = this.getRuntime(model);
    this.clearIdleTimer(runtime);

    if (runtime.state === 'loaded' && await this.isHealthy(runtime.config)) {
      runtime.lastError = null;
      runtime.loadPhase = 'ready';
      runtime.loadStartedAt = null;
      return runtime;
    }

    if (await this.isHealthy(runtime.config)) {
      await this.unloadLoadedRuntime(runtime.config.alias);
      runtime.state = 'loaded';
      runtime.lastError = null;
      runtime.lastLoadError = null;
      runtime.loadPhase = 'ready';
      runtime.loadStartedAt = null;
      runtime.lastUsedAt = nowIso();
      return runtime;
    }

    await this.unloadLoadedRuntime(runtime.config.alias);

    if (signal?.aborted) {
      throw new GpuAdmissionError('Client cancelled request', 499);
    }

    runtime.state = 'loading';
    runtime.lastError = null;
    runtime.lastLoadError = null;
    runtime.loadPhase = 'starting_service';
    runtime.loadStartedAt = nowIso();
    try {
      await this.runServiceCommand(
        runtime.config,
        runtime.config.startArgs,
        runtime.config.loadTimeoutMs,
        signal,
      );
      runtime.loadPhase = 'waiting_for_health';
      await this.waitForHealth(runtime.config, true, runtime.config.loadTimeoutMs, signal);
      runtime.state = 'loaded';
      runtime.lastError = null;
      runtime.lastLoadError = null;
      runtime.loadPhase = 'ready';
      runtime.loadStartedAt = null;
      runtime.lastUsedAt = nowIso();
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.state = 'failed';
      runtime.lastError = message;
      runtime.lastLoadError = message;
      runtime.loadPhase = 'failed';
      if (error instanceof GpuAdmissionError) {
        throw error;
      }
      throw new Error(`Model ${runtime.config.alias} failed to load: ${message}`);
    }
  }

  private async unloadLoadedRuntime(exceptAlias?: string): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (exceptAlias && runtime.config.alias.toLowerCase() === exceptAlias.toLowerCase()) continue;
      if (runtime.activeRequests > 0) {
        throw new Error(`Cannot unload active runtime: ${runtime.config.alias}`);
      }
      if (runtime.state !== 'loaded' && !await this.isHealthy(runtime.config)) {
        if (runtime.state !== 'failed') runtime.state = 'unloaded';
        if (runtime.state === 'unloaded') {
          runtime.loadPhase = null;
          runtime.loadStartedAt = null;
        }
        continue;
      }

      await this.stopRuntime(runtime);
    }
  }

  private async stopRuntime(runtime: RuntimeState, force = false): Promise<void> {
    this.clearIdleTimer(runtime);
    if (runtime.activeRequests > 0 && !force) return;

    runtime.state = 'unloading';
    runtime.loadPhase = 'unloading';
    runtime.loadStartedAt = null;
    try {
      await this.runServiceCommand(runtime.config, runtime.config.stopArgs, runtime.config.stopTimeoutMs);
      await this.waitForHealth(runtime.config, false, runtime.config.stopTimeoutMs);
      runtime.state = 'unloaded';
      runtime.lastError = null;
      runtime.loadPhase = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.state = 'failed';
      runtime.lastError = message;
      runtime.loadPhase = 'failed';
    }
  }

  private scheduleIdleUnload(runtime: RuntimeState): void {
    this.clearIdleTimer(runtime);
    if (runtime.activeRequests > 0 || runtime.state !== 'loaded') return;

    runtime.idleTimer = setTimeout(() => {
      if (runtime.activeRequests > 0 || this.store.countPendingGpuWorkItems() > 0) {
        this.pump();
        return;
      }
      void this.stopRuntime(runtime).finally(() => this.pump());
    }, runtime.config.idleTtlMs);
    runtime.idleTimer.unref?.();
  }

  private async waitForHealth(
    runtime: ManagedRuntimeConfig,
    expectedHealthy: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) {
        throw new GpuAdmissionError('Client cancelled request', 499);
      }
      const healthy = await this.isHealthy(runtime);
      if (healthy === expectedHealthy) return;
      await sleep(1000);
    }
    const action = expectedHealthy ? 'load' : 'unload';
    const target = expectedHealthy ? 'ready' : 'stopped';
    throw new GpuAdmissionError(
      `Model ${runtime.alias} ${action} timeout after ${timeoutMs}ms: health did not become ${target} at ${runtime.healthUrl}`,
      expectedHealthy ? 504 : 503,
    );
  }

  private async isHealthy(runtime: ManagedRuntimeConfig): Promise<boolean> {
    if (this.hooks.isHealthy) {
      return this.hooks.isHealthy(runtime);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(runtime.healthUrl, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runServiceCommand(
    runtime: ManagedRuntimeConfig,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new GpuAdmissionError('Client cancelled request', 499);
    }

    if (this.hooks.runServiceCommand) {
      await this.hooks.runServiceCommand(runtime, args, timeoutMs, signal);
      return;
    }

    try {
      await execFileAsync(runtime.serviceScript, args, {
        cwd: dirname(runtime.serviceScript),
        signal,
        timeout: timeoutMs,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'stderr' in error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
        if (stderr) throw new Error(stderr);
      }
      throw error;
    }
  }

  private runtimeToUpstream(runtime: ManagedRuntimeConfig): OpenAiUpstreamConfig {
    return {
      apiKey: '',
      apiKeyEnv: '',
      baseUrl: runtime.baseUrl,
      models: [runtime.alias],
      name: runtime.alias,
      timeoutMs: runtime.loadTimeoutMs,
      upstreamModel: runtime.upstreamModel,
    };
  }

  private async callRuntimeChatJson(
    runtime: ManagedRuntimeConfig,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    workItemId?: string,
  ): Promise<{
    choices?: Array<{ message?: { content?: unknown } }>;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Upstream ${runtime.alias} timeout after ${runtime.loadTimeoutMs}ms`)),
      runtime.loadTimeoutMs,
    );
    const abort = () => controller.abort(signal?.reason ?? new Error('Request cancelled'));
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const requestBody = JSON.stringify({
        ...mergeStopSequences(body, runtime.stopSequences),
        model: runtime.upstreamModel || body.model,
      });
      if (workItemId) {
        this.updateTelemetry(workItemId, {
          phase: 'prefill',
          requestBytes: byteLength(requestBody),
          upstreamName: runtime.alias,
          upstreamStartedAt: nowIso(),
        });
      }
      const response = await fetch(`${runtime.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        body: requestBody,
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      });
      if (workItemId) {
        this.markFirstByte(workItemId);
      }
      const text = await response.text();
      if (workItemId) {
        this.addResponseBytes(workItemId, byteLength(text));
      }
      if (!response.ok) {
        this.getRuntime(runtime.alias).lastUpstreamError = `HTTP ${response.status}: ${text.slice(0, 500)}`;
        throw new Error(`Managed runtime request failed (${response.status}): ${text.slice(0, 500)}`);
      }
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  private runtimeLoadStatus(runtime: RuntimeState): {
    loadElapsedMs: number | null;
    loadPhase: string | null;
    loadProgress: number | null;
    loadStartedAt: string | null;
  } {
    if (runtime.state === 'loaded') {
      return {
        loadElapsedMs: null,
        loadPhase: runtime.loadPhase ?? 'ready',
        loadProgress: 1,
        loadStartedAt: null,
      };
    }

    if (runtime.state !== 'loading' || !runtime.loadStartedAt) {
      return {
        loadElapsedMs: null,
        loadPhase: runtime.loadPhase,
        loadProgress: null,
        loadStartedAt: runtime.loadStartedAt,
      };
    }

    const elapsed = ageMs(runtime.loadStartedAt) ?? 0;
    return {
      loadElapsedMs: elapsed,
      loadPhase: runtime.loadPhase,
      loadProgress: clamp(elapsed / Math.max(runtime.config.loadTimeoutMs, 1), 0.02, 0.98),
      loadStartedAt: runtime.loadStartedAt,
    };
  }

  private telemetryStatus(workItemId: string): {
    bandwidthBps: number;
    phase: string;
    requestBytes: number;
    responseBytes: number;
    timeToFirstByteMs: number | null;
    upstreamElapsedMs: number | null;
    upstreamName: string | null;
  } {
    const telemetry = this.workTelemetry.get(workItemId);
    if (!telemetry) {
      return {
        bandwidthBps: 0,
        phase: 'unknown',
        requestBytes: 0,
        responseBytes: 0,
        timeToFirstByteMs: null,
        upstreamElapsedMs: null,
        upstreamName: null,
      };
    }

    const startedAt = telemetry.upstreamStartedAt;
    const elapsed = ageMs(startedAt);
    const firstByte = telemetry.firstByteAt && startedAt
      ? Math.max(0, Date.parse(telemetry.firstByteAt) - Date.parse(startedAt))
      : null;
    const bytes = telemetry.requestBytes + telemetry.responseBytes;
    const seconds = elapsed && elapsed > 0 ? elapsed / 1000 : 0;
    return {
      bandwidthBps: seconds > 0 ? Math.round(bytes / seconds) : 0,
      phase: telemetry.phase,
      requestBytes: telemetry.requestBytes,
      responseBytes: telemetry.responseBytes,
      timeToFirstByteMs: firstByte,
      upstreamElapsedMs: elapsed,
      upstreamName: telemetry.upstreamName,
    };
  }

  private updateTelemetry(workItemId: string, patch: Partial<WorkTelemetry>): void {
    const telemetry = this.workTelemetry.get(workItemId);
    if (!telemetry) return;
    this.workTelemetry.set(workItemId, { ...telemetry, ...patch });
  }

  private addResponseBytes(workItemId: string, bytes: number): void {
    const telemetry = this.workTelemetry.get(workItemId);
    if (!telemetry) return;
    this.workTelemetry.set(workItemId, {
      ...telemetry,
      phase: telemetry.firstByteAt ? 'streaming' : 'receiving',
      responseBytes: telemetry.responseBytes + bytes,
    });
  }

  private markFirstByte(workItemId: string): void {
    const telemetry = this.workTelemetry.get(workItemId);
    if (!telemetry) return;
    this.workTelemetry.set(workItemId, {
      ...telemetry,
      firstByteAt: telemetry.firstByteAt ?? nowIso(),
      phase: 'streaming',
    });
  }

  private proxyTelemetryCallbacks(workItemId: string): ProxyTelemetryCallbacks {
    return {
      onFirstByte: () => this.markFirstByte(workItemId),
      onRequestBytes: (bytes) => {
        const telemetry = this.workTelemetry.get(workItemId);
        if (!telemetry) return;
        this.workTelemetry.set(workItemId, {
          ...telemetry,
          requestBytes: telemetry.requestBytes + bytes,
        });
      },
      onResponseBytes: (bytes) => this.addResponseBytes(workItemId, bytes),
      onUpstreamSelected: (upstreamName) => this.updateTelemetry(workItemId, { upstreamName }),
    };
  }

  private getRuntime(model: string): RuntimeState {
    const runtime = this.runtimes.get(model.toLowerCase());
    if (!runtime) throw new Error(`No managed runtime configured for model: ${model}`);
    return runtime;
  }

  private loadedRuntimeModel(): string | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.state === 'loaded') return runtime.config.alias;
    }
    return null;
  }

  private loadingRuntimeModel(): string | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.state === 'loading') return runtime.config.alias;
    }
    return null;
  }

  private activeRuntimeModel(): string | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.activeRequests > 0) {
        return runtime.config.alias;
      }
    }
    return null;
  }

  private takeNextAdmissibleQueued(): GpuWorkItem | null {
    const queued = this.store.listQueuedGpuWorkItems();
    for (const item of queued) {
      const pending = this.pending.get(item.id);
      if (!pending) continue;
      if (item.deadlineAt && Date.parse(item.deadlineAt) <= Date.now()) {
        this.cancelWorkItem(item.id, 'GPU queue wait timeout exceeded', 'timed_out');
        continue;
      }

      const activeModel = this.activeRuntimeModel();
      if (!activeModel) {
        return item;
      }

      if (item.kind !== 'runtime') {
        return null;
      }

      if (item.model.toLowerCase() !== activeModel.toLowerCase()) {
        return null;
      }

      const runtime = this.getRuntime(activeModel);
      if (runtime.activeRequests >= runtime.config.maxConcurrency) {
        return null;
      }

      return item;
    }
    return null;
  }

  private cancelWorkItem(
    workItemId: string,
    reason: string,
    state: 'cancelled' | 'failed' | 'timed_out',
  ): GpuWorkItem | null {
    const item = this.store.getGpuWorkItemById(workItemId);
    if (!item) return null;

    const pending = this.pending.get(workItemId);
    const finished = this.store.finishGpuWorkItem(workItemId, state, reason);
    if (pending) {
      pending.controller.abort(new Error(reason));
      if (item.state === 'queued') {
        const status = state === 'timed_out' ? 504 : state === 'cancelled' ? 499 : 503;
        pending.reject(new GpuAdmissionError(reason, status));
        this.cleanupPending(workItemId);
      }
    }

    if (item.publicJobId && state === 'cancelled') {
      this.store.cancelJob(item.publicJobId, reason);
    } else if (item.publicJobId && state === 'failed') {
      this.store.failJob(item.publicJobId, reason);
    } else if (item.publicJobId && state === 'timed_out') {
      this.store.timeoutJob(item.publicJobId, reason);
    }

    this.pump();
    return finished;
  }

  private cleanupPending(workItemId: string): void {
    const pending = this.pending.get(workItemId);
    if (!pending) return;
    this.clearPendingTimeout(pending);
    if (pending.clientAbort) {
      pending.clientSignal?.removeEventListener('abort', pending.clientAbort);
    }
    this.pending.delete(workItemId);
    this.workTelemetry.delete(workItemId);
  }

  private clearPendingTimeout(pending: PendingWork): void {
    if (!pending.timeout) return;
    clearTimeout(pending.timeout);
    pending.timeout = null;
  }

  private clearIdleTimer(runtime: RuntimeState): void {
    if (!runtime.idleTimer) return;
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }

  private once<T extends (...args: never[]) => void>(fn: T): T {
    let called = false;
    return ((...args: Parameters<T>) => {
      if (called) return;
      called = true;
      fn(...args);
    }) as T;
  }
}
