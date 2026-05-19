import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { defaultConfig, type EnvironmentInfo } from '../src/init.js';
import {
  createDoctorReport,
  formatDoctor,
  formatDoctorJson,
  formatFixPlan,
  runDoctor,
  type DoctorProbes,
} from '../src/doctor.js';
import { listRecipes, renderRecipe } from '../src/recipes.js';

function env(platform: NodeJS.Platform, arch: string): EnvironmentInfo {
  return {
    arch,
    cwd: '/tmp/local-model-gateway',
    hasExistingConfig: false,
    llamaCliPath: '/usr/local/bin/llama-cli',
    llamaServerPath: '/usr/local/bin/llama-server',
    nodePath: '/usr/local/bin/node',
    platform,
    totalMemoryGb: 64,
  };
}

const quietProbes: DoctorProbes = {
  httpGet: async () => ({ error: 'not running', ok: false }),
  listeningPorts: async () => [],
  listProcesses: async () => [],
  portOpen: async () => false,
};

describe('cli init', () => {
  it('generates machine-neutral config with disabled runtime presets', () => {
    const cfg = defaultConfig(env('darwin', 'arm64'));
    const runtimes = cfg.runtimes as Record<string, Record<string, unknown>>;

    assert.equal(runtimes['qwen3-32b'].enabled, false);
    assert.equal(runtimes['minimax-m2.7'].enabled, false);
    assert.equal(runtimes['qwen3-32b'].service_script, './runtime-adapters/qwen3-32b-service.sh');
    assert.deepEqual(cfg.startup_models, {});
    assert.doesNotMatch(JSON.stringify(cfg), /\/Users\/vs|com\.vs/);
  });

  it('keeps Linux config protocol-compatible', () => {
    const cfg = defaultConfig(env('linux', 'x64'));
    assert.deepEqual(cfg.server, { host: '127.0.0.1', port: 8787 });
    assert.equal((cfg.paths as Record<string, unknown>).llama_cli, '/usr/local/bin/llama-cli');
  });
});

describe('cli recipes', () => {
  it('renders generic OpenAI, MCP, and Hermes recipes', () => {
    assert.deepEqual(listRecipes(), ['generic-openai', 'generic-mcp', 'hermes']);
    assert.match(renderRecipe('generic-openai'), /http:\/\/127\.0\.0\.1:8787\/v1/);
    assert.match(renderRecipe('generic-mcp'), /gateway_status/);
    assert.match(renderRecipe('hermes'), /mcp_servers:/);
  });
});

