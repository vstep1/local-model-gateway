import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeToolRecord, summarizeTool } from './catalog.js';
import { isReadOnlyTool, resolveToolPolicy } from './allowlist.js';
import { safeError } from './redact.js';
import type {
  BrokerConfig,
  BrokerToolRecord,
  ConnectedDownstream,
  DownstreamServerConfig,
  McpTool,
} from './types.js';

const RESULT_MAX_CHARS = Number(process.env.LAZY_MCP_BROKER_RESULT_MAX_CHARS || 12000);
const SPILL_DIR = process.env.LAZY_MCP_BROKER_SPILL_DIR || path.join(tmpdir(), 'lazy-mcp-broker-results');
const DEFAULT_CATALOG_CACHE_PATH = path.join(
  homedir(),
  '.cache',
  'local-model-gateway',
  'lazy-mcp-broker-catalog.json',
);
const CATALOG_CACHE_VERSION = 1;

export type LazyMcpBrokerOptions = {
  catalogCachePath?: string;
  refreshOnStart?: boolean;
};

type CallResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
};

type CatalogCache = {
  version: number;
  generatedAt: string;
  servers: Record<string, {
    refreshedAt: string;
    tools: McpTool[];
  }>;
};

function headers(config: DownstreamServerConfig): Record<string, string> {
  return { ...(config.headers ?? {}) };
}

function commandEnv(config: DownstreamServerConfig): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...(config.env ?? {}),
  };
}

