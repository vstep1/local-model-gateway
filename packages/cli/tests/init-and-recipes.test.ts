import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig, type EnvironmentInfo } from '../src/init.js';
import { formatDoctor } from '../src/doctor.js';
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
});
