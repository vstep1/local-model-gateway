import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LazyMcpBroker } from '../src/broker.js';

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lazy-mcp-broker-test-'));
  return path.join(dir, name);
}

test('initialize registers downstream servers without spawning them', async () => {
  const marker = await tempPath('started');
  const broker = new LazyMcpBroker(
    {
      mcp_servers: {
        example: {
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
        },
      },
    },
    { catalogCachePath: await tempPath('catalog.json') },
  );

  await broker.initialize();

  assert.equal(existsSync(marker), false);
  assert.deepEqual(broker.listServers(), {
    servers: [
      {
        server: 'example',
        status: 'not_connected',
        tool_count: 0,
        allowed_tool_count: 0,
        cached: false,
        refreshing: false,
        error: undefined,
      },
    ],
  });
});

test('cached catalog supports search and describe without connecting downstream', async () => {
  const marker = await tempPath('started');
  const catalogCachePath = await tempPath('catalog.json');
  await writeFile(
    catalogCachePath,
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      servers: {
        example: {
          refreshedAt: new Date().toISOString(),
          tools: [
            {
              name: 'getThing',
              description: 'Get a thing.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                },
              },
            },
          ],
        },
      },
    }),
    'utf8',
  );
  const broker = new LazyMcpBroker(
    {
      mcp_servers: {
        example: {
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
        },
      },
    },
    { catalogCachePath },
  );

  await broker.initialize();

  assert.equal(existsSync(marker), false);
  assert.deepEqual(broker.searchTools('thing'), {
    tools: [
      {
        tool_id: 'example:getThing',
        server: 'example',
        name: 'getThing',
        description: 'Get a thing.',
        parameter_names: ['id'],
      },
    ],
  });
  assert.deepEqual(await broker.describeTool('example:getThing'), {
    tool_id: 'example:getThing',
    server: 'example',
    name: 'getThing',
    description: 'Get a thing.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
    },
  });
  assert.equal(existsSync(marker), false);
});

test('cached catalog filters disallowed tools and rejects unknown descriptions', async () => {
  const marker = await tempPath('started');
  const catalogCachePath = await tempPath('catalog.json');
  await writeFile(
    catalogCachePath,
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      servers: {
        example: {
          refreshedAt: new Date().toISOString(),
          tools: [
            {
              name: 'getThing',
              description: 'Get a thing.',
              inputSchema: { type: 'object' },
            },
            {
              name: 'deleteThing',
              description: 'Delete a thing.',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    }),
    'utf8',
  );
  const broker = new LazyMcpBroker(
    {
      mcp_servers: {
        example: {
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
        },
      },
    },
    { catalogCachePath },
  );

  await broker.initialize();

  assert.deepEqual(broker.searchTools('', 'example', 99), {
    tools: [
      {
        tool_id: 'example:getThing',
        server: 'example',
        name: 'getThing',
        description: 'Get a thing.',
        parameter_names: [],
      },
    ],
  });
  await assert.rejects(
    broker.describeTool('example:deleteThing'),
    /Tool is not exposed by the read-only broker/,
  );
  await assert.rejects(broker.describeTool('missing:getThing'), /Unknown tool_id/);
  assert.equal(existsSync(marker), false);
});

test('incompatible cached catalog is ignored without connecting downstream', async () => {
  const marker = await tempPath('started');
  const catalogCachePath = await tempPath('catalog.json');
  await writeFile(
    catalogCachePath,
    JSON.stringify({
      version: 999,
      generatedAt: new Date().toISOString(),
      servers: {
        example: {
          refreshedAt: new Date().toISOString(),
          tools: [
            {
              name: 'getThing',
              description: 'Get a thing.',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    }),
    'utf8',
  );
  const broker = new LazyMcpBroker(
    {
      mcp_servers: {
        example: {
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
        },
      },
    },
    { catalogCachePath },
  );

  await broker.initialize();

  assert.deepEqual(broker.searchTools('thing'), { tools: [] });
  assert.deepEqual(broker.listServers(), {
    servers: [
      {
        server: 'example',
        status: 'not_connected',
        tool_count: 0,
        allowed_tool_count: 0,
        cached: false,
        refreshing: false,
        error: undefined,
      },
    ],
  });
  assert.equal(existsSync(marker), false);
});

test('empty search does not start broad background refresh', async () => {
  const marker = await tempPath('started');
  const broker = new LazyMcpBroker(
    {
      mcp_servers: {
        example: {
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
        },
      },
    },
    { catalogCachePath: await tempPath('catalog.json') },
  );

  await broker.initialize();
  assert.deepEqual(broker.searchTools(''), { tools: [] });
  assert.equal(existsSync(marker), false);
});
