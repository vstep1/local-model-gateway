import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { DEFAULT_CONFIG_FILE } from '@local-model-gateway/core';

export interface EnvironmentInfo {
  arch: string;
  cwd: string;
  hasExistingConfig: boolean;
  llamaCliPath: string | null;
  llamaServerPath: string | null;
  nodePath: string | null;
  platform: NodeJS.Platform;
  totalMemoryGb: number;
}

function which(binary: string): string | null {
  const result = spawnSync('sh', ['-lc', `command -v ${binary}`], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function detectEnvironment(cwd = process.cwd()): EnvironmentInfo {
  return {
    arch: os.arch(),
    cwd,
    hasExistingConfig: existsSync(path.join(cwd, DEFAULT_CONFIG_FILE)),
    llamaCliPath: which('llama-cli'),
    llamaServerPath: which('llama-server'),
    nodePath: process.execPath || which('node'),
    platform: os.platform(),
    totalMemoryGb: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
  };
}

export function defaultConfig(env: EnvironmentInfo): Record<string, unknown> {
  const llamaCli = env.llamaCliPath ?? 'llama-cli';
  return {
    server: {
      host: '127.0.0.1',
      port: 8787,
    },
    paths: {
      data_dir: './data',
      db_path: './data/gateway.sqlite',
      models_dir: './models',
      model_source_dir: './runtime/model-source',
      llama_cli: llamaCli,
      base_model_path: './runtime/base.gguf',
    },
    default_model: 'ep2',
    startup_models: {},
    queue: {
      max_queue: 100,
      max_queue_wait_ms: 300000,
      history_ttl_days: 7,
    },
    generation: {
      ctx_size: 4096,
      max_tokens: 360,
      temperature: 0.8,
      top_p: 0.95,
      repeat_penalty: 1.0,
      gpu_layers: 'all',
    },
    allow_unmanaged_local_upstreams: false,
    runtimes: {
      'qwen3-32b': {
        enabled: false,
        base_url: 'http://127.0.0.1:18001/v1',
        health_url: 'http://127.0.0.1:18001/v1/models',
        service_script: './runtime-adapters/qwen3-32b-service.sh',
        start_args: ['start'],
        stop_args: ['stop'],
        idle_ttl_ms: 600000,
        load_timeout_ms: 900000,
        max_concurrency: 1,
        upstream_model: 'qwen3-32b',
        context_window: 131072,
        recommended_prompt_budget: 98304,
        supports_streaming: true,
        supports_reasoning: false,
        context_notes: 'Enable after installing a local qwen3-32b runtime service script.',
      },
      'minimax-m2.7': {
        enabled: false,
        base_url: 'http://127.0.0.1:8000/v1',
        health_url: 'http://127.0.0.1:8000/v1/models',
        service_script: './runtime-adapters/minimax-m27-service.sh',
        start_args: ['start'],
        stop_args: ['stop'],
        idle_ttl_ms: 3600000,
        load_timeout_ms: 1800000,
        max_concurrency: 1,
        upstream_model: 'MiniMaxAI/MiniMax-M2.7',
        context_window: 98304,
        recommended_prompt_budget: 65536,
        supports_streaming: true,
        supports_reasoning: true,
        context_notes: 'Large local runtime; enable only after confirming the model fits this machine.',
      },
    },
    openai_upstreams: [],
  };
}

export async function writeDefaultConfig(cwd = process.cwd(), overwrite = false): Promise<string> {
  const target = path.join(cwd, DEFAULT_CONFIG_FILE);
  if (existsSync(target) && !overwrite) {
    return target;
  }
  const env = detectEnvironment(cwd);
  const text = YAML.stringify(defaultConfig(env));
  await writeFile(target, text, 'utf8');
  return target;
}
