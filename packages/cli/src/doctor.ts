import { accessSync, constants, existsSync } from 'node:fs';
import net from 'node:net';
import { detectEnvironment } from './init.js';
import { resolveGatewayConfig } from '@local-ai-gateway/core';
import type { ManagedRuntimeConfig } from '@local-ai-gateway/core';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  fix: string;
  name: string;
  ok: boolean;
  status?: DoctorStatus;
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function fileExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function loopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function runtimeHealth(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(750),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runtimeChecks(runtime: ManagedRuntimeConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [
    {
      name: `Runtime script exists for ${runtime.alias}`,
      ok: existsSync(runtime.serviceScript),
      fix: `Create ${runtime.serviceScript}, disable the runtime, or point service_script at a valid adapter.`,
    },
    {
      name: `Runtime script executable for ${runtime.alias}`,
      ok: fileExecutable(runtime.serviceScript),
      fix: `Run chmod +x ${runtime.serviceScript}, or point service_script at an executable adapter.`,
    },
    {
      name: `Runtime start/stop commands configured for ${runtime.alias}`,
      ok: runtime.startArgs.length > 0 && runtime.stopArgs.length > 0,
      fix: 'Set start_args and stop_args for this managed runtime.',
    },
    {
      name: `Runtime URLs are loopback for ${runtime.alias}`,
      ok: loopbackUrl(runtime.baseUrl) && loopbackUrl(runtime.healthUrl),
      fix: 'Use loopback base_url and health_url for local GPU-managed runtimes.',
    },
  ];

  const health = await runtimeHealth(runtime.healthUrl);
  checks.push({
    name: `Runtime health currently reachable for ${runtime.alias}`,
    ok: true,
    status: health.ok ? 'ok' : 'warn',
    fix: health.ok
      ? 'No action needed.'
      : `Not reachable now${health.status ? `, HTTP ${health.status}` : ''}. This is fine when the runtime is unloaded; the gateway will run ${runtime.serviceScript} ${runtime.startArgs.join(' ')} on demand.`,
  });

  return checks;
}

export async function runDoctor(cwd = process.cwd()): Promise<DoctorCheck[]> {
  const env = detectEnvironment(cwd);
  const checks: DoctorCheck[] = [
    {
      name: 'Node.js runtime',
      ok: Boolean(env.nodePath),
      fix: 'Install Node.js 22 or newer.',
    },
    {
      name: 'llama-cli available',
      ok: Boolean(env.llamaCliPath),
      fix: 'Install llama.cpp and make llama-cli available on PATH, or set paths.llama_cli.',
    },
    {
      name: 'llama-server available',
      ok: Boolean(env.llamaServerPath),
      fix: 'Install llama.cpp and make llama-server available on PATH before enabling managed runtime presets.',
    },
  ];

  try {
    const config = resolveGatewayConfig({ rootDir: cwd });
    checks.push({
      name: 'Config file parsed',
      ok: true,
      fix: 'No action needed.',
    });
    checks.push({
      name: 'Data directory exists or can be created',
      ok: existsSync(config.dataDir) || existsSync(cwd),
      fix: `Create ${config.dataDir} or fix paths.data_dir.`,
    });
    checks.push({
      name: `Port ${config.port} currently free`,
      ok: !(await portOpen(config.host, config.port)),
      fix: `Stop the process using ${config.host}:${config.port} or choose another server.port.`,
    });
    if (
      config.managedRuntimes.length === 0 &&
      config.openAiUpstreams.length === 0 &&
      Object.keys(config.startupModels).length === 0
    ) {
      checks.push({
        name: 'At least one routable model configured',
        ok: true,
        status: 'warn',
        fix: 'Enable a managed runtime, add an OpenAI upstream, or configure startup_models before expecting /v1/models to list models.',
      });
    }
    for (const runtime of config.managedRuntimes) {
      checks.push(...await runtimeChecks(runtime));
    }
  } catch (error) {
    checks.push({
      name: 'Config file parsed',
      ok: false,
      fix: error instanceof Error ? error.message : String(error),
    });
  }

  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => {
      const status = check.status ?? (check.ok ? 'ok' : 'fail');
      const detail = status === 'ok'
        ? ''
        : `\n      ${status === 'warn' ? 'note' : 'fix'}: ${check.fix}`;
      return `${status}  ${check.name}${detail}`;
    })
    .join('\n');
}
