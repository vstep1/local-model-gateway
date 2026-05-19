import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { defaultConfig, type EnvironmentInfo } from '../src/init.js';
import { formatDoctor, runDoctor } from '../src/doctor.js';
import { listRecipes, renderRecipe } from '../src/recipes.js';

function env(platform: NodeJS.Platform, arch: string): EnvironmentInfo {
  return {
    arch,
    cwd: '/tmp/local-ai-gateway',
    hasExistingConfig: false,
    llamaCliPath: '/usr/local/bin/llama-cli',
    llamaServerPath: '/usr/local/bin/llama-server',
    nodePath: '/usr/local/bin/node',
    platform,
    totalMemoryGb: 64,
  };
}

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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-gateway-doctor-'));
    const runtimeDir = path.join(root, 'runtime-adapters');
    const scriptPath = path.join(runtimeDir, 'test-runtime.sh');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(scriptPath, 0o755);
    await fs.writeFile(
      path.join(root, 'local-ai-gateway.config.yaml'),
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
      const checks = await runDoctor(root);
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
});
