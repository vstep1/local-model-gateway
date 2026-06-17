import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientRecipe, registerTools } from '../src/tools/index.js';

function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text as string) as Record<string, unknown>;
}

function makeToolHarness(withGpu = true): {
  gpuCoordinator: Record<string, unknown> | undefined;
  registry: Record<string, unknown>;
  scheduler: Record<string, unknown>;
  store: Record<string, unknown>;
  tools: Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>;
} {
  const tools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>();
  const scheduler = {
    cancelQueuedJob: (jobId: string) => (jobId === 'cancel-me' ? { id: jobId, state: 'cancelled' } : null),
    getJob: (jobId: string) => (jobId === 'job-1' ? { id: jobId, state: 'succeeded' } : null),
    listJobs: (limit: number, state?: string) => [{ id: 'job-1', limit, state }],
    queueStatus: () => ({ queued: 0, running: 0, max: 100 }),
    submitJob: (input: Record<string, unknown>) => ({ id: 'job-1', ...input }),
    waitForJob: async (jobId: string, timeoutMs?: number) => ({
      job: { id: jobId, state: 'succeeded' },
      timedOut: Boolean(timeoutMs && timeoutMs < 10),
    }),
  };
  const store = {
    listConfig: () => ({ default_model: 'quickstart-mock' }),
    listJobEvents: (jobId: string) => [{ jobId, type: 'finished' }],
    listRuntimeTimelineEvents: (options: Record<string, unknown>) => [{ eventType: 'work_succeeded', ...options }],
    updateConfig: (entries: Record<string, string>) => ({ entries }),
  };
  const registry = {
    importModel: async (alias: string, sourcePath: string) => ({ alias, sourcePath }),
    listModels: (enabledOnly: boolean) => [{ alias: 'ep2', enabledOnly }],
    removeModel: async (alias: string) => alias === 'ep2',
    syncStartup: async () => ({ imported: [], missingSources: [] }),
  };
  const gpuCoordinator = withGpu
    ? {
        cancelRuntimeRequest: (id: string) => (id === 'work-1' ? { id, state: 'cancelled' } : null),
        forceUnloadRuntime: async (alias: string, reason: string) => ({ alias, reason, unloaded: true }),
        listModels: () => ['quickstart-mock'],
        listRuntimeModels: () => [
          {
            alias: 'quickstart-mock',
            contextWindow: 4096,
            state: 'loaded',
          },
        ],
        refreshRuntimeHealth: async () => undefined,
        status: () => ({
          active_work: [],
          gpu_queue: [],
          managed_runtimes: [{ alias: 'quickstart-mock' }],
          recent_work: [],
          runtime_timeline: [],
        }),
      }
    : undefined;

  registerTools(
    { addTool: (tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) => tools.set(tool.name, tool) } as never,
    scheduler as never,
    store as never,
    registry as never,
    { host: '127.0.0.1', port: 18787 },
    gpuCoordinator as never,
  );

  return { gpuCoordinator, registry, scheduler, store, tools };
}

async function execTool(
  tools: Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return parseToolResult(await tool.execute(args));
}

