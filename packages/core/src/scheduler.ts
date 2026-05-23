import { EventEmitter } from 'node:events';
import { GatewayStore } from './db.js';
import { GpuCoordinator } from './gpu-coordinator.js';
import { ModelRegistry } from './model-registry.js';
import {
  ActiveRuntimeSettings,
  GenerationBackend,
  JobRecord,
  QueueStatus,
  SubmitJobInput,
  WaitJobResult,
} from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Scheduler extends EventEmitter {
  private tickHandle: NodeJS.Timeout | null = null;
  private pruneHandle: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private readonly activeJobs = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private readonly store: GatewayStore,
    private readonly registry: ModelRegistry,
    private readonly backend: GenerationBackend,
    private readonly settings: ActiveRuntimeSettings,
    private readonly tickMs: number,
    private readonly waitPollMs: number,
    private readonly gpuCoordinator?: GpuCoordinator,
  ) {
    super();
  }

  start(): void {
    if (this.tickHandle) return;

    this.pruneHandle = setInterval(() => {
      this.store.pruneFinishedJobs(this.settings.historyTtlDays);
    }, 60 * 60 * 1000);

    if (this.gpuCoordinator) {
      return;
    }

    this.tickHandle = setInterval(() => {
      void this.tick();
    }, this.tickMs);

    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.pruneHandle) {
      clearInterval(this.pruneHandle);
      this.pruneHandle = null;
    }
    if (this.activeRun) {
      await this.activeRun.catch(() => undefined);
    }
    if (this.activeJobs.size > 0) {
      await Promise.allSettled(Array.from(this.activeJobs));
    }
  }

  submitJob(input: SubmitJobInput): JobRecord {
    const queued = this.gpuCoordinator
      ? this.store.countPendingGpuWorkItems()
      : this.store.countQueuedJobs();
    if (queued >= this.settings.maxQueue) {
      throw new Error(`Queue full (${queued}/${this.settings.maxQueue})`);
    }

    const requestedPriority = input.requestedPriority ?? 1;
    const effectivePriority = input.source === 'openai' ? 2 : requestedPriority;
    const resolvedModel = input.model?.trim() || this.settings.defaultModel;

    const job = this.store.createJob(
      {
        ...input,
        model: resolvedModel,
        requestedPriority,
      },
      effectivePriority,
      resolvedModel,
    );

    this.emit('job:update', job.id);
    if (this.gpuCoordinator) {
      const activeJob = this.executeJob(job)
        .catch(() => undefined)
        .finally(() => {
          this.activeJobs.delete(activeJob);
        });
      this.activeJobs.add(activeJob);
    } else {
      void this.tick();
    }
    return job;
  }

  getJob(jobId: string): JobRecord | null {
    return this.store.getJobById(jobId);
  }

  listJobs(limit = 100, state?: JobRecord['state']): JobRecord[] {
    return this.store.listJobs(limit, state);
  }

  queueStatus(): QueueStatus {
    return this.store.getQueueStatus(this.settings.maxQueue);
  }

  cancelQueuedJob(jobId: string): JobRecord | null {
    if (this.gpuCoordinator) {
      const workItem = this.gpuCoordinator.cancelPublicJob(jobId, 'Cancelled by user');
      if (!workItem) return null;
      const job = this.store.getJobById(jobId);
      if (job) {
        this.emit('job:update', job.id);
      }
      return job;
    }

    const job = this.store.cancelQueuedJob(jobId);
    if (job) {
      this.emit('job:update', job.id);
    }
    return job;
  }

  async waitForJob(jobId: string, timeoutMs?: number): Promise<WaitJobResult> {
    const started = Date.now();

    while (true) {
      const job = this.store.getJobById(jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (this.isTerminal(job.state)) {
        return { job, timedOut: false };
      }

      if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) {
        return { job, timedOut: true };
      }

      await this.waitForSignalOrPoll(jobId);
    }
  }

  async waitForOpenAiJob(jobId: string, maxQueueWaitMs: number): Promise<WaitJobResult> {
    const queuedAt = Date.now();

    while (true) {
      const job = this.store.getJobById(jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (this.isTerminal(job.state)) {
        return { job, timedOut: false };
      }

      if (!job.startedAt && Date.now() - queuedAt >= maxQueueWaitMs) {
        this.gpuCoordinator?.timeoutPublicJob(jobId, 'Queue wait timeout exceeded');
        const timed = this.store.timeoutJob(jobId) ?? this.store.getJobById(jobId);
        if (timed) {
          this.emit('job:update', jobId);
          return { job: timed, timedOut: true };
        }
      }

      if (job.startedAt) {
        const terminal = await this.waitForJob(jobId);
        return terminal;
      }

      await this.waitForSignalOrPoll(jobId);
    }
  }

  async waitForOpenAiJobStart(jobId: string, maxQueueWaitMs: number): Promise<WaitJobResult> {
    const queuedAt = Date.now();

    while (true) {
      const job = this.store.getJobById(jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (this.isTerminal(job.state) || job.startedAt) {
        return { job, timedOut: false };
      }

      if (Date.now() - queuedAt >= maxQueueWaitMs) {
        this.gpuCoordinator?.timeoutPublicJob(jobId, 'Queue wait timeout exceeded');
        const timed = this.store.timeoutJob(jobId) ?? this.store.getJobById(jobId);
        if (timed) {
          this.emit('job:update', jobId);
          return { job: timed, timedOut: true };
        }
      }

      await this.waitForSignalOrPoll(jobId);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.activeRun) return;

    const next = this.store.startNextQueuedJob();
    if (!next) return;

    this.emit('job:update', next.id);

    this.activeRun = this.executeJob(next)
      .catch(() => undefined)
      .finally(() => {
        this.activeRun = null;
        void this.tick();
      });

    await this.activeRun;
  }

  private async executeJob(job: JobRecord): Promise<void> {
    if (this.gpuCoordinator?.hasModel(job.model)) {
      const started = Date.now();
      try {
        const outputText = await this.gpuCoordinator.generateText(
          job.prompt,
          job.model,
          job.source,
          job.effectivePriority,
          job.id,
          undefined,
          () => {
            this.store.startJob(job.id);
            this.emit('job:update', job.id);
          },
        );
        const completed = this.store.completeJob(job.id, outputText);
        this.store.insertEvent(job.id, 'managed_runtime_result', {
          durationMs: Date.now() - started,
          model: job.model,
        });
        this.emit('job:update', completed.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = this.store.failJob(job.id, message);
        this.emit('job:update', failed.id);
      }
      return;
    }

    const model = this.registry.getModel(job.model);
    if (!model || !model.enabled) {
      const failed = this.store.failJob(job.id, `Model not available: ${job.model}`);
      this.emit('job:update', failed.id);
      return;
    }

    try {
      const generate = () => this.backend.generate({
        prompt: job.prompt,
        modelAlias: job.model,
        adapterPath: model.adapterPath,
      });

      const result = this.gpuCoordinator
        ? await this.gpuCoordinator.runOneShotCommand(
            {
              model: job.model,
              priority: job.effectivePriority,
              publicJobId: job.id,
              source: job.source,
            },
            (signal) => {
              this.store.startJob(job.id);
              this.emit('job:update', job.id);
              return this.backend.generate({
                prompt: job.prompt,
                modelAlias: job.model,
                adapterPath: model.adapterPath,
                signal,
              });
            },
          )
        : await generate();

      const completed = this.store.completeJob(job.id, result.outputText);
      this.store.insertEvent(job.id, 'backend_result', {
        durationMs: result.durationMs,
        rawTail: result.rawTail,
      });
      this.emit('job:update', completed.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.store.failJob(job.id, message);
      this.emit('job:update', failed.id);
    }
  }

  private isTerminal(state: JobRecord['state']): boolean {
    return (
      state === 'succeeded' ||
      state === 'failed' ||
      state === 'cancelled' ||
      state === 'timed_out'
    );
  }

  private async waitForSignalOrPoll(jobId: string): Promise<void> {
    let onUpdate: ((updatedJobId: string) => void) | null = null;

    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          onUpdate = (updatedJobId: string) => {
            if (updatedJobId === jobId) {
              this.off('job:update', onUpdate!);
              resolve();
            }
          };
          this.on('job:update', onUpdate);
        }),
        sleep(this.waitPollMs),
      ]);
    } finally {
      if (onUpdate) {
        this.off('job:update', onUpdate);
      }
    }
  }
}
