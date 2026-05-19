import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveGatewayConfig } from '../src/config.js';

const ENV_KEYS = [
  'LOCAL_AI_GATEWAY_CONFIG',
  'LOCAL_AI_GATEWAY_HOST',
  'LOCAL_AI_GATEWAY_PORT',
  'LOCAL_AI_GATEWAY_OPENAI_UPSTREAMS',
  'LOCAL_AI_GATEWAY_MANAGED_RUNTIMES',
  'LOCAL_AI_GATEWAY_ALLOW_UNMANAGED_LOCAL_UPSTREAMS',
  'LOCAL_AI_GATEWAY_AUTH_TOKEN',
  'LOCAL_GPU_GATEWAY_OPENAI_UPSTREAMS',
  'LOCAL_GPU_GATEWAY_MANAGED_RUNTIMES',
  'LOCAL_GPU_GATEWAY_ALLOW_UNMANAGED_LOCAL_UPSTREAMS',
];

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function runtimeConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base_url: 'http://127.0.0.1:18001/v1',
    health_url: 'http://127.0.0.1:18001/v1/models',
    service_script: './runtime/qwen.sh',
    upstream_model: 'qwen3-32b',
    ...extra,
  };
}

describe('gateway config', () => {
  it('loads YAML config and lets env override server values', async () => {
    await withEnv({ LOCAL_AI_GATEWAY_PORT: '9999' }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-gateway-config-'));
      await fs.writeFile(
        path.join(root, 'local-ai-gateway.config.yaml'),
        [
          'server:',
          '  host: 127.0.0.1',
          '  port: 8787',
          'paths:',
          '  data_dir: ./state',
          'runtimes:',
          '  qwen3-32b:',
          '    base_url: http://127.0.0.1:18001/v1',
          '    health_url: http://127.0.0.1:18001/v1/models',
          '    service_script: ./runtime/qwen.sh',
          '    context_window: 131072',
        ].join('\n'),
        'utf8',
      );

      const config = resolveGatewayConfig({ rootDir: root });
      assert.equal(config.port, 9999);
      assert.equal(config.dataDir, path.join(root, 'state'));
      assert.equal(config.managedRuntimes[0].serviceScript, path.join(root, 'runtime/qwen.sh'));
      assert.equal(config.managedRuntimes[0].contextWindow, 131072);
    });
  });

  it('lets managed aliases win over unmanaged upstream aliases', async () => {
    await withEnv(
      {
        LOCAL_AI_GATEWAY_MANAGED_RUNTIMES: JSON.stringify({
          'qwen3-32b': runtimeConfig(),
        }),
        LOCAL_AI_GATEWAY_OPENAI_UPSTREAMS: JSON.stringify([
          {
            baseUrl: 'https://api.example.com/v1',
            models: ['qwen3-32b'],
            name: 'remote',
          },
        ]),
      },
      () => {
        const config = resolveGatewayConfig({ rootDir: process.cwd() });

        assert.equal(config.openAiUpstreams.length, 0);
        assert.deepEqual(config.managedRuntimes.map((runtime) => runtime.alias), ['qwen3-32b']);
      },
    );
  });

  it('loads managed runtime JSON overrides', async () => {
    await withEnv(
      {
        LOCAL_AI_GATEWAY_MANAGED_RUNTIMES: JSON.stringify({
          'qwen3-32b': runtimeConfig({ idle_ttl_ms: 1234 }),
          'minimax-m2.7': runtimeConfig({ enabled: false }),
        }),
      },
      () => {
        const config = resolveGatewayConfig();

        assert.deepEqual(
          config.managedRuntimes.map((runtime) => runtime.alias),
          ['qwen3-32b'],
        );
        assert.equal(config.managedRuntimes[0].idleTtlMs, 1234);
        assert.equal(config.managedRuntimes[0].maxConcurrency, 1);
      },
    );
  });

  it('rejects unmanaged loopback upstreams by default', async () => {
    await withEnv(
      {
        LOCAL_AI_GATEWAY_OPENAI_UPSTREAMS: JSON.stringify([
          {
            baseUrl: 'http://127.0.0.1:9999/v1',
            models: ['local-unmanaged'],
            name: 'local',
          },
        ]),
      },
      () => {
        const config = resolveGatewayConfig();
        assert.equal(config.openAiUpstreams.length, 0);
      },
    );
  });

  it('keeps external unmanaged upstreams as passive proxies', async () => {
    await withEnv(
      {
        LOCAL_AI_GATEWAY_OPENAI_UPSTREAMS: JSON.stringify([
          {
            baseUrl: 'https://api.example.com/v1',
            models: ['remote-model'],
            name: 'remote',
          },
        ]),
      },
      () => {
        const config = resolveGatewayConfig();
        assert.equal(config.openAiUpstreams.length, 1);
        assert.equal(config.openAiUpstreams[0].name, 'remote');
      },
    );
  });

  it('refuses non-loopback binds without auth', async () => {
    await withEnv({ LOCAL_AI_GATEWAY_HOST: '0.0.0.0' }, () => {
      assert.throws(
        () => resolveGatewayConfig(),
        /Refusing to bind 0\.0\.0\.0:8787 without auth/,
      );
    });
  });
});
