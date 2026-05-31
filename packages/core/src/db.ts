import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {
  ActiveRuntimeSettings,
  CreateGpuWorkItemInput,
  CreateRuntimeTimelineEventInput,
  GpuWorkItem,
  GpuWorkState,
  JobRecord,
  JobState,
  ListRuntimeTimelineEventsOptions,
  ModelRecord,
  QueueStatus,
  RuntimeTimelineEvent,
  SubmitJobInput,
} from './types.js';
import { CONFIG_KEYS } from './config.js';
import { nowIso } from './utils.js';

interface JobRow {
  id: string;
  source: string;
  state: JobState;
  requested_priority: number;
  effective_priority: number;
  model: string;
  prompt: string;
  metadata_json: string;
  result_text: string | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ModelRow {
  alias: string;
  adapter_path: string;
  source_path: string;
  managed_path: string;
  checksum_sha256: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface GpuWorkItemRow {
  id: string;
  source: string;
  model: string;
  kind: string;
  priority: number;
  state: GpuWorkState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  deadline_at: string | null;
  public_job_id: string | null;
  metadata_json: string;
  error_text: string | null;
}

interface RuntimeTimelineEventRow {
  id: number;
  event_type: RuntimeTimelineEvent['eventType'];
  runtime_alias: string | null;
  work_item_id: string | null;
  source: RuntimeTimelineEvent['source'];
  state: RuntimeTimelineEvent['state'];
  message: string;
  metadata_json: string;
  created_at: string;
}

const TERMINAL_STATES: JobState[] = ['succeeded', 'failed', 'cancelled', 'timed_out'];

function mapJobRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    source: row.source as JobRecord['source'],
    state: row.state,
    requestedPriority: row.requested_priority as JobRecord['requestedPriority'],
    effectivePriority: row.effective_priority as JobRecord['effectivePriority'],
    model: row.model,
    prompt: row.prompt,
    metadataJson: row.metadata_json,
    resultText: row.result_text,
    errorText: row.error_text,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapModelRow(row: ModelRow): ModelRecord {
  return {
    alias: row.alias,
    adapterPath: row.adapter_path,
    sourcePath: row.source_path,
    managedPath: row.managed_path,
    checksumSha256: row.checksum_sha256,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGpuWorkItemRow(row: GpuWorkItemRow): GpuWorkItem {
  return {
    id: row.id,
    source: row.source as GpuWorkItem['source'],
    model: row.model,
    kind: row.kind as GpuWorkItem['kind'],
    priority: row.priority as GpuWorkItem['priority'],
    state: row.state,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    deadlineAt: row.deadline_at,
    publicJobId: row.public_job_id,
    metadataJson: row.metadata_json,
    errorText: row.error_text,
  };
}

function mapRuntimeTimelineEventRow(row: RuntimeTimelineEventRow): RuntimeTimelineEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    runtimeAlias: row.runtime_alias,
    workItemId: row.work_item_id,
    source: row.source,
    state: row.state,
    message: row.message,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
  };
}

export class GatewayStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_priority INTEGER NOT NULL,
        effective_priority INTEGER NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        result_text TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_state_priority_created
      ON jobs (state, effective_priority DESC, created_at ASC);

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events (job_id);

      CREATE TABLE IF NOT EXISTS models (
        alias TEXT PRIMARY KEY,
        adapter_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        managed_path TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.applyMigrations();
  }

  private applyMigrations(): void {
    const migrations: Array<{ id: number; name: string; run: () => void }> = [
      {
        id: 1,
        name: 'create_gpu_work_items',
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS gpu_work_items (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL,
              model TEXT NOT NULL,
              kind TEXT NOT NULL,
              priority INTEGER NOT NULL,
              state TEXT NOT NULL,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              deadline_at TEXT,
              public_job_id TEXT,
              metadata_json TEXT NOT NULL,
              error_text TEXT,
              FOREIGN KEY (public_job_id) REFERENCES jobs(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_gpu_work_state_priority_created
            ON gpu_work_items (state, priority DESC, created_at ASC);

            CREATE INDEX IF NOT EXISTS idx_gpu_work_public_job_id
            ON gpu_work_items (public_job_id);
          `);
        },
      },
      {
        id: 2,
        name: 'create_gpu_timeline_events',
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS gpu_timeline_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              event_type TEXT NOT NULL,
              runtime_alias TEXT,
              work_item_id TEXT,
              source TEXT,
              state TEXT,
              message TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_gpu_timeline_created
            ON gpu_timeline_events (created_at DESC, id DESC);

            CREATE INDEX IF NOT EXISTS idx_gpu_timeline_runtime
            ON gpu_timeline_events (runtime_alias, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_gpu_timeline_work_item
            ON gpu_timeline_events (work_item_id, created_at DESC);
          `);
        },
      },
    ];

    const hasMigration = this.db
      .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
      .pluck(true);
    const insertMigration = this.db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
    );

    const tx = this.db.transaction(() => {
      for (const migration of migrations) {
        if (hasMigration.get(migration.id)) continue;
        migration.run();
        insertMigration.run(migration.id, migration.name, nowIso());
      }
    });
    tx();
  }

