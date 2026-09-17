import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatewayLaunchdLabel, renderLaunchdPlist } from '@local-model-gateway/runtime-adapters';
import { resolveGatewayConfig } from '@local-model-gateway/core';

export interface ServiceInstallOptions {
  /** Override process values and command hooks for deterministic tests. */
  execPath?: string;
  gatewayEntrypoint?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  runLaunchctl?: (args: string[], ignoreFailure?: boolean) => void;
  validateRuntime?: (execPath: string, gatewayEntrypoint: string, cwd: string) => void;
}

function runLaunchctlDefault(args: string[], ignoreFailure = false): void {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  if (!ignoreFailure && result.status !== 0) {
    const output = [result.stderr, result.stdout]
      .map((value) => String(value ?? '').trim())
      .find(Boolean);
    const message = output || result.error?.message || `launchctl ${args.join(' ')} failed`;
    throw new Error(message);
  }
}

/**
 * Load the exact gateway entrypoint with the exact Node executable that will
 * be recorded in the plist. This catches native-module ABI failures before
 * the existing launchd service is booted out.
 */
export function validateGatewayRuntime(
  execPath: string,
  gatewayEntrypoint: string,
  cwd: string,
): void {
  const gatewayUrl = pathToFileURL(gatewayEntrypoint).href;
  const coreEntrypoint = createRequire(pathToFileURL(gatewayEntrypoint)).resolve('@local-model-gateway/core');
  const coreUrl = pathToFileURL(coreEntrypoint).href;
  const probe = spawnSync(
    execPath,
    [
      '--input-type=module',
      '-e',
      [
        `await import(${JSON.stringify(gatewayUrl)});`,
        `const { GatewayStore } = await import(${JSON.stringify(coreUrl)});`,
        "const store = new GatewayStore(':memory:');",
        "try { store.db.prepare('SELECT 1').get(); } finally { store.close(); }",
      ].join('\n'),
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10_000,
    },
  );
  if (probe.error || probe.status !== 0) {
    const output = [probe.stderr, probe.stdout]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .join('\n');
    const detail = output || probe.error?.message || `exit status ${probe.status}`;
    throw new Error(`Gateway runtime preflight failed using ${execPath}: ${detail}`);
  }
}

export async function installLaunchdService(
  cwd = process.cwd(),
  load = true,
  options: ServiceInstallOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new Error('service install currently supports macOS launchd. Use `local-model-gateway start` on other platforms.');
  }
  const config = resolveGatewayConfig({ rootDir: cwd });
  const label = gatewayLaunchdLabel();
  const execPath = options.execPath ?? process.execPath;
  const gatewayEntrypoint = options.gatewayEntrypoint
    ?? fileURLToPath(import.meta.resolve('@local-model-gateway/gateway'));

  // Validate before creating or replacing any launchd state. In particular,
  // this must run before bootout so a Node/better-sqlite3 ABI mismatch cannot
  // take down a currently healthy gateway.
  (options.validateRuntime ?? validateGatewayRuntime)(execPath, gatewayEntrypoint, cwd);

  const runLaunchctl = options.runLaunchctl ?? runLaunchctlDefault;
  const homeDir = options.homeDir ?? os.homedir();
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  const logDir = path.join(homeDir, 'Library', 'Logs', 'local-model-gateway');
  await mkdir(path.dirname(plistPath), { recursive: true });
  await mkdir(logDir, { recursive: true });
  const plist = renderLaunchdPlist({
    environment: {
      LOCAL_MODEL_GATEWAY_CONFIG: config.configPath ?? path.join(cwd, 'local-model-gateway.config.yaml'),
    },
    label,
    programArguments: [execPath, gatewayEntrypoint],
    standardErrorPath: path.join(logDir, 'stderr.log'),
    standardOutPath: path.join(logDir, 'stdout.log'),
    workingDirectory: cwd,
  });
  await writeFile(plistPath, plist, 'utf8');
  if (load) {
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    const target = `${domain}/${label}`;
    runLaunchctl(['bootout', domain, plistPath], true);
    runLaunchctl(['bootstrap', domain, plistPath]);
    runLaunchctl(['enable', target], true);
    runLaunchctl(['kickstart', '-k', target]);
  }
  return plistPath;
}