function extractToolResult(result: unknown): { text?: string; structured?: unknown } {
  const typed = result as CallResult;
  const text = Array.isArray(typed.content)
    ? typed.content
        .map((item) => {
          if (item.type === 'text' && typeof item.text === 'string') return item.text;
          return JSON.stringify(item);
        })
        .join('\n')
        .trim()
    : '';
  return {
    text: text || undefined,
    structured: typed.structuredContent,
  };
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

async function compactResult(toolId: string, result: unknown): Promise<Record<string, unknown>> {
  const extracted = extractToolResult(result);
  const rawText = extracted.text ?? (typeof extracted.structured !== 'undefined' ? JSON.stringify(extracted.structured) : JSON.stringify(result));
  if (rawText.length <= RESULT_MAX_CHARS) {
    return {
      text: rawText,
      structured: extracted.structured,
      truncated: false,
    };
  }
  await mkdir(SPILL_DIR, { recursive: true });
  const filePath = path.join(
    SPILL_DIR,
    `${safeFilePart(toolId)}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  await writeFile(
    filePath,
    JSON.stringify({ tool_id: toolId, result }, null, 2),
    'utf8',
  );
  return {
    text: `[Large MCP tool result spilled to file: ${filePath}]`,
    structured: undefined,
    spilled_to_file: filePath,
    truncated: false,
    original_chars: rawText.length,
  };
}

function matchScore(record: BrokerToolRecord, terms: string[]): number {
  const haystack = `${record.server} ${record.name} ${record.description} ${record.parameterNames.join(' ')}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (record.name.toLowerCase().includes(term)) score += 5;
    if (record.server.toLowerCase().includes(term)) score += 3;
    if (record.description.toLowerCase().includes(term)) score += 2;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

async function listTools(client: Client): Promise<McpTool[]> {
  const result = await client.listTools();
  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

async function connectStdio(name: string, config: DownstreamServerConfig): Promise<ConnectedDownstream> {
  if (!config.command) {
    throw new Error(`Server ${name} is missing command`);
  }
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd,
    env: commandEnv(config),
  });
  const client = new Client({ name: `lazy-mcp-broker-${name}`, version: '1.0.0' });
  await client.connect(transport);
  return {
    name,
    config,
    client,
    status: 'connected',
    tools: await listTools(client),
  };
}

async function connectStreamableHttp(name: string, config: DownstreamServerConfig): Promise<ConnectedDownstream> {
  if (!config.url) {
    throw new Error(`Server ${name} is missing url`);
  }
  const client = new Client({ name: `lazy-mcp-broker-${name}`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: headers(config) },
  });
  await client.connect(transport);
  return {
    name,
    config,
    client,
    status: 'connected',
    tools: await listTools(client),
  };
}

async function connectSse(name: string, config: DownstreamServerConfig): Promise<ConnectedDownstream> {
  if (!config.url) {
    throw new Error(`Server ${name} is missing url`);
  }
  const client = new Client({ name: `lazy-mcp-broker-${name}`, version: '1.0.0' });
  const transport = new SSEClientTransport(new URL(config.url), {
    requestInit: { headers: headers(config) },
  });
  await client.connect(transport);
  return {
    name,
    config,
    client,
    status: 'connected',
    tools: await listTools(client),
  };
}

async function connectOne(name: string, config: DownstreamServerConfig): Promise<ConnectedDownstream> {
  if (config.url) {
    try {
      return await connectStreamableHttp(name, config);
    } catch (streamableError) {
      try {
        return await connectSse(name, config);
      } catch (sseError) {
        throw new Error(
          `streamable HTTP failed: ${safeError(streamableError)}; SSE failed: ${safeError(sseError)}`,
        );
      }
    }
  }
  return connectStdio(name, config);
}

export class LazyMcpBroker {
  private readonly servers = new Map<string, ConnectedDownstream>();
  private readonly catalog = new Map<string, BrokerToolRecord>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly connections = new Map<string, Promise<ConnectedDownstream>>();
  private readonly catalogCachePath: string;
  private readonly refreshOnStart: boolean;

  constructor(
    private readonly config: BrokerConfig,
    options: LazyMcpBrokerOptions = {},
  ) {
    this.catalogCachePath = options.catalogCachePath
      ?? process.env.LAZY_MCP_BROKER_CATALOG_CACHE?.trim()
      ?? DEFAULT_CATALOG_CACHE_PATH;
    this.refreshOnStart = options.refreshOnStart
      ?? parseBoolish(process.env.LAZY_MCP_BROKER_REFRESH_ON_START, false);
  }

  async initialize(): Promise<void> {
    for (const [name, serverConfig] of Object.entries(this.config.mcp_servers)) {
      this.servers.set(name, {
        name,
        config: serverConfig,
        status: 'not_connected',
        tools: [],
      });
    }
    await this.loadCatalogCache();
    if (this.refreshOnStart) {
      for (const name of this.servers.keys()) {
        this.scheduleCatalogRefresh(name);
      }
    }
  }

  listServers(): Record<string, unknown> {
    return {
      servers: Array.from(this.servers.values())
        .map((server) => {
          const serverTools = Array.from(this.catalog.values()).filter((tool) => tool.server === server.name);
          return {
            server: server.name,
            status: server.status,
            tool_count: server.tools.length,
            allowed_tool_count: serverTools.filter((tool) => tool.allowed).length,
            cached: server.tools.length > 0 && server.status !== 'connected',
            refreshing: this.refreshes.has(server.name),
            error: server.error,
          };
        })
        .sort((a, b) => a.server.localeCompare(b.server)),
    };
  }

  searchTools(query: string, server?: string, limit = 10): Record<string, unknown> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const cappedLimit = Math.min(Math.max(limit, 1), 50);
    const records = Array.from(this.catalog.values()).filter((record) => {
      if (!record.allowed) return false;
      if (server && record.server !== server) return false;
      if (terms.length === 0) return true;
      return matchScore(record, terms) > 0;
    });
    if (records.length === 0) {
      for (const name of this.refreshTargetsForSearch(query, server)) {
        this.scheduleCatalogRefresh(name);
      }
    }

    return {
      tools: records
        .map((record) => ({ record, score: terms.length === 0 ? 1 : matchScore(record, terms) }))
        .sort((a, b) => b.score - a.score || a.record.toolId.localeCompare(b.record.toolId))
        .slice(0, cappedLimit)
        .map(({ record }) => summarizeTool(record)),
    };
  }

  async describeTool(toolId: string): Promise<Record<string, unknown>> {
    const record = await this.resolveToolRecord(toolId, { keepConnected: false });
    if (!record) {
      throw new Error(`Unknown tool_id: ${toolId}`);
    }
    if (!record.allowed) {
      throw new Error(`Tool is not exposed by the read-only broker: ${toolId}`);
    }
    return {
      tool_id: record.toolId,
      server: record.server,
      name: record.name,
      description: record.description,
      input_schema: record.inputSchema,
    };
  }

  async callTool(toolId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const record = await this.resolveToolRecord(toolId, { keepConnected: true });
    if (!record) {
      throw new Error(`Unknown tool_id: ${toolId}`);
    }
    if (!record.allowed) {
      throw new Error(`Tool is not exposed by the read-only broker: ${toolId}`);
    }
    if (record.policy.confirmation === 'required') {
      throw new Error(`Tool requires explicit confirmation and is not callable through broker v1: ${toolId}`);
    }
    await this.ensureConnected(record.server);

    const result = await this.callWithReconnect(record, args);
    return {
      tool_id: record.toolId,
      server: record.server,
      name: record.name,
      result: await compactResult(record.toolId, result),
    };
  }

  private async resolveToolRecord(
    toolId: string,
    options: { keepConnected: boolean },
  ): Promise<BrokerToolRecord | undefined> {
    const cached = this.catalog.get(toolId);
    if (cached) return cached;

    const separator = toolId.indexOf(':');
    if (separator <= 0) return undefined;
    const serverName = toolId.slice(0, separator);
    if (!this.servers.has(serverName)) return undefined;
    await this.refreshServerCatalog(serverName, { keepConnected: options.keepConnected });
    return this.catalog.get(toolId);
  }

  private async callWithReconnect(
    record: BrokerToolRecord,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const first = await this.tryCall(record, args).catch(async (error) => {
      await this.reconnectServer(record.server);
      const server = this.servers.get(record.server);
      if (!server || server.status !== 'connected' || !server.client) {
        throw error;
      }
      return this.tryCall(record, args);
    });
    return first;
  }

  private async tryCall(
    record: BrokerToolRecord,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const server = this.servers.get(record.server);
    if (!server || server.status !== 'connected' || !server.client) {
      throw new Error(`Downstream server is not connected: ${record.server}`);
    }

    const timeoutMs = record.policy.timeoutMs;
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        server.client.callTool({ name: record.name, arguments: args }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Downstream tool timed out after ${timeoutMs}ms: ${record.toolId}`)),
            timeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async reconnectServer(name: string): Promise<void> {
    const current = this.servers.get(name);
    if (!current) return;
    try {
      await current.client?.close();
    } catch {
      // Best effort close before reconnecting.
    }

    try {
      await this.ensureConnected(name, { forceReconnect: true });
    } catch (error) {
      this.servers.set(name, {
        ...current,
        client: undefined,
        error: safeError(error),
        status: 'failed',
        tools: current.tools,
      });
    }
  }

  private async ensureConnected(
    name: string,
    options: { forceReconnect?: boolean } = {},
  ): Promise<ConnectedDownstream> {
    const current = this.servers.get(name);
    if (!current) {
      throw new Error(`Unknown downstream server: ${name}`);
    }
    if (!options.forceReconnect && current.status === 'connected' && current.client) {
      return current;
    }
    if (!options.forceReconnect) {
      const inflight = this.connections.get(name);
      if (inflight) return inflight;
      const refresh = this.refreshes.get(name);
      if (refresh) {
        await refresh.catch(() => undefined);
        const refreshed = this.servers.get(name);
        if (refreshed?.status === 'connected' && refreshed.client) {
          return refreshed;
        }
      }
    }

    const connection = (async () => {
      if (options.forceReconnect) {
        try {
          await current.client?.close();
        } catch {
          // Best effort close before reconnecting.
        }
      }
      this.servers.set(name, {
        ...current,
        client: undefined,
        status: 'refreshing',
        error: undefined,
      });
      try {
        const connected = await connectOne(name, current.config);
        this.applyServerTools(name, connected.tools, 'connected', connected.client);
        console.error(
          `[lazy-mcp-broker] connected ${name}: ${connected.tools.length} tools, ${
            connected.tools.filter((tool) => isReadOnlyTool(name, tool, current.config)).length
          } read-only exposed`,
        );
        await this.saveCatalogCache();
        return this.servers.get(name) as ConnectedDownstream;
      } catch (error) {
        const previous = this.servers.get(name) ?? current;
        this.servers.set(name, {
          ...previous,
          client: undefined,
          status: 'failed',
          error: safeError(error),
        });
        throw error;
      } finally {
        this.connections.delete(name);
      }
    })();

    this.connections.set(name, connection);
    return connection;
  }

  private scheduleCatalogRefresh(name: string): void {
    if (!this.servers.has(name) || this.refreshes.has(name) || this.connections.has(name)) {
      return;
    }
    const refresh = this.refreshServerCatalog(name, { keepConnected: false })
      .catch((error) => {
        console.error(`[lazy-mcp-broker] failed to refresh ${name}: ${safeError(error)}`);
      })
      .finally(() => {
        this.refreshes.delete(name);
      });
    this.refreshes.set(name, refresh);
  }

  private async refreshServerCatalog(
    name: string,
    options: { keepConnected: boolean },
  ): Promise<void> {
    const current = this.servers.get(name);
    if (!current) {
      throw new Error(`Unknown downstream server: ${name}`);
    }
    this.servers.set(name, {
      ...current,
      status: 'refreshing',
      error: undefined,
    });

    let connected: ConnectedDownstream | undefined;
    try {
      connected = await connectOne(name, current.config);
      this.applyServerTools(name, connected.tools, options.keepConnected ? 'connected' : 'cached', connected.client);
      console.error(
        `[lazy-mcp-broker] refreshed ${name}: ${connected.tools.length} tools, ${
          connected.tools.filter((tool) => isReadOnlyTool(name, tool, current.config)).length
        } read-only exposed`,
      );
      await this.saveCatalogCache();
    } catch (error) {
      const previous = this.servers.get(name) ?? current;
      this.servers.set(name, {
        ...previous,
        client: undefined,
        status: 'failed',
        error: safeError(error),
      });
      throw error;
    } finally {
      if (!options.keepConnected) {
        try {
          await connected?.client?.close();
        } catch {
          // Best effort close after catalog refresh.
        }
        const latest = this.servers.get(name);
        if (latest?.status === 'cached') {
          this.servers.set(name, { ...latest, client: undefined });
        }
      }
    }
  }

  private applyServerTools(
    name: string,
    tools: McpTool[],
    status: ConnectedDownstream['status'],
    client?: Client,
  ): void {
    const current = this.servers.get(name);
    if (!current) return;
    for (const toolId of Array.from(this.catalog.keys())) {
      if (toolId.startsWith(`${name}:`)) {
        this.catalog.delete(toolId);
      }
    }
    for (const tool of tools) {
      const policy = resolveToolPolicy(name, tool, current.config);
      const allowed = isReadOnlyTool(name, tool, current.config);
      const record = makeToolRecord(name, tool, allowed, policy);
      this.catalog.set(record.toolId, record);
    }
    this.servers.set(name, {
      ...current,
      client,
      status,
      error: undefined,
      tools,
    });
  }

  private refreshTargetsForSearch(query: string, server?: string): string[] {
    if (server) return this.servers.has(server) ? [server] : [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    return Array.from(this.servers.keys()).filter((name) => {
      const normalized = name.toLowerCase();
      return terms.some((term) => normalized.includes(term));
    });
  }

  private async loadCatalogCache(): Promise<void> {
    let parsed: CatalogCache;
    try {
      parsed = JSON.parse(await readFile(this.catalogCachePath, 'utf8')) as CatalogCache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[lazy-mcp-broker] ignored catalog cache: ${safeError(error)}`);
      }
      return;
    }
    if (parsed.version !== CATALOG_CACHE_VERSION || !parsed.servers || typeof parsed.servers !== 'object') {
      console.error('[lazy-mcp-broker] ignored catalog cache: incompatible version');
      return;
    }
    let loaded = 0;
    for (const [name, cached] of Object.entries(parsed.servers)) {
      if (!this.servers.has(name) || !Array.isArray(cached.tools)) continue;
      this.applyServerTools(name, cached.tools, 'cached');
      loaded += cached.tools.length;
    }
    if (loaded > 0) {
      console.error(`[lazy-mcp-broker] loaded ${loaded} cached tool definitions from ${this.catalogCachePath}`);
    }
  }

  private async saveCatalogCache(): Promise<void> {
    const servers: CatalogCache['servers'] = {};
    for (const server of this.servers.values()) {
      if (server.tools.length === 0) continue;
      servers[server.name] = {
        refreshedAt: new Date().toISOString(),
        tools: server.tools,
      };
    }
    await mkdir(path.dirname(this.catalogCachePath), { recursive: true });
    await writeFile(
      this.catalogCachePath,
      JSON.stringify({
        version: CATALOG_CACHE_VERSION,
        generatedAt: new Date().toISOString(),
        servers,
      } satisfies CatalogCache, null, 2),
      'utf8',
    );
  }
}

function parseBoolish(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}
