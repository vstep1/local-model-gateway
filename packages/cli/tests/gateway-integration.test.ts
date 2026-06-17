import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };

type StatusBody = {
  active_work?: Array<Record<string, unknown>>;
  gpu_queue?: Array<Record<string, unknown>>;
  managed_runtimes?: Array<Record<string, unknown>>;
  recent_work?: Array<Record<string, unknown>>;
  runtime_timeline?: Array<Record<string, unknown>>;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('missing test port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(
  check: () => Promise<T | false | null | undefined>,
  timeoutMs = 10000,
  pollMs = 100,
  message = 'condition not met',
): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${message}${detail}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function writeIntegrationConfig(options: {
  configPath: string;
  dataDir: string;
  dbPath: string;
  gatewayPort: number;
  modelsDir: string;
  modelSourceDir: string;
  progressPath: string;
  runtimePort: number;
  serviceScript: string;
}): Promise<void> {
  await fs.writeFile(
    options.configPath,
    [
      'server:',
      '  host: 127.0.0.1',
      `  port: ${options.gatewayPort}`,
      'paths:',
      `  data_dir: ${options.dataDir}`,
      `  db_path: ${options.dbPath}`,
      `  models_dir: ${options.modelsDir}`,
      `  model_source_dir: ${options.modelSourceDir}`,
      '  llama_cli: llama-cli',
      `  base_model_path: ${path.join(options.modelSourceDir, 'base.gguf')}`,
      'default_model: quickstart-mock',
      'startup_models: {}',
      'queue:',
      '  max_queue: 100',
      '  max_queue_wait_ms: 300000',
      '  history_ttl_days: 7',
      '  wait_poll_ms: 25',
      'generation:',
      '  ctx_size: 4096',
      '  max_tokens: 128',
      '  temperature: 0.8',
      '  top_p: 0.95',
      '  repeat_penalty: 1.0',
      '  gpu_layers: all',
      'allow_unmanaged_local_upstreams: false',
      'runtimes:',
      '  quickstart-mock:',
      '    enabled: true',
      `    base_url: http://127.0.0.1:${options.runtimePort}/v1`,
      `    health_url: http://127.0.0.1:${options.runtimePort}/v1/models`,
      `    service_script: ${options.serviceScript}`,
      `    load_progress_path: ${options.progressPath}`,
      '    start_args: [start]',
      '    stop_args: [stop]',
      '    idle_ttl_ms: 60000',
      '    load_timeout_ms: 10000',
      '    stop_timeout_ms: 10000',
      '    max_concurrency: 1',
      '    upstream_model: quickstart-mock',
      '    context_window: 4096',
      '    recommended_prompt_budget: 3072',
      '    supports_streaming: true',
      '    supports_reasoning: false',
      'openai_upstreams: []',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

async function stopMockRuntime(serviceScript: string, runtimePort: number, stateDir: string): Promise<void> {
  const child = spawn(process.execPath, [serviceScript, 'stop'], {
    env: {
      ...process.env,
      LOCAL_MODEL_GATEWAY_QUICKSTART_RUNTIME_PORT: String(runtimePort),
      LOCAL_MODEL_GATEWAY_QUICKSTART_STATE_DIR: stateDir,
    },
  });
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => child.once('error', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
}

function toolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  assert.ok(text, 'tool result did not include text content');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('gateway integration', () => {
  it('serves the documented quickstart path over real HTTP and MCP', { timeout: 30000 }, async () => {
    const cliPath = path.join(repoRoot, 'packages/cli/src/index.ts');
    const serviceScript = path.join(repoRoot, 'examples/quickstart/mock-runtime-service.mjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-gateway-integration-'));
    const stateDir = path.join(root, 'runtime-state');
    const dataDir = path.join(root, 'data');
    const modelsDir = path.join(root, 'models');
    const modelSourceDir = path.join(root, 'model-source');
    const configPath = path.join(root, 'local-model-gateway.config.yaml');
    const gatewayPort = await freePort();
    const runtimePort = await freePort();
    const baseUrl = `http://127.0.0.1:${gatewayPort}`;
    let gateway: ChildProcessWithoutNullStreams | null = null;
    let mcpClient: Client | null = null;

    await fs.mkdir(stateDir, { recursive: true });
    await writeIntegrationConfig({
      configPath,
      dataDir,
      dbPath: path.join(dataDir, 'gateway.sqlite'),
      gatewayPort,
      modelsDir,
      modelSourceDir,
      progressPath: path.join(stateDir, 'load-progress.json'),
      runtimePort,
      serviceScript,
    });

    const gatewayOutput: string[] = [];
    try {
      gateway = spawn(process.execPath, ['--import', 'tsx', cliPath, 'start'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          LOCAL_MODEL_GATEWAY_CONFIG: configPath,
          LOCAL_MODEL_GATEWAY_QUICKSTART_RUNTIME_PORT: String(runtimePort),
          LOCAL_MODEL_GATEWAY_QUICKSTART_STATE_DIR: stateDir,
        },
      });
      gateway.stdout.on('data', (chunk) => gatewayOutput.push(String(chunk)));
      gateway.stderr.on('data', (chunk) => gatewayOutput.push(String(chunk)));

      await waitFor(
        async () => {
          if (gateway?.exitCode !== null || gateway?.signalCode !== null) {
            throw new Error(`gateway exited early: ${gatewayOutput.join('')}`);
          }
          try {
            const response = await fetch(`${baseUrl}/health`);
            return response.ok;
          } catch {
            return false;
          }
        },
        10000,
        100,
        'gateway did not become healthy',
      );

      const models = await fetchJson<{ data: Array<{ id: string }> }>(`${baseUrl}/v1/models`);
      assert.deepEqual(models.data.map((model) => model.id), ['quickstart-mock']);

      const dashboard = await fetch(`${baseUrl}/dashboard`);
      assert.equal(dashboard.status, 200);
      assert.match(await dashboard.text(), /Runtime Timeline/);

      const discovery = await fetchJson<{ version: string; models: Array<{ id: string }> }>(
        `${baseUrl}/.well-known/local-model-gateway.json`,
      );
      assert.equal(discovery.version, packageJson.version);
      assert.equal(discovery.models.some((model) => model.id === 'quickstart-mock'), true);

      const slowRequest = fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          model: 'quickstart-mock',
          messages: [{ role: 'user', content: 'hold the first request' }],
          quickstart_delay_ms: 1200,
          stream: false,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      await waitFor(
        async () => {
          const status = await fetchJson<StatusBody>(`${baseUrl}/status?recent_limit=5&timeline_limit=20`);
          return (status.active_work?.length ?? 0) > 0 ? status : false;
        },
        10000,
        50,
        'first request did not become active',
      );

      const queuedRequest = fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          model: 'quickstart-mock',
          messages: [{ role: 'user', content: 'queue behind the first request' }],
          stream: false,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      await waitFor(
        async () => {
          const status = await fetchJson<StatusBody>(`${baseUrl}/status?recent_limit=5&timeline_limit=20`);
          return (status.gpu_queue?.length ?? 0) > 0 ? status : false;
        },
        10000,
        50,
        'second request did not queue behind active work',
      );

      const [slowResponse, queuedResponse] = await Promise.all([slowRequest, queuedRequest]);
      assert.equal(slowResponse.status, 200);
      assert.equal(queuedResponse.status, 200);
      const slowBody = await slowResponse.json() as { choices: Array<{ message: { content: string } }> };
      const queuedBody = await queuedResponse.json() as { choices: Array<{ message: { content: string } }> };
      assert.match(slowBody.choices[0].message.content, /gateway reached a managed runtime/);
      assert.match(queuedBody.choices[0].message.content, /queue behind the first request/);

      const finalStatus = await waitFor(
        async () => {
          const status = await fetchJson<StatusBody>(`${baseUrl}/status?recent_limit=10&timeline_limit=50`);
          const eventTypes = (status.runtime_timeline ?? []).map((event) => event.eventType);
          return eventTypes.includes('work_succeeded') && (status.recent_work?.length ?? 0) >= 2
            ? status
            : false;
        },
        10000,
        100,
        'completed work did not appear in status timeline',
      );
      assert.equal(
        finalStatus.managed_runtimes?.some((runtime) => runtime.alias === 'quickstart-mock'),
        true,
      );

      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      mcpClient = new Client({ name: 'local-model-gateway-integration-test', version: '1.0.0' }, {
        capabilities: {},
      });
      await mcpClient.connect(transport);

      const runtimeStatus = toolJson(await mcpClient.callTool({
        name: 'runtime_status',
        arguments: {},
      }));
      assert.equal(
        (runtimeStatus.managed_runtimes as Array<Record<string, unknown>>)
          .some((runtime) => runtime.alias === 'quickstart-mock'),
        true,
      );

      const runtimeHistory = toolJson(await mcpClient.callTool({
        name: 'runtime_history',
        arguments: { limit: 20, runtime_alias: 'quickstart-mock' },
      }));
      assert.equal(
        (runtimeHistory.runtime_timeline as Array<Record<string, unknown>>)
          .some((event) => event.eventType === 'work_succeeded'),
        true,
      );
    } finally {
      await mcpClient?.close().catch(() => undefined);
      if (gateway) await stopChild(gateway);
      await stopMockRuntime(serviceScript, runtimePort, stateDir);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