  seedConfig(defaults: Record<string, string>): void {
    const stmt = this.db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO NOTHING
    `);

    const now = nowIso();
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(defaults)) {
        stmt.run({ key, value, updatedAt: now });
      }
    });
    tx();
  }

  getRuntimeSettings(): ActiveRuntimeSettings {
    const getVal = this.db.prepare('SELECT value FROM config WHERE key = ?').pluck(true);
    const defaultModel = String(getVal.get(CONFIG_KEYS.DEFAULT_MODEL) ?? 'ep2');
    const maxQueue = Number(getVal.get(CONFIG_KEYS.MAX_QUEUE) ?? 100);
    const historyTtlDays = Number(getVal.get(CONFIG_KEYS.HISTORY_TTL_DAYS) ?? 7);
    const maxQueueWaitMs = Number(getVal.get(CONFIG_KEYS.MAX_QUEUE_WAIT_MS) ?? 300000);
    const modelSourceDir = String(getVal.get(CONFIG_KEYS.MODEL_SOURCE_DIR) ?? '');
    const backendTimeoutMs = Number(getVal.get(CONFIG_KEYS.BACKEND_TIMEOUT_MS) ?? 180000);

    return {
      defaultModel,
      maxQueue,
      historyTtlDays,
      maxQueueWaitMs,
      modelSourceDir,
      backendTimeoutMs,
    };
  }

  listConfig(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.key] = row.value;
    }
    return out;
  }

  updateConfig(values: Record<string, string>): void {
    const stmt = this.db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const now = nowIso();
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        stmt.run({ key, value, updatedAt: now });
      }
    });
    tx();
  }

  createJob(input: SubmitJobInput, effectivePriority: number, resolvedModel: string): JobRecord {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(`
      INSERT INTO jobs (
        id, source, state, requested_priority, effective_priority,
        model, prompt, metadata_json, result_text, error_text,
        created_at, started_at, finished_at
      ) VALUES (
        @id, @source, 'queued', @requestedPriority, @effectivePriority,
        @model, @prompt, @metadataJson, NULL, NULL,
        @createdAt, NULL, NULL
      )
    `)
      .run({
        id,
        source: input.source,
        requestedPriority: input.requestedPriority ?? 1,
        effectivePriority,
        model: resolvedModel,
        prompt: input.prompt,
        metadataJson: JSON.stringify(input.metadata ?? {}),
        createdAt,
      });

    this.insertEvent(id, 'queued', { effectivePriority, source: input.source });
    return this.getJobByIdOrThrow(id);
  }

  getJobById(jobId: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    return row ? mapJobRow(row) : null;
  }

  getJobByIdOrThrow(jobId: string): JobRecord {
    const job = this.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return job;
  }

  listJobs(limit = 100, state?: JobState): JobRecord[] {
    const sql = state
      ? 'SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?';

    const rows = (state
      ? this.db.prepare(sql).all(state, limit)
      : this.db.prepare(sql).all(limit)) as JobRow[];

    return rows.map(mapJobRow);
  }

  countQueuedJobs(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM jobs WHERE state = 'queued'")
      .get() as { count: number };
    return row.count;
  }

  countRunningJobs(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM jobs WHERE state = 'running'")
      .get() as { count: number };
    return row.count;
  }

  getQueueStatus(maxQueue: number): QueueStatus {
    const workRows = this.getGpuWorkQueueStatus(maxQueue);
    if (workRows.queued > 0 || workRows.running > 0) {
      return workRows;
    }

    const queued = this.countQueuedJobs();
    const running = this.countRunningJobs();
    const oldest = this.db
      .prepare("SELECT created_at FROM jobs WHERE state='queued' ORDER BY created_at ASC LIMIT 1")
      .get() as { created_at?: string } | undefined;
    const newest = this.db
      .prepare("SELECT created_at FROM jobs WHERE state='queued' ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at?: string } | undefined;

    return {
      queued,
      running,
      maxQueue,
      oldestQueuedAt: oldest?.created_at ?? null,
      newestQueuedAt: newest?.created_at ?? null,
    };
  }

  getGpuWorkQueueStatus(maxQueue: number): QueueStatus {
    const queued = this.db
      .prepare("SELECT COUNT(*) as count FROM gpu_work_items WHERE state = 'queued'")
      .get() as { count: number };
    const running = this.db
      .prepare("SELECT COUNT(*) as count FROM gpu_work_items WHERE state = 'running'")
      .get() as { count: number };
    const oldest = this.db
      .prepare("SELECT created_at FROM gpu_work_items WHERE state='queued' ORDER BY created_at ASC LIMIT 1")
      .get() as { created_at?: string } | undefined;
    const newest = this.db
      .prepare("SELECT created_at FROM gpu_work_items WHERE state='queued' ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at?: string } | undefined;

    return {
      queued: queued.count,
      running: running.count,
      maxQueue,
      oldestQueuedAt: oldest?.created_at ?? null,
      newestQueuedAt: newest?.created_at ?? null,
    };
  }

  countPendingGpuWorkItems(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM gpu_work_items WHERE state IN ('queued', 'running')")
      .get() as { count: number };
    return row.count;
  }

  startNextQueuedJob(): JobRecord | null {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(`
          SELECT * FROM jobs
          WHERE state = 'queued'
          ORDER BY effective_priority DESC, created_at ASC, rowid ASC
          LIMIT 1
        `)
        .get() as JobRow | undefined;

      if (!row) {
        return null;
      }

      const startedAt = nowIso();
      this.db
        .prepare(
          "UPDATE jobs SET state='running', started_at=? WHERE id=? AND state='queued'",
        )
        .run(startedAt, row.id);

      const current = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id) as JobRow;
      this.insertEvent(row.id, 'running', { startedAt });
      return mapJobRow(current);
    });

    return tx();
  }

  startJob(jobId: string): JobRecord | null {
    const startedAt = nowIso();
    const result = this.db
      .prepare("UPDATE jobs SET state='running', started_at=? WHERE id=? AND state='queued'")
      .run(startedAt, jobId);

    if (result.changes === 0) {
      const job = this.getJobById(jobId);
      return job?.state === 'running' ? job : null;
    }

    this.insertEvent(jobId, 'running', { startedAt });
    return this.getJobByIdOrThrow(jobId);
  }

  completeJob(jobId: string, resultText: string): JobRecord {
    const finishedAt = nowIso();
    const result = this.db
      .prepare(
        "UPDATE jobs SET state='succeeded', result_text=?, error_text=NULL, finished_at=? WHERE id=? AND state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')",
      )
      .run(resultText, finishedAt, jobId);
    if (result.changes > 0) {
      this.insertEvent(jobId, 'succeeded', { finishedAt });
    }
    return this.getJobByIdOrThrow(jobId);
  }

  failJob(jobId: string, errorText: string): JobRecord {
    const finishedAt = nowIso();
    const result = this.db
      .prepare(
        "UPDATE jobs SET state='failed', error_text=?, finished_at=? WHERE id=? AND state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')",
      )
      .run(errorText, finishedAt, jobId);
    if (result.changes > 0) {
      this.insertEvent(jobId, 'failed', { finishedAt, errorText });
    }
    return this.getJobByIdOrThrow(jobId);
  }

  cancelJob(jobId: string, reason = 'Cancelled by user'): JobRecord | null {
    const finishedAt = nowIso();
    const result = this.db
      .prepare(
        "UPDATE jobs SET state='cancelled', error_text=?, finished_at=? WHERE id=? AND state IN ('queued', 'running')",
      )
      .run(reason, finishedAt, jobId);

    if (result.changes === 0) {
      return null;
    }

    this.insertEvent(jobId, 'cancelled', { finishedAt, reason });
    return this.getJobByIdOrThrow(jobId);
  }

  cancelQueuedJob(jobId: string): JobRecord | null {
    const finishedAt = nowIso();
    const result = this.db
      .prepare(
        "UPDATE jobs SET state='cancelled', error_text='Cancelled by user while queued', finished_at=? WHERE id=? AND state='queued'",
      )
      .run(finishedAt, jobId);

    if (result.changes === 0) {
      return null;
    }

    this.insertEvent(jobId, 'cancelled', { finishedAt, reason: 'queued_cancel' });
    return this.getJobByIdOrThrow(jobId);
  }

  timeoutQueuedJob(jobId: string): JobRecord | null {
    const finishedAt = nowIso();
    const result = this.db
      .prepare(
        "UPDATE jobs SET state='timed_out', error_text='Queue wait timeout exceeded', finished_at=? WHERE id=? AND state='queued'",
      )
      .run(finishedAt, jobId);

    if (result.changes === 0) {
      return null;
    }

    this.insertEvent(jobId, 'timed_out', { finishedAt, reason: 'queue_wait_timeout' });
    return this.getJobByIdOrThrow(jobId);
  }

  timeoutJob(jobId: string, reason = 'Queue wait timeout exceeded'): JobRecord | null {
    const finishedAt = nowIso();
    const result = this.db
      .prepare(
        "UPDATE jobs SET state='timed_out', error_text=?, finished_at=? WHERE id=? AND state IN ('queued', 'running')",
      )
      .run(reason, finishedAt, jobId);

    if (result.changes === 0) {
      return null;
    }

    this.insertEvent(jobId, 'timed_out', { finishedAt, reason });
    return this.getJobByIdOrThrow(jobId);
  }

  createGpuWorkItem(input: CreateGpuWorkItemInput): GpuWorkItem {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(`
        INSERT INTO gpu_work_items (
          id, source, model, kind, priority, state, created_at, started_at,
          finished_at, deadline_at, public_job_id, metadata_json, error_text
        ) VALUES (
          @id, @source, @model, @kind, @priority, 'queued', @createdAt, NULL,
          NULL, @deadlineAt, @publicJobId, @metadataJson, NULL
        )
      `)
      .run({
        id,
        source: input.source,
        model: input.model,
        kind: input.kind,
        priority: input.priority,
        createdAt,
        deadlineAt: input.deadlineAt ?? null,
        publicJobId: input.publicJobId ?? null,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      });

    if (input.publicJobId) {
      this.insertEvent(input.publicJobId, 'gpu_work_queued', {
        gpuWorkItemId: id,
        kind: input.kind,
        priority: input.priority,
      });
    }

    return this.getGpuWorkItemByIdOrThrow(id);
  }

  getGpuWorkItemById(id: string): GpuWorkItem | null {
    const row = this.db
      .prepare('SELECT * FROM gpu_work_items WHERE id = ?')
      .get(id) as GpuWorkItemRow | undefined;
    return row ? mapGpuWorkItemRow(row) : null;
  }

  getGpuWorkItemByIdOrThrow(id: string): GpuWorkItem {
    const item = this.getGpuWorkItemById(id);
    if (!item) {
      throw new Error(`GPU work item not found: ${id}`);
    }
    return item;
  }

  getGpuWorkItemForPublicJob(publicJobId: string): GpuWorkItem | null {
    const row = this.db
      .prepare(
        'SELECT * FROM gpu_work_items WHERE public_job_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(publicJobId) as GpuWorkItemRow | undefined;
    return row ? mapGpuWorkItemRow(row) : null;
  }

  listGpuWorkItems(limit = 100, state?: GpuWorkState): GpuWorkItem[] {
    const sql = state
      ? 'SELECT * FROM gpu_work_items WHERE state = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM gpu_work_items ORDER BY created_at DESC LIMIT ?';
    const rows = (state
      ? this.db.prepare(sql).all(state, limit)
      : this.db.prepare(sql).all(limit)) as GpuWorkItemRow[];
    return rows.map(mapGpuWorkItemRow);
  }

  insertRuntimeTimelineEvent(input: CreateRuntimeTimelineEventInput): RuntimeTimelineEvent {
    const createdAt = nowIso();
    const result = this.db
      .prepare(`
        INSERT INTO gpu_timeline_events (
          event_type, runtime_alias, work_item_id, source, state, message,
          metadata_json, created_at
        ) VALUES (
          @eventType, @runtimeAlias, @workItemId, @source, @state, @message,
          @metadataJson, @createdAt
        )
      `)
      .run({
        eventType: input.eventType,
        runtimeAlias: input.runtimeAlias ?? null,
        workItemId: input.workItemId ?? null,
        source: input.source ?? null,
        state: input.state ?? null,
        message: input.message,
        metadataJson: JSON.stringify(input.metadata ?? {}),
        createdAt,
      });

    const row = this.db
      .prepare('SELECT * FROM gpu_timeline_events WHERE id = ?')
      .get(result.lastInsertRowid) as RuntimeTimelineEventRow;
    return mapRuntimeTimelineEventRow(row);
  }

  listRuntimeTimelineEvents(options: ListRuntimeTimelineEventsOptions = {}): RuntimeTimelineEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.runtimeAlias) {
      where.push('runtime_alias = ?');
      params.push(options.runtimeAlias);
    }
    if (options.workItemId) {
      where.push('work_item_id = ?');
      params.push(options.workItemId);
    }

    const sql = `
      SELECT * FROM gpu_timeline_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, limit) as RuntimeTimelineEventRow[];
    return rows.map(mapRuntimeTimelineEventRow);
  }

  listQueuedGpuWorkItems(): GpuWorkItem[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM gpu_work_items
        WHERE state = 'queued'
        ORDER BY priority DESC, created_at ASC, rowid ASC
      `)
      .all() as GpuWorkItemRow[];
    return rows.map(mapGpuWorkItemRow);
  }

  listRunningGpuWorkItems(): GpuWorkItem[] {
    const rows = this.db
      .prepare("SELECT * FROM gpu_work_items WHERE state = 'running' ORDER BY started_at ASC")
      .all() as GpuWorkItemRow[];
    return rows.map(mapGpuWorkItemRow);
  }

  startGpuWorkItem(id: string): GpuWorkItem | null {
    const startedAt = nowIso();
    const result = this.db
      .prepare("UPDATE gpu_work_items SET state='running', started_at=? WHERE id=? AND state='queued'")
      .run(startedAt, id);
    if (result.changes === 0) {
      return null;
    }

    const item = this.getGpuWorkItemByIdOrThrow(id);
    if (item.publicJobId) {
      this.insertEvent(item.publicJobId, 'gpu_work_running', {
        gpuWorkItemId: id,
        startedAt,
      });
    }
    return item;
  }

  finishGpuWorkItem(
    id: string,
    state: Exclude<GpuWorkState, 'queued' | 'running'>,
    errorText?: string,
  ): GpuWorkItem | null {
    const finishedAt = nowIso();
    const result = this.db
      .prepare(`
        UPDATE gpu_work_items
        SET state=?, error_text=?, finished_at=?
        WHERE id=? AND state IN ('queued', 'running')
      `)
      .run(state, errorText ?? null, finishedAt, id);
    if (result.changes === 0) {
      return this.getGpuWorkItemById(id);
    }

    const item = this.getGpuWorkItemByIdOrThrow(id);
    if (item.publicJobId) {
      this.insertEvent(item.publicJobId, `gpu_work_${state}`, {
        gpuWorkItemId: id,
        finishedAt,
        errorText,
      });
    }
    return item;
  }

  recoverInterruptedGpuWork(reason = 'gateway_restarted'): {
    jobsFailed: number;
    workItemsFailed: number;
  } {
    const finishedAt = nowIso();
    const interrupted = this.db
      .prepare("SELECT * FROM gpu_work_items WHERE state IN ('queued', 'running')")
      .all() as GpuWorkItemRow[];
    if (interrupted.length === 0) {
      return { jobsFailed: 0, workItemsFailed: 0 };
    }

    const publicJobIds = Array.from(
      new Set(interrupted.map((item) => item.public_job_id).filter(Boolean) as string[]),
    );

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`
          UPDATE gpu_work_items
          SET state='failed', error_text=?, finished_at=?
          WHERE state IN ('queued', 'running')
        `)
        .run(reason, finishedAt);

      for (const jobId of publicJobIds) {
        this.db
          .prepare(`
            UPDATE jobs
            SET state='failed', error_text=?, finished_at=?
            WHERE id=? AND state IN ('queued', 'running')
          `)
          .run(reason, finishedAt, jobId);
        this.insertEvent(jobId, 'failed', { finishedAt, reason });
      }
    });
    tx();

    return {
      jobsFailed: publicJobIds.length,
      workItemsFailed: interrupted.length,
    };
  }

  insertEvent(jobId: string, eventType: string, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO job_events (job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(jobId, eventType, JSON.stringify(payload), nowIso());
  }

  listJobEvents(jobId: string): Array<{ eventType: string; payloadJson: string; createdAt: string }> {
    return this.db
      .prepare(
        'SELECT event_type as eventType, payload_json as payloadJson, created_at as createdAt FROM job_events WHERE job_id = ? ORDER BY id ASC',
      )
      .all(jobId) as Array<{ eventType: string; payloadJson: string; createdAt: string }>;
  }

  upsertModel(record: Omit<ModelRecord, 'createdAt' | 'updatedAt'>): ModelRecord {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO models (
          alias, adapter_path, source_path, managed_path, checksum_sha256, enabled, created_at, updated_at
        ) VALUES (
          @alias, @adapterPath, @sourcePath, @managedPath, @checksumSha256, @enabled, @createdAt, @updatedAt
        )
        ON CONFLICT(alias) DO UPDATE SET
          adapter_path = excluded.adapter_path,
          source_path = excluded.source_path,
          managed_path = excluded.managed_path,
          checksum_sha256 = excluded.checksum_sha256,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `)
      .run({
        alias: record.alias,
        adapterPath: record.adapterPath,
        sourcePath: record.sourcePath,
        managedPath: record.managedPath,
        checksumSha256: record.checksumSha256,
        enabled: record.enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });

    const row = this.db.prepare('SELECT * FROM models WHERE alias = ?').get(record.alias) as ModelRow;
    return mapModelRow(row);
  }

  removeModel(alias: string): boolean {
    const result = this.db.prepare('DELETE FROM models WHERE alias = ?').run(alias);
    return result.changes > 0;
  }

  getModel(alias: string): ModelRecord | null {
    const row = this.db.prepare('SELECT * FROM models WHERE alias = ?').get(alias) as ModelRow | undefined;
    return row ? mapModelRow(row) : null;
  }

  listModels(enabledOnly = false): ModelRecord[] {
    const sql = enabledOnly ? 'SELECT * FROM models WHERE enabled = 1 ORDER BY alias ASC' : 'SELECT * FROM models ORDER BY alias ASC';
    const rows = this.db.prepare(sql).all() as ModelRow[];
    return rows.map(mapModelRow);
  }

  pruneFinishedJobs(ttlDays: number): number {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ');
    const sql = `DELETE FROM jobs WHERE state IN (${placeholders}) AND finished_at IS NOT NULL AND finished_at < ?`;
    const result = this.db.prepare(sql).run(...TERMINAL_STATES, cutoff);
    return result.changes;
  }

  pruneRuntimeTimelineEvents(ttlDays: number): number {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare('DELETE FROM gpu_timeline_events WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  failRunningJobsOnStartup(reason = 'Gateway restarted while job was running'): number {
    const finishedAt = nowIso();
    const running = this.db
      .prepare("SELECT id FROM jobs WHERE state = 'running'")
      .all() as Array<{ id: string }>;

    if (running.length === 0) {
      return 0;
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE jobs SET state='failed', error_text=?, finished_at=? WHERE state='running'",
        )
        .run(reason, finishedAt);

      for (const row of running) {
        this.insertEvent(row.id, 'failed', { finishedAt, reason: 'startup_recovery' });
      }
    });
    tx();
    return running.length;
  }

  close(): void {
    this.db.close();
  }
}
