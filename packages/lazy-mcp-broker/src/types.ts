import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type DownstreamServerConfig = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  broker?: {
    default_read_only?: boolean;
    default_timeout_ms?: number;
    default_policy?: Partial<BrokerToolPolicy>;
    include?: string[];
    exclude?: string[];
    tools?: Record<string, Partial<BrokerToolPolicy>>;
  };
};

export type BrokerConfig = {
  mcp_servers: Record<string, DownstreamServerConfig>;
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type BrokerToolEffect = 'read' | 'write';
export type BrokerToolCost = 'free' | 'metered' | 'unknown';
export type BrokerToolConfirmation = 'never' | 'required';

export type BrokerToolPolicy = {
  effect: BrokerToolEffect;
  cost: BrokerToolCost;
  confirmation: BrokerToolConfirmation;
  timeoutMs: number;
};

export type ConnectedDownstream = {
  name: string;
  config: DownstreamServerConfig;
  client?: Client;
  status: 'connected' | 'failed';
  error?: string;
  tools: McpTool[];
};

export type BrokerToolRecord = {
  toolId: string;
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
  parameterNames: string[];
  allowed: boolean;
  policy: BrokerToolPolicy;
};