describe('gateway setup tools', () => {
  it('generates client configs from the active gateway endpoint', () => {
    const endpoint = { host: '127.0.0.1', port: 18787 };

    assert.equal(
      clientRecipe('generic-openai', endpoint).openai_base_url,
      'http://127.0.0.1:18787/v1',
    );
    assert.equal(
      clientRecipe('generic-mcp', endpoint).mcp_url,
      'http://127.0.0.1:18787/mcp',
    );

    const hermes = clientRecipe('hermes', endpoint);
    assert.equal(
      (hermes.provider as Record<string, unknown>).base_url,
      'http://127.0.0.1:18787/v1',
    );
    assert.equal(
      ((hermes.mcp_servers as Record<string, Record<string, unknown>>)['local-model-gateway']).url,
      'http://127.0.0.1:18787/mcp',
    );
  });

  it('registers and executes the runtime and model management tools', async () => {
    const { tools } = makeToolHarness();

    assert.deepEqual(
      Array.from(tools.keys()).sort(),
      [
        'cancel_job',
        'cancel_runtime_request',
        'force_unload_runtime',
        'gateway_status',
        'generate_client_config',
        'get_config',
        'get_job',
        'import_model',
        'list_jobs',
        'list_models',
        'list_runtime_models',
        'queue_status',
        'recommend_local_profile',
        'remove_model',
        'runtime_history',
        'runtime_status',
        'submit_job',
        'sync_models',
        'update_config',
        'validate_client_config',
        'wait_job',
      ],
    );

    assert.equal((await execTool(tools, 'gateway_status')).queue instanceof Object, true);
    assert.equal((await execTool(tools, 'recommend_local_profile', { prompt_tokens: 2000 })).recommended_model, 'quickstart-mock');
    assert.equal((await execTool(tools, 'generate_client_config', { client: 'generic-mcp' })).mcp_url, 'http://127.0.0.1:18787/mcp');
    assert.equal(
      (await execTool(tools, 'validate_client_config', {
        openai_base_url: 'https://example.com',
        mcp_url: 'http://127.0.0.1:18787/not-mcp',
      })).ok,
      false,
    );
    assert.equal((await execTool(tools, 'submit_job', { prompt: 'hello' })).job instanceof Object, true);
    assert.equal((await execTool(tools, 'get_job', { job_id: 'job-1', include_events: true })).events instanceof Array, true);
    assert.equal((await execTool(tools, 'wait_job', { job_id: 'job-1', timeout_ms: 5 })).timedOut, true);
    assert.equal((await execTool(tools, 'cancel_job', { job_id: 'cancel-me' })).job instanceof Object, true);
    assert.equal((await execTool(tools, 'queue_status')).queued, 0);
    assert.equal(((await execTool(tools, 'list_jobs', { limit: 5, state: 'succeeded' })).jobs as unknown[]).length, 1);
    assert.equal(((await execTool(tools, 'list_models', { enabled_only: true, include_runtimes: true })).runtime_models as unknown[]).length, 1);
    assert.equal(((await execTool(tools, 'list_runtime_models')).runtime_models as unknown[]).length, 1);
    assert.equal(((await execTool(tools, 'runtime_status')).managed_runtimes as unknown[]).length, 1);
    assert.equal(((await execTool(tools, 'runtime_history', { limit: 1, runtime_alias: 'quickstart-mock' })).runtime_timeline as unknown[]).length, 1);
    assert.equal((await execTool(tools, 'cancel_runtime_request', { work_item_id: 'work-1' })).work_item instanceof Object, true);
    assert.equal((await execTool(tools, 'force_unload_runtime', { alias: 'quickstart-mock' })).unloaded, true);
    assert.equal((await execTool(tools, 'import_model', { alias: 'ep3', source_path: '/tmp/ep3.gguf' })).restart_required, true);
    assert.equal((await execTool(tools, 'remove_model', { alias: 'ep2' })).removed, true);
    assert.equal((await execTool(tools, 'sync_models')).restart_required, true);
    assert.equal((await execTool(tools, 'get_config')).config instanceof Object, true);
    assert.deepEqual((await execTool(tools, 'update_config', { entries: { default_model: 'ep2' } })).updated_keys, ['default_model']);
  });

  it('reports user-facing errors for missing resources and invalid updates', async () => {
    const { tools } = makeToolHarness(false);

    await assert.rejects(
      () => tools.get('get_job')!.execute({ job_id: 'missing' }),
      /Job not found: missing/,
    );
    await assert.rejects(
      () => tools.get('cancel_job')!.execute({ job_id: 'missing' }),
      /could not be cancelled/,
    );
    await assert.rejects(
      () => tools.get('cancel_runtime_request')!.execute({ work_item_id: 'missing' }),
      /Runtime request not found/,
    );
    await assert.rejects(
      () => tools.get('force_unload_runtime')!.execute({ alias: 'quickstart-mock' }),
      /GPU coordinator is not configured/,
    );
    await assert.rejects(
      () => tools.get('update_config')!.execute({ entries: {} }),
      /entries must include at least one key/,
    );
  });
});
