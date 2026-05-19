import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { LazyMcpBroker } from './broker.js';
import { getConfigPath, loadBrokerConfig } from './config.js';
import { safeError } from './redact.js';

function textResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function userError(error: unknown): never {
  throw new UserError(safeError(error));
}

async function bootstrap(): Promise<void> {
  const configPath = getConfigPath();
  const broker = new LazyMcpBroker(loadBrokerConfig(configPath));
  await broker.initialize();

  const server = new FastMCP({
    name: 'lazy-mcp-broker-mcp',
    version: '1.0.0',
    instructions:
      'Read-first lazy broker for downstream MCP tools. Search for a tool, describe exactly one tool, then call the selected read-only tool.',
  });

  server.addTool({
    name: 'search_tools',
    description:
      'Search read-only downstream MCP tools by name, server, description, or parameter names. Returns compact summaries only.',
    parameters: z.object({
      query: z.string().optional().default(''),
      server: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().default(10),
    }),
    execute: async (args) => {
      try {
        return textResult(broker.searchTools(args.query, args.server, args.limit));
      } catch (error) {
        userError(error);
      }
    },
  });

  server.addTool({
    name: 'describe_tool',
    description: 'Return the exact input schema for one read-only downstream MCP tool.',
    parameters: z.object({
      tool_id: z.string().min(1),
    }),
    execute: async (args) => {
      try {
        return textResult(await broker.describeTool(args.tool_id));
      } catch (error) {
        userError(error);
      }
    },
  });

  server.addTool({
    name: 'call_tool',
    description: 'Call one selected read-only downstream MCP tool by tool_id with JSON arguments.',
    parameters: z.object({
      tool_id: z.string().min(1),
      arguments: z.record(z.unknown()).optional().default({}),
    }),
    execute: async (args) => {
      try {
        return textResult(await broker.callTool(args.tool_id, args.arguments));
      } catch (error) {
        userError(error);
      }
    },
  });

  server.addTool({
    name: 'list_servers',
    description: 'List downstream MCP server connection status and read-only tool counts.',
    parameters: z.object({}),
    execute: async () => {
      try {
        return textResult(broker.listServers());
      } catch (error) {
        userError(error);
      }
    },
  });

  console.error(`[lazy-mcp-broker] using downstream config: ${configPath}`);
  await server.start({ transportType: 'stdio' });
}

void bootstrap().catch((error) => {
  console.error(`[lazy-mcp-broker] fatal: ${safeError(error)}`);
  process.exit(1);
});