describe('cli doctor output', () => {
  it('formats json with top-level status aggregation', () => {
    const checks = [
      { id: 'ok_check', name: 'OK check', ok: true, fix: 'No action needed.' },
      {
        id: 'warn_check',
        name: 'Warn check',
        ok: true,
        status: 'warn' as const,
        fix: 'Inspect this.',
      },
      { id: 'fail_check', name: 'Fail check', ok: false, fix: 'Fix this.' },
    ];
    const report = createDoctorReport(checks);
    assert.equal(report.status, 'fail');
    assert.deepEqual(report.summary, { fail: 1, ok: 1, warn: 1 });
    assert.equal(report.checks[2].safe_to_auto_fix, false);
    assert.match(formatDoctorJson(checks), /"id": "fail_check"/);
  });

  it('formats a read-only fix plan with high-risk issues first', () => {
    const text = formatFixPlan([
      {
        id: 'config_file_parsed',
        name: 'Config file parsed',
        ok: false,
        fix: 'Fix config.',
      },
      {
        fix: 'Stop sibling gateway.',
        fixPlan: ['Stop sibling gateway PID 1234.'],
        id: 'sibling_gateway_detected',
        message: 'Sibling gateway detected.',
        name: 'Sibling gateway process detected',
        ok: false,
      },
    ]);
    assert.match(text, /Read-only plan/);
    assert.ok(text.indexOf('Sibling gateway detected') < text.indexOf('Config file parsed'));
    assert.match(text, /Rerun local-model-gateway doctor --json/);
  });

  it('formats actionable failures without stack traces', () => {
    const text = formatDoctor([
      { name: 'llama-server available', ok: false, fix: 'Install llama.cpp.' },
    ]);
    assert.match(text, /fail  llama-server available/);
    assert.match(text, /fix: Install llama\.cpp\./);
    assert.doesNotMatch(text, /Error:/);
  });

  it('formats warnings without causing a failure check', () => {
    const text = formatDoctor([
      {
        name: 'At least one routable model configured',
        ok: true,
        status: 'warn',
        fix: 'Enable a managed runtime.',
      },
    ]);
    assert.match(text, /warn  At least one routable model configured/);
    assert.match(text, /note: Enable a managed runtime\./);
    assert.doesNotMatch(text, /fix:/);
  });

  it('checks enabled runtime scripts and reports unloaded runtime health as a warning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-gateway-doctor-'));
    const runtimeDir = path.join(root, 'runtime-adapters');
    const scriptPath = path.join(runtimeDir, 'test-runtime.sh');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(scriptPath, 0o755);
    await fs.writeFile(
      path.join(root, 'local-model-gateway.config.yaml'),
      [
        'server:',
        '  host: 127.0.0.1',
        '  port: 18789',
        'paths:',
        '  data_dir: ./data',
        '  db_path: ./data/gateway.sqlite',
        '  models_dir: ./models',
        '  model_source_dir: ./runtime/model-source',
        '  llama_cli: llama-cli',
        '  base_model_path: ./runtime/base.gguf',
        'runtimes:',
        '  test-runtime:',
        '    enabled: true',
        '    base_url: http://127.0.0.1:65535/v1',
        '    health_url: http://127.0.0.1:65535/v1/models',
        '    service_script: ./runtime-adapters/test-runtime.sh',
        '    start_args: [start]',
        '    stop_args: [stop]',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      const checks = await runDoctor(root, { probes: quietProbes });
      assert.equal(
        checks.find((check) => check.name === 'Runtime script exists for test-runtime')?.ok,
        true,
      );
      assert.equal(
        checks.find((check) => check.name === 'Runtime script executable for test-runtime')?.ok,
        true,
      );
      assert.equal(
        checks.find((check) => check.name === 'Runtime health currently reachable for test-runtime')?.status,
        'warn',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('detects sibling gateway listeners on non-configured ports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-gateway-doctor-'));
    await fs.writeFile(
      path.join(root, 'local-model-gateway.config.yaml'),
      [
        'server:',
        '  host: 127.0.0.1',
        '  port: 18790',
        'paths:',
        '  data_dir: ./data',
        '  db_path: ./data/gateway.sqlite',
        '  models_dir: ./models',
        '  model_source_dir: ./runtime/model-source',
        '  llama_cli: llama-cli',
        '  base_model_path: ./runtime/base.gguf',
        '',
      ].join('\n'),
      'utf8',
    );
    const checks = await runDoctor(root, {
      probes: {
        ...quietProbes,
        listeningPorts: async (pid) => (pid === 1234 ? [8788] : []),
        listProcesses: async () => [{
          args: '/repo/packages/gateway/dist/src/index.js',
          command: 'node',
          pid: 1234,
          ppid: 1,
        }],
      },
    });
    await fs.rm(root, { recursive: true, force: true });

    const sibling = checks.find((check) => check.id === 'sibling_gateway_detected');
    assert.equal(sibling?.ok, false);
    assert.match(sibling?.fix ?? '', /127\.0\.0\.1:18790\/v1/);
  });

  it('detects direct llama-cli work that is absent from gateway status', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-model-gateway-doctor-'));
    await fs.writeFile(
      path.join(root, 'local-model-gateway.config.yaml'),
      [
        'server:',
        '  host: 127.0.0.1',
        '  port: 18791',
        'paths:',
        '  data_dir: ./data',
        '  db_path: ./data/gateway.sqlite',
        '  models_dir: ./models',
        '  model_source_dir: ./runtime/model-source',
        '  llama_cli: llama-cli',
        '  base_model_path: ./runtime/base.gguf',
        '',
      ].join('\n'),
      'utf8',
    );
    const checks = await runDoctor(root, {
      probes: {
        httpGet: async (url) => ({
          body: url.endsWith('/status') ? { active_work: [], gpu_queue: [] } : {},
          ok: true,
          status: 200,
        }),
        listeningPorts: async () => [],
        listProcesses: async () => [{
          args: '/opt/homebrew/bin/llama-cli -m model.gguf -p prompt',
          command: '/opt/homebrew/bin/llama-cli',
          pid: 2222,
          ppid: 1,
        }],
        portOpen: async () => true,
      },
    });
    await fs.rm(root, { recursive: true, force: true });

    const bypass = checks.find((check) => check.id === 'direct_llama_process_bypass');
    assert.equal(bypass?.ok, false);
    assert.match(bypass?.whyItMatters ?? '', /outside the coordinator/);
  });
});
