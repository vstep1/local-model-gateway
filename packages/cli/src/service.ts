import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayLaunchdLabel, renderLaunchdPlist } from '@local-ai-gateway/runtime-adapters';
import { resolveGatewayConfig } from '@local-ai-gateway/core';

function runLaunchctl(args: string[]): void {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `launchctl ${args.join(' ')} failed`;
    throw new Error(message);
  }
}

export async function installLaunchdService(cwd = process.cwd(), load = true): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('service install currently supports macOS launchd. Use `local-ai-gateway start` on other platforms.');
  }
  const config = resolveGatewayConfig({ rootDir: cwd });
  const label = gatewayLaunchdLabel();
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'local-ai-gateway');
  await mkdir(path.dirname(plistPath), { recursive: true });
  await mkdir(logDir, { recursive: true });
  const plist = renderLaunchdPlist({
    environment: {
      LOCAL_AI_GATEWAY_CONFIG: config.configPath ?? path.join(cwd, 'local-ai-gateway.config.yaml'),
    },
    label,
    programArguments: [process.execPath, fileURLToPath(import.meta.resolve('@local-ai-gateway/gateway'))],
    standardErrorPath: path.join(logDir, 'stderr.log'),
    standardOutPath: path.join(logDir, 'stdout.log'),
    workingDirectory: cwd,
  });
  await writeFile(plistPath, plist, 'utf8');
  if (load) {
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    const target = `${domain}/${label}`;
    spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    runLaunchctl(['bootstrap', domain, plistPath]);
    spawnSync('launchctl', ['enable', target], { stdio: 'ignore' });
    runLaunchctl(['kickstart', '-k', target]);
  }
  return plistPath;
}
