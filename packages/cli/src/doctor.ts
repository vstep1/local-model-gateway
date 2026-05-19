import { existsSync } from 'node:fs';
import net from 'node:net';
import { detectEnvironment } from './init.js';
import { resolveGatewayConfig } from '@local-ai-gateway/core';

export interface DoctorCheck {
  fix: string;
  name: string;
  ok: boolean;
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
    for (const runtime of config.managedRuntimes) {
      checks.push({
        name: `Runtime script exists for ${runtime.alias}`,
        ok: existsSync(runtime.serviceScript),
        fix: `Create ${runtime.serviceScript}, disable the runtime, or point service_script at a valid adapter.`,
      });
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
    .map((check) => `${check.ok ? 'ok' : 'fail'}  ${check.name}${check.ok ? '' : `\n      fix: ${check.fix}`}`)
    .join('\n');
}
