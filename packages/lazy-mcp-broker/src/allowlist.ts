import type { BrokerToolPolicy, DownstreamServerConfig, McpTool } from './types.js';

const DEFAULT_READ_ONLY_SERVERS = new Set(['ahrefs', 'pangram']);

const MUTATING_WORDS = new Set([
  'add',
  'append',
  'approve',
  'activate',
  'cancel',
  'copy',
  'create',
  'delete',
  'edit',
  'enqueue',
  'format',
  'grant',
  'import',
  'insert',
  'mark',
  'modify',
  'move',
  'pause',
  'permission',
  'permissions',
  'record',
  'remove',
  'replace',
  'reply',
  'revoke',
  'send',
  'share',
  'start',
  'stop',
  'submit',
  'sync',
  'trash',
  'update',
  'upload',
  'write',
]);

const READ_WORDS = new Set([
  'analyze',
  'analyse',
  'check',
  'compare',
  'diagnose',
  'export',
  'fetch',
  'find',
  'get',
  'health',
  'healthcheck',
  'inspect',
  'list',
  'lookup',
  'match',
  'metrics',
  'overview',
  'query',
  'read',
  'report',
  'schema',
  'search',
  'status',
  'summary',
]);

export function normalizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function toolWords(name: string): string[] {
  return normalizeToolName(name).split('_').filter(Boolean);
}

function hasAnyWord(name: string, words: Set<string>): boolean {
  return toolWords(name).some((word) => words.has(word));
}

function configuredList(value?: string[]): Set<string> {
  return new Set((value ?? []).map((item) => item.trim()).filter(Boolean));
}

function normalizePolicy(raw: Partial<BrokerToolPolicy> | undefined, fallback: BrokerToolPolicy): BrokerToolPolicy {
  const effect = raw?.effect === 'write' || raw?.effect === 'read' ? raw.effect : fallback.effect;
  const cost = raw?.cost === 'free' || raw?.cost === 'metered' || raw?.cost === 'unknown'
    ? raw.cost
    : fallback.cost;
  const confirmation = raw?.confirmation === 'required' || raw?.confirmation === 'never'
    ? raw.confirmation
    : fallback.confirmation;
  const timeoutMs = Number(raw?.timeoutMs ?? fallback.timeoutMs);
  return {
    effect,
    cost,
    confirmation,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback.timeoutMs,
  };
}

export function resolveToolPolicy(
  serverName: string,
  tool: McpTool,
  config: DownstreamServerConfig,
): BrokerToolPolicy {
  const include = configuredList(config.broker?.include);
  const exclude = configuredList(config.broker?.exclude);
  const base = normalizePolicy(config.broker?.default_policy, {
    confirmation: 'never',
    cost: 'unknown',
    effect: 'write',
    timeoutMs: Number(config.broker?.default_timeout_ms ?? 60_000) || 60_000,
  });
  const explicit = normalizePolicy(config.broker?.tools?.[tool.name], base);

  if (exclude.has(tool.name)) {
    return { ...explicit, effect: 'write' };
  }

  if (config.broker?.tools?.[tool.name]) {
    return explicit;
  }

  if (hasAnyWord(tool.name, MUTATING_WORDS)) {
    return { ...base, effect: 'write' };
  }

  if (include.size > 0) {
    return { ...base, effect: include.has(tool.name) ? 'read' : 'write' };
  }

  if (hasAnyWord(tool.name, READ_WORDS)) {
    return { ...base, effect: 'read' };
  }

  if (config.broker?.default_read_only === true || DEFAULT_READ_ONLY_SERVERS.has(serverName)) {
    return { ...base, effect: 'read' };
  }

  return base;
}

export function isReadOnlyTool(serverName: string, tool: McpTool, config: DownstreamServerConfig): boolean {
  const policy = resolveToolPolicy(serverName, tool, config);
  return policy.effect === 'read' && policy.confirmation !== 'required';
}
