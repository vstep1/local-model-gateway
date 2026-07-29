import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardHtml } from '../../packages/gateway/src/dashboard.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureNamePattern = /^[a-z0-9-]+$/;

export interface VisualFixtureServer {
  close: () => Promise<void>;
  url: string;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': contentType,
  });
  response.end(body);
}

async function loadFixture(fixture: string): Promise<unknown> {
  if (!fixtureNamePattern.test(fixture)) {
    throw new Error(`invalid fixture name: ${fixture}`);
  }
  const raw = await readFile(join(fixtureDir, `${fixture}.json`), 'utf8');
  return JSON.parse(raw) as unknown;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/dashboard') {
    const fixture = url.searchParams.get('fixture') || 'empty-status';
    const authRequired = fixture === 'auth-required';
    sendText(
      response,
      200,
      dashboardHtml({ authRequired, statusPath: `/status/${fixture}` }),
      'text/html; charset=utf-8',
    );
    return;
  }

  if (url.pathname.startsWith('/status/')) {
    const fixture = decodeURIComponent(url.pathname.slice('/status/'.length));
    if (fixture === 'auth-required') {
      sendJson(response, 401, {
        error: { message: 'Missing or invalid bearer token', type: 'authentication_error' },
      });
      return;
    }

    try {
      sendJson(response, 200, await loadFixture(fixture));
    } catch (error) {
      sendJson(response, 404, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  sendJson(response, 404, { error: 'not found' });
}

export async function startVisualFixtureServer(): Promise<VisualFixtureServer> {
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('visual fixture server did not expose a TCP address');
  }

  return {
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
