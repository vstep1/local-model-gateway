import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_CONFIG_FILE, resolveGatewayConfig } from '@local-model-gateway/core';
import type { GatewayConfig, ManagedRuntimeConfig } from '@local-model-gateway/core';
import { detectEnvironment } from './init.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  evidence?: Record<string, unknown>;
  fix: string;
  fixPlan?: string[];
  id?: string;
  message?: string;
  name: string;
  ok: boolean;
  safeToAutoFix?: boolean;
  status?: DoctorStatus;
  whyItMatters?: string;
}

export interface DoctorJsonCheck {
  evidence: Record<string, unknown>;
  fix: string;
  id: string;
  message: string;
  safe_to_auto_fix: boolean;
  status: DoctorStatus;
  why_it_matters: string;
}

export interface DoctorReport {
  checks: DoctorJsonCheck[];
  status: DoctorStatus;
  summary: Record<DoctorStatus, number>;
}

export interface DoctorProcess {
  args: string;
  command: string;
  pid: number;
  ppid: number | null;
}

export interface DoctorHttpResult {
  body?: unknown;
  error?: string;
  ok: boolean;
  status?: number;
  text?: string;
}

export interface DoctorProbes {
  httpGet(url: string, headers?: Record<string, string>): Promise<DoctorHttpResult>;
  listeningPorts(pid: number): Promise<number[]>;
  listProcesses(): Promise<DoctorProcess[]>;
  portOpen(host: string, port: number): Promise<boolean>;
}

export interface RunDoctorOptions {
  probes?: Partial<DoctorProbes>;
}

type JsonRecord = Record<string, unknown>;

function defaultPortOpen(host: string, port: number): Promise<boolean> {
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

async function defaultHttpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<DoctorHttpResult> {
  try {
    const response = await fetch(url, {
      headers,
      method: 'GET',
      signal: AbortSignal.timeout(1000),
    });
    const text = await response.text();
    let body: unknown;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    return { body, ok: response.ok, status: response.status, text };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
}

function defaultListProcesses(): Promise<DoctorProcess[]> {
  const result = spawnSync('ps', ['-axo', 'pid,ppid,comm,args'], { encoding: 'utf8' });
  if (result.status !== 0) return Promise.resolve([]);
  const processes = result.stdout
    .split('\n')
    .slice(1)
    .map((line): DoctorProcess | null => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        args: match[4] ?? '',
        command: match[3] ?? '',
        pid: Number(match[1]),
        ppid: Number(match[2]),
      };
    })
    .filter((process): process is DoctorProcess => Boolean(process));
  return Promise.resolve(processes);
}

function defaultListeningPorts(pid: number): Promise<number[]> {
  const result = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return Promise.resolve([]);
  const ports = result.stdout
    .split('\n')
    .filter((line) => line.includes('(LISTEN)'))
    .map((line) => line.match(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/))
    .map((match) => Number(match?.[1]))
    .filter((port) => Number.isFinite(port));
  return Promise.resolve(Array.from(new Set(ports)).sort((a, b) => a - b));
}

function probesWithDefaults(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    httpGet: overrides.httpGet ?? defaultHttpGet,
    listeningPorts: overrides.listeningPorts ?? defaultListeningPorts,
    listProcesses: overrides.listProcesses ?? defaultListProcesses,
    portOpen: overrides.portOpen ?? defaultPortOpen,
  };
}

function checkStatus(check: DoctorCheck): DoctorStatus {
  return check.status ?? (check.ok ? 'ok' : 'fail');
}

function fileExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function loopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function portFromUrl(value: string): number | null {
  try {
    const url = new URL(value);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function truncate(value: string, maxLength = 240): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'check';
}

async function runtimeHealth(
  probes: DoctorProbes,
  url: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const response = await probes.httpGet(url);
  return { error: response.error, ok: response.ok, status: response.status };
}

async function runtimeChecks(
  runtime: ManagedRuntimeConfig,
  probes: DoctorProbes,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [
    {
      fix: `Create ${runtime.serviceScript}, disable the runtime, or point service_script at a valid adapter.`,
      id: `runtime_script_exists_${slug(runtime.alias)}`,
      name: `Runtime script exists for ${runtime.alias}`,
      ok: existsSync(runtime.serviceScript),
      whyItMatters: 'The gateway cannot start this managed runtime without its service adapter.',
    },
    {
      fix: `Run chmod +x ${runtime.serviceScript}, or point service_script at an executable adapter.`,
      id: `runtime_script_executable_${slug(runtime.alias)}`,
      name: `Runtime script executable for ${runtime.alias}`,
      ok: fileExecutable(runtime.serviceScript),
      whyItMatters: 'The coordinator invokes runtime service scripts directly.',
    },
    {
      fix: 'Set start_args and stop_args for this managed runtime.',
      id: `runtime_start_stop_args_${slug(runtime.alias)}`,
      name: `Runtime start/stop commands configured for ${runtime.alias}`,
      ok: runtime.startArgs.length > 0 && runtime.stopArgs.length > 0,
      whyItMatters: 'Managed runtimes need explicit lifecycle commands.',
    },
    {
      fix: 'Use loopback base_url and health_url for local GPU-managed runtimes.',
      id: `runtime_loopback_urls_${slug(runtime.alias)}`,
      name: `Runtime URLs are loopback for ${runtime.alias}`,
      ok: loopbackUrl(runtime.baseUrl) && loopbackUrl(runtime.healthUrl),
      whyItMatters: 'Local GPU runtimes should not be exposed on public interfaces.',
    },
  ];

  const health = await runtimeHealth(probes, runtime.healthUrl);
  checks.push({
    evidence: {
      error: health.error,
      status: health.status,
      url: runtime.healthUrl,
    },
    fix: health.ok
      ? 'No action needed.'
      : `Not reachable now${health.status ? `, HTTP ${health.status}` : ''}. This is fine when the runtime is unloaded; the gateway will run ${runtime.serviceScript} ${runtime.startArgs.join(' ')} on demand.`,
    id: `runtime_health_${slug(runtime.alias)}`,
    name: `Runtime health currently reachable for ${runtime.alias}`,
    ok: true,
    status: health.ok ? 'ok' : 'warn',
    whyItMatters: 'Runtime health is useful context, but an unloaded on-demand runtime may be healthy only after admission.',
  });

  return checks;
}

function configFilePath(cwd: string, config: GatewayConfig | null): string {
  return config?.configPath ?? path.join(cwd, DEFAULT_CONFIG_FILE);
}

function readRawConfig(cwd: string, config: GatewayConfig | null): JsonRecord {
  const filePath = configFilePath(cwd, config);
  if (!existsSync(filePath)) return {};
  const parsed = YAML.parse(readFileSync(filePath, 'utf8')) as unknown;
  return asRecord(parsed);
}

function rawUpstreamRecords(rawConfig: JsonRecord): JsonRecord[] {
  const fromFile = rawConfig.openai_upstreams ?? rawConfig.openAiUpstreams;
  const records = Array.isArray(fromFile) ? fromFile.map(asRecord) : [];
  const rawEnv = process.env.LOCAL_MODEL_GATEWAY_OPENAI_UPSTREAMS;
  if (!rawEnv) return records;
  try {
    const parsed = JSON.parse(rawEnv) as unknown;
    if (Array.isArray(parsed)) return [...records, ...parsed.map(asRecord)];
  } catch {
    return records;
  }
  return records;
}

function unmanagedLoopbackChecks(config: GatewayConfig, rawConfig: JsonRecord): DoctorCheck[] {
  const upstreams = rawUpstreamRecords(rawConfig)
    .map((record, index) => ({
      baseUrl: String(record.baseUrl ?? record.base_url ?? ''),
      name: String(record.name ?? `upstream-${index + 1}`),
    }))
    .filter((upstream) => upstream.baseUrl && loopbackUrl(upstream.baseUrl));

  if (upstreams.length === 0 || config.allowUnmanagedLocalUpstreams) {
    return [{
      fix: 'No action needed.',
      id: 'unmanaged_loopback_upstreams',
      name: 'No blocked unmanaged loopback upstreams configured',
      ok: true,
      whyItMatters: 'Loopback upstreams that bypass managed runtimes can evade GPU residency scheduling.',
    }];
  }

  return [{
    evidence: { upstreams },
    fix: 'Remove these loopback upstreams or convert them into managed runtimes. Only set allow_unmanaged_local_upstreams=true for an intentional isolation case.',
    id: 'unmanaged_loopback_upstreams',
    name: 'Unmanaged loopback upstreams configured',
    ok: false,
    whyItMatters: 'Unmanaged local upstreams can bypass the shared GPU coordinator and dashboard.',
  }];
}

function authHeaders(config: GatewayConfig): Record<string, string> | undefined {
  return config.authToken ? { authorization: `Bearer ${config.authToken}` } : undefined;
}

async function gatewayEndpointChecks(
  config: GatewayConfig,
  probes: DoctorProbes,
): Promise<{ checks: DoctorCheck[]; statusBody: unknown | null }> {
  const checks: DoctorCheck[] = [];
  const baseUrl = `http://${config.host}:${config.port}`;
  const open = await probes.portOpen(config.host, config.port);
  if (!open) {
    checks.push({
      evidence: { host: config.host, port: config.port },
      fix: `Start the gateway with local-model-gateway start or service install when you are ready to serve clients.`,
      id: 'configured_gateway_port',
      name: `Port ${config.port} currently free`,
      ok: true,
      whyItMatters: 'A free configured port is expected before first start.',
    });
    checks.push({
      evidence: { base_url: baseUrl },
      fix: `Start the gateway, then rerun local-model-gateway doctor --json.`,
      id: 'gateway_not_running',
      name: 'Gateway endpoints not checked because the gateway is not running',
      ok: true,
      status: 'warn',
      whyItMatters: 'Endpoint checks confirm clients can actually use the configured gateway.',
    });
    return { checks, statusBody: null };
  }

  const endpoints = [
    { id: 'gateway_health', name: 'Gateway /health reachable', path: '/health', protected: false },
    { id: 'gateway_status', name: 'Gateway /status reachable', path: '/status', protected: true },
    { id: 'gateway_models', name: 'Gateway /v1/models reachable', path: '/v1/models', protected: true },
    { id: 'gateway_dashboard', name: 'Gateway /dashboard reachable', path: '/dashboard', protected: false },
    {
      id: 'gateway_discovery_manifest',
      name: 'Gateway discovery manifest reachable',
      path: '/.well-known/local-model-gateway.json',
      protected: false,
    },
  ];

  let statusBody: unknown | null = null;
  const headers = authHeaders(config);
  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint.path}`;
    const response = await probes.httpGet(url, endpoint.protected ? headers : undefined);
    if (endpoint.path === '/status' && response.ok) statusBody = response.body ?? null;
    checks.push({
      evidence: {
        error: response.error,
        status: response.status,
        url,
      },
      fix: response.ok
        ? 'No action needed.'
        : `Expected HTTP 200 from ${url}. If another service owns this port, stop it; otherwise restart the gateway and rerun doctor.`,
      id: endpoint.id,
      name: endpoint.name,
      ok: response.ok,
      whyItMatters: 'Clients and agents rely on the gateway protocol endpoints instead of framework-specific integration.',
    });
  }

  return { checks, statusBody };
}

function processText(process: DoctorProcess): string {
  return `${process.command} ${process.args}`;
}

function processBaseName(process: DoctorProcess): string {
  return path.basename(process.command || process.args.split(/\s+/)[0] || '');
}

function argvBaseName(process: DoctorProcess): string {
  return path.basename(process.args.split(/\s+/)[0] || '');
}

function isGatewayProcess(process: DoctorProcess): boolean {
  const text = processText(process);
  return (
    text.includes('/packages/gateway/dist/src/index.js') ||
    text.includes('@local-model-gateway/gateway') ||
    text.includes('local-model-gateway/packages/gateway')
  );
}

function isLlamaCliProcess(process: DoctorProcess): boolean {
  return processBaseName(process) === 'llama-cli' || argvBaseName(process) === 'llama-cli';
}

function isLlamaServerProcess(process: DoctorProcess): boolean {
  return processBaseName(process) === 'llama-server' || argvBaseName(process) === 'llama-server';
}

function processEvidence(process: DoctorProcess, ports: number[] = []): Record<string, unknown> {
  return {
    args: truncate(process.args),
    command: process.command,
    pid: process.pid,
    ports,
    ppid: process.ppid,
  };
}

function arrayFromStatus(value: unknown, key: string): JsonRecord[] {
  const record = asRecord(value);
  const items = record[key];
  return Array.isArray(items) ? items.map(asRecord) : [];
}

async function processGuardChecks(
  config: GatewayConfig,
  probes: DoctorProbes,
  statusBody: unknown | null,
): Promise<DoctorCheck[]> {
  const processes = await probes.listProcesses();
  const gatewayProcesses = processes.filter(isGatewayProcess);
  const siblings: Array<Record<string, unknown>> = [];
  for (const process of gatewayProcesses) {
    const ports = await probes.listeningPorts(process.pid);
    for (const port of ports) {
      if (port !== config.port) {
        siblings.push(processEvidence(process, [port]));
      }
    }
  }

  const checks: DoctorCheck[] = [];
  if (siblings.length > 0) {
    checks.push({
      evidence: { siblings },
      fix: `Stop sibling local-model-gateway processes and route clients to http://127.0.0.1:${config.port}/v1.`,
      fixPlan: [
        `Stop the sibling local-model-gateway process(es): ${siblings.map((item) => `PID ${item.pid}`).join(', ')}.`,
        `Update clients and benchmarks to use http://127.0.0.1:${config.port}/v1.`,
        'Rerun local-model-gateway doctor --json and confirm the dashboard reflects active work.',
      ],
      id: 'sibling_gateway_detected',
      message: `Another local-model-gateway is listening outside the configured port ${config.port}.`,
      name: 'Sibling gateway process detected',
      ok: false,
      whyItMatters: 'A sibling gateway bypasses the shared GPU queue and can make /dashboard falsely show the machine as idle.',
    });
  } else {
    checks.push({
      fix: 'No action needed.',
      id: 'sibling_gateway_detected',
      name: 'No sibling gateway processes detected',
      ok: true,
      whyItMatters: 'All local clients should share one GPU admission path.',
    });
  }

  const activeWork = arrayFromStatus(statusBody, 'active_work');
  const activeLlamaCliRuntime = activeWork.some((item) => (
    item.runtimeAdapter === 'llama_cli' ||
    item.runtimeMode === 'one_shot_command' ||
    item.kind === 'exclusive' ||
    item.type === 'exclusive'
  ));
  const managedRuntimePorts = new Set(
    config.managedRuntimes
      .flatMap((runtime) => [runtime.baseUrl, runtime.healthUrl])
      .map(portFromUrl)
      .filter((port): port is number => typeof port === 'number'),
  );
  const bypasses: Array<Record<string, unknown>> = [];
  const unverified: Array<Record<string, unknown>> = [];

  for (const process of processes.filter((item) => isLlamaCliProcess(item) || isLlamaServerProcess(item))) {
    const ports = await probes.listeningPorts(process.pid);
    if (isLlamaCliProcess(process)) {
      if (!activeLlamaCliRuntime) {
        bypasses.push(processEvidence(process, ports));
      }
      continue;
    }

    const configuredRuntime = ports.some((port) => managedRuntimePorts.has(port));
    if (!configuredRuntime) {
      bypasses.push(processEvidence(process, ports));
    } else if (!statusBody) {
      unverified.push(processEvidence(process, ports));
    }
  }

  if (bypasses.length > 0) {
    checks.push({
      evidence: { processes: bypasses },
      fix: `Route local llama.cpp work through http://127.0.0.1:${config.port}/v1 or declare it as a managed runtime or one-shot runtime adapter job before running it.`,
      fixPlan: [
        'Stop or let the direct llama.cpp process finish.',
        `Re-run the workload through http://127.0.0.1:${config.port}/v1 so it appears in /status and /dashboard.`,
        'If this is a legitimate runtime, add it to managed runtimes instead of starting it manually.',
      ],
      id: 'direct_llama_process_bypass',
      name: 'Direct llama.cpp process appears to bypass the gateway',
      ok: false,
      whyItMatters: 'Direct llama.cpp processes can consume GPU outside the coordinator, queue, and dashboard.',
    });
  } else if (unverified.length > 0) {
    checks.push({
      evidence: { processes: unverified },
      fix: 'Start or repair the gateway status endpoint so these managed runtime processes can be verified.',
      id: 'direct_llama_process_bypass',
      name: 'llama-server process could not be verified against gateway status',
      ok: true,
      status: 'warn',
      whyItMatters: 'A configured runtime may be fine, but without /status doctor cannot prove it is coordinated.',
    });
  } else {
    checks.push({
      fix: 'No action needed.',
      id: 'direct_llama_process_bypass',
      name: 'No direct llama.cpp bypass processes detected',
      ok: true,
      whyItMatters: 'GPU-bound work should be visible through gateway status.',
    });
  }

  return checks;
}

