import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { BrokerConfig, BrokerToolPolicy, DownstreamServerConfig } from './types.js';

const DEFAULT_CONFIG_PATH = path.join(
  homedir(),
  '.config',
  'local-ai-gateway',
  'lazy-mcp-broker.yaml',
);

function parseBoolish(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }
  return value !== false;
}

function normalizeServerConfig(raw: unknown): DownstreamServerConfig {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const cfg = raw as DownstreamServerConfig;
  const tools = cfg.broker?.tools
    ? Object.fromEntries(
        Object.entries(cfg.broker.tools)
          .map(([name, policy]) => [name, normalizePolicyObject(policy)] as const)
          .filter((entry): entry is readonly [string, Partial<BrokerToolPolicy>] => Boolean(entry[1])),
      )
    : undefined;
  const broker = cfg.broker
    ? {
        ...cfg.broker,
        default_timeout_ms: cfg.broker.default_timeout_ms === undefined
          ? undefined
          : Number(cfg.broker.default_timeout_ms),
        default_policy: normalizePolicyObject(cfg.broker.default_policy),
        tools,
      }
    : undefined;
  return {
    ...cfg,
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
    broker,
    env: cfg.env ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)])) : undefined,
    headers: cfg.headers
      ? Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, String(v)]))
      : undefined,
  };
}

function normalizePolicyObject(raw: unknown): Partial<BrokerToolPolicy> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const timeout = record.timeoutMs ?? record.timeout_ms;
  return {
    ...(record.effect ? { effect: String(record.effect) as BrokerToolPolicy['effect'] } : {}),
    ...(record.cost ? { cost: String(record.cost) as BrokerToolPolicy['cost'] } : {}),
    ...(record.confirmation
      ? { confirmation: String(record.confirmation) as BrokerToolPolicy['confirmation'] }
      : {}),
    ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
  };
}

export function getConfigPath(): string {
  return process.env.LAZY_MCP_BROKER_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
}

export function loadBrokerConfig(configPath = getConfigPath()): BrokerConfig {
  const parsed = YAML.parse(readFileSync(configPath, 'utf8')) as Partial<BrokerConfig> | null;
  const rawServers = parsed?.mcp_servers;
  if (!rawServers || typeof rawServers !== 'object') {
    throw new Error(`Broker config must contain top-level mcp_servers: ${configPath}`);
  }

  const mcpServers: Record<string, DownstreamServerConfig> = {};
  for (const [name, raw] of Object.entries(rawServers)) {
    if (name === 'lazy-mcp-broker') {
      continue;
    }
    const cfg = normalizeServerConfig(raw);
    if (!parseBoolish(cfg.enabled)) {
      continue;
    }
    mcpServers[name] = cfg;
  }

  return { mcp_servers: mcpServers };
}
