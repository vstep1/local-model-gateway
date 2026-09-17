import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import {
  makeProxyError,
  OpenAiUpstreamPool,
  proxyOpenAiJson,
  type ProxyCompletionOutcome,
} from '../src/openai-upstreams.js';

async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function requestBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function chatResponse(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }],
  };
}

describe('OpenAI upstream proxying', () => {
  it('uses the configured upstream timeout while waiting for response headers', async () => {
    const originalFetch = globalThis.fetch;
    let dispatcherSeen = false;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      dispatcherSeen = 'dispatcher' in (init ?? {});
      return Response.json(chatResponse('configured transport'));
    }) as typeof fetch;

    try {
      const pool = new OpenAiUpstreamPool([
        {
          apiKey: '',
          apiKeyEnv: '',
          baseUrl: 'http://127.0.0.1:1',
          models: ['slow-headers'],
          name: 'slow-headers',
          timeoutMs: 500,
          upstreamModel: 'slow-headers',
        },
      ]);

      const response = await pool.proxyChatCompletions({}, 'slow-headers');
      assert.equal(response.status, 200);
      assert.equal(dispatcherSeen, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('normalizes upstream base URLs and round-robins same-model upstreams', async () => {
    await withServer(async (request, response) => {
      const body = await requestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(chatResponse(`a:${body.model}`)));
    }, async (aUrl) => {
      await withServer(async (request, response) => {
        const body = await requestBody(request);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(chatResponse(`b:${body.model}`)));
      }, async (bUrl) => {
        const pool = new OpenAiUpstreamPool([
          {
            apiKey: 'x',
            apiKeyEnv: '',
            baseUrl: aUrl,
            models: ['shared'],
            name: 'a',
            timeoutMs: 1000,
            upstreamModel: 'upstream-shared',
          },
          {
            apiKey: '',
            apiKeyEnv: '',
            baseUrl: `${bUrl}/v1`,
            models: ['shared'],
            name: 'b',
            timeoutMs: 1000,
            upstreamModel: 'upstream-shared',
          },
        ]);

        assert.deepEqual(pool.listModels(), ['shared']);
        assert.equal(pool.hasModel('SHARED'), true);
        assert.deepEqual(
          pool.describe().map((item) => item.baseUrl),
          [`${aUrl}/v1`, `${bUrl}/v1`],
        );

        const first = await pool.proxyChatCompletions({ model: 'shared' }, 'shared');
        const second = await pool.proxyChatCompletions({ model: 'shared' }, 'shared');
        assert.match(await first.text(), /a:upstream-shared/);
        assert.match(await second.text(), /b:upstream-shared/);
      });
    });
  });

  it('retries retryable upstream failures and preserves non-retryable responses', async () => {
    await withServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('temporarily unavailable');
    }, async (retryUrl) => {
      await withServer((_request, response) => {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad key' } }));
      }, async (unauthorizedUrl) => {
        await withServer((_request, response) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(chatResponse('ok after retry')));
        }, async (okUrl) => {
          const retryPool = new OpenAiUpstreamPool([
            {
              apiKey: '',
              apiKeyEnv: '',
              baseUrl: retryUrl,
              models: ['model'],
              name: 'retry',
              timeoutMs: 1000,
              upstreamModel: 'model',
            },
            {
              apiKey: '',
              apiKeyEnv: '',
              baseUrl: okUrl,
              models: ['model'],
              name: 'ok',
              timeoutMs: 1000,
              upstreamModel: 'model',
            },
          ]);
          const retryResponse = await retryPool.proxyChatCompletions({ model: 'model' }, 'model');
          assert.equal(retryResponse.status, 200);
          assert.match(await retryResponse.text(), /ok after retry/);

          const unauthorizedPool = new OpenAiUpstreamPool([
            {
              apiKey: '',
              apiKeyEnv: '',
              baseUrl: unauthorizedUrl,
              models: ['model'],
              name: 'unauthorized',
              timeoutMs: 1000,
              upstreamModel: 'model',
            },
            {
              apiKey: '',
              apiKeyEnv: '',
              baseUrl: okUrl,
              models: ['model'],
              name: 'ok',
              timeoutMs: 1000,
              upstreamModel: 'model',
            },
          ]);
          const unauthorizedResponse = await unauthorizedPool.proxyChatCompletions({ model: 'model' }, 'model');
          assert.equal(unauthorizedResponse.status, 401);
          assert.match(await unauthorizedResponse.text(), /bad key/);
        });
      });
    });
  });

  it('returns OpenAI-style errors when no upstream can serve the model', async () => {
    const emptyPool = new OpenAiUpstreamPool([]);
    const missing = await emptyPool.proxyChatCompletions({}, 'missing');
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /No upstream configured/);

    const error = makeProxyError(429, 'queue full');
    assert.equal(error.status, 429);
    assert.match(await error.text(), /rate_limit_error/);
  });

  it('classifies a client-aborted non-success stream as cancelled', async () => {
    const originalFetch = globalThis.fetch;
    let completion: { errorText?: string; outcome?: ProxyCompletionOutcome } | undefined;
    globalThis.fetch = (async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial error'));
        },
      }),
      { status: 400, statusText: 'Bad Request' },
    )) as typeof fetch;

    try {
      const abortController = new AbortController();
      const response = await proxyOpenAiJson(
        [{
          apiKey: '',
          apiKeyEnv: '',
          baseUrl: 'http://127.0.0.1:1',
          models: ['model'],
          name: 'upstream',
          timeoutMs: 1000,
          upstreamModel: 'model',
        }],
        '/chat/completions',
        {},
        'model',
        abortController.signal,
        (errorText, outcome) => {
          completion = { errorText, outcome };
        },
      );
      const reader = response.body?.getReader();
      assert.ok(reader);
      assert.equal((await reader.read()).done, false);
      abortController.abort(new Error('client cancelled'));

      assert.deepEqual(completion, { errorText: undefined, outcome: 'cancelled' });
      await reader.cancel('test cleanup');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