export async function runDoctor(
  cwd = process.cwd(),
  options: RunDoctorOptions = {},
): Promise<DoctorCheck[]> {
  const probes = probesWithDefaults(options.probes);
  const env = detectEnvironment(cwd);
  const checks: DoctorCheck[] = [
    {
      fix: 'Install Node.js 22 or newer.',
      id: 'node_runtime',
      name: 'Node.js runtime',
      ok: Boolean(env.nodePath),
      whyItMatters: 'The gateway and CLI are Node.js packages.',
    },
  ];

  try {
    const config = resolveGatewayConfig({ rootDir: cwd });
    const hasStartupModels = Object.keys(config.startupModels).length > 0;
    const mayUseLlamaServer = config.managedRuntimes.some((runtime) => (
      /llama|qwen|minimax/i.test([
        runtime.alias,
        runtime.serviceScript,
        runtime.upstreamModel,
      ].join(' '))
    ));

    checks.push({
      evidence: {
        path: env.llamaCliPath,
        required: hasStartupModels,
      },
      fix: hasStartupModels
        ? 'Install llama.cpp and make llama-cli available on PATH, or set paths.llama_cli.'
        : 'Install llama.cpp before configuring startup_models or one-shot LoRA jobs.',
      id: 'llama_cli_available',
      name: 'llama-cli available when LoRA jobs need it',
      ok: Boolean(env.llamaCliPath) || !hasStartupModels,
      whyItMatters: 'Exclusive LoRA jobs use llama-cli, but managed runtimes and external upstreams do not require it.',
    });
    checks.push({
      evidence: {
        path: env.llamaServerPath,
        runtime_count: config.managedRuntimes.length,
      },
      fix: mayUseLlamaServer
        ? 'Install llama.cpp and make llama-server available on PATH before using llama-server-based runtime examples.'
        : 'No action needed unless your service_script calls llama-server.',
      id: 'llama_server_available',
      name: 'llama-server available when runtime scripts need it',
      ok: Boolean(env.llamaServerPath) || !mayUseLlamaServer,
      status: !env.llamaServerPath && mayUseLlamaServer ? 'warn' : undefined,
      whyItMatters: 'Some examples use llama-server, but custom managed runtime service scripts may use another OpenAI-compatible server.',
    });
    checks.push({
      fix: 'No action needed.',
      id: 'config_file_parsed',
      name: 'Config file parsed',
      ok: true,
      whyItMatters: 'Doctor cannot reason about runtimes or ports without a valid config.',
    });
    checks.push({
      fix: `Create ${config.dataDir} or fix paths.data_dir.`,
      id: 'data_directory_available',
      name: 'Data directory exists or can be created',
      ok: existsSync(config.dataDir) || existsSync(cwd),
      whyItMatters: 'The SQLite queue and runtime state need a writable data directory.',
    });

    const rawConfig = readRawConfig(cwd, config);
    checks.push(...unmanagedLoopbackChecks(config, rawConfig));
    const endpointResult = await gatewayEndpointChecks(config, probes);
    checks.push(...endpointResult.checks);
    checks.push(...await processGuardChecks(config, probes, endpointResult.statusBody));

    if (
      config.managedRuntimes.length === 0 &&
      config.openAiUpstreams.length === 0 &&
      Object.keys(config.startupModels).length === 0
    ) {
      checks.push({
        fix: 'Enable a managed runtime, add an OpenAI upstream, or configure startup_models before expecting /v1/models to list models.',
        id: 'routable_model_configured',
        name: 'At least one routable model configured',
        ok: true,
        status: 'warn',
        whyItMatters: 'Clients cannot request a model until at least one route can serve it.',
      });
    }
    for (const runtime of config.managedRuntimes) {
      checks.push(...await runtimeChecks(runtime, probes));
    }
  } catch (error) {
    checks.push({
      fix: error instanceof Error ? error.message : String(error),
      id: 'config_file_parsed',
      name: 'Config file parsed',
      ok: false,
      whyItMatters: 'Fix config before starting or installing the gateway.',
    });
  }

  return checks;
}

