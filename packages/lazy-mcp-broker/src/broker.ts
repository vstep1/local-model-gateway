import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

type CallResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
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

  constructor(private readonly config: BrokerConfig) {}

  async initialize(): Promise<void> {
    const entries = Object.entries(this.config.mcp_servers);
    await Promise.all(
      entries.map(async ([name, serverConfig]) => {
        try {
          const connected = await connectOne(name, serverConfig);
          this.servers.set(name, connected);
          for (const tool of connected.tools) {
            const policy = resolveToolPolicy(name, tool, serverConfig);
            const allowed = isReadOnlyTool(name, tool, serverConfig);
            const record = makeToolRecord(name, tool, allowed, policy);
            this.catalog.set(record.toolId, record);
          }
          console.error(
            `[lazy-mcp-broker] connected ${name}: ${connected.tools.length} tools, ${
              connected.tools.filter((tool) => isReadOnlyTool(name, tool, serverConfig)).length
            } read-only exposed`,
          );
        } catch (error) {
          this.servers.set(name, {
            name,
            config: serverConfig,
            status: 'failed',
            error: safeError(error),
            tools: [],
          });
          console.error(`[lazy-mcp-broker] failed to connect ${name}: ${safeError(error)}`);
        }
      }),
    );
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

    return {
      tools: records
        .map((record) => ({ record, score: terms.length === 0 ? 1 : matchScore(record, terms) }))
        .sort((a, b) => b.score - a.score || a.record.toolId.localeCompare(b.record.toolId))
        .slice(0, cappedLimit)
        .map(({ record }) => summarizeTool(record)),
    };
  }

  describeTool(toolId: string): Record<string, unknown> {
    const record = this.catalog.get(toolId);
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
    const record = this.catalog.get(toolId);
    if (!record) {
      throw new Error(`Unknown tool_id: ${toolId}`);
    }
    if (!record.allowed) {
      throw new Error(`Tool is not exposed by the read-only broker: ${toolId}`);
    }
    if (record.policy.confirmation === 'required') {
      throw new Error(`Tool requires explicit confirmation and is not callable through broker v1: ${toolId}`);
    }
    const server = this.servers.get(record.server);
    if (!server || server.status !== 'connected' || !server.client) {
      throw new Error(`Downstream server is not connected: ${record.server}`);
    }

    const result = await this.callWithReconnect(record, args);
    return {
      tool_id: record.toolId,
      server: record.server,
      name: record.name,
      result: await compactResult(record.toolId, result),
    };
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
      const connected = await connectOne(name, current.config);
      this.servers.set(name, connected);
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
}
