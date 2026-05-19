import type { BrokerToolPolicy, BrokerToolRecord, McpTool } from './types.js';

export function toolId(server: string, name: string): string {
  return `${server}:${name}`;
}

export function parameterNames(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== 'object') return [];
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.keys(properties as Record<string, unknown>).sort();
}

export function makeToolRecord(
  server: string,
  tool: McpTool,
  allowed: boolean,
  policy: BrokerToolPolicy,
): BrokerToolRecord {
  return {
    toolId: toolId(server, tool.name),
    server,
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    parameterNames: parameterNames(tool.inputSchema),
    allowed,
    policy,
  };
}

export function summarizeTool(record: BrokerToolRecord): Record<string, unknown> {
  return {
    tool_id: record.toolId,
    server: record.server,
    name: record.name,
    description: record.description,
    parameter_names: record.parameterNames,
  };
}