export function createDoctorReport(checks: DoctorCheck[]): DoctorReport {
  const summary: Record<DoctorStatus, number> = { fail: 0, ok: 0, warn: 0 };
  const jsonChecks = checks.map((check): DoctorJsonCheck => {
    const status = checkStatus(check);
    summary[status] += 1;
    return {
      evidence: check.evidence ?? {},
      fix: check.fix,
      id: check.id ?? slug(check.name),
      message: check.message ?? check.name,
      safe_to_auto_fix: check.safeToAutoFix ?? false,
      status,
      why_it_matters: check.whyItMatters ?? 'This affects local gateway readiness.',
    };
  });
  const status: DoctorStatus = summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'ok';
  return { checks: jsonChecks, status, summary };
}

export function formatDoctorJson(checks: DoctorCheck[]): string {
  return `${JSON.stringify(createDoctorReport(checks), null, 2)}\n`;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => {
      const status = checkStatus(check);
      const detail = status === 'ok'
        ? ''
        : `\n      ${status === 'warn' ? 'note' : 'fix'}: ${check.fix}`;
      return `${status}  ${check.name}${detail}`;
    })
    .join('\n');
}

function fixPlanPriority(check: DoctorCheck): number {
  const priorities: Record<string, number> = {
    sibling_gateway_detected: 10,
    direct_llama_process_bypass: 20,
    unmanaged_loopback_upstreams: 30,
    config_file_parsed: 40,
    node_runtime: 50,
    llama_cli_available: 60,
    llama_server_available: 70,
  };
  return priorities[check.id ?? ''] ?? 100;
}

export function formatFixPlan(checks: DoctorCheck[]): string {
  const actionable = checks
    .filter((check) => checkStatus(check) === 'fail')
    .sort((a, b) => fixPlanPriority(a) - fixPlanPriority(b));

  if (actionable.length === 0) {
    return [
      'Local Model Gateway doctor fix plan',
      '',
      'No fix plan needed. All doctor checks are passing.',
    ].join('\n');
  }

  const lines = [
    'Local Model Gateway doctor fix plan',
    '',
    'Read-only plan. Doctor did not edit configs, stop services, or kill processes.',
    '',
  ];
  let step = 1;
  for (const check of actionable) {
    const actions = check.fixPlan && check.fixPlan.length > 0 ? check.fixPlan : [check.fix];
    lines.push(`${step}. ${check.message ?? check.name}`);
    for (const action of actions) {
      lines.push(`   - ${action}`);
    }
    step += 1;
  }
  lines.push(`${step}. Rerun local-model-gateway doctor --json.`);
  return lines.join('\n');
}
