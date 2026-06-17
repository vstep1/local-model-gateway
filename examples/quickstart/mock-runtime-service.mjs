#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const stateDir = process.env.LOCAL_MODEL_GATEWAY_QUICKSTART_STATE_DIR
  || path.resolve(scriptDir, '../../runtime/quickstart');
const pidPath = path.join(stateDir, 'mock-runtime.pid');
const progressPath = path.join(stateDir, 'load-progress.json');
const host = '127.0.0.1';
const port = Number(process.env.LOCAL_MODEL_GATEWAY_QUICKSTART_RUNTIME_PORT || 18080);
const model = 'quickstart-mock';
const baseUrl = `http://${host}:${port}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeProgress(loadProgress, loadPhase) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    progressPath,
    JSON.stringify({
      load_phase: loadPhase,
      load_progress: loadProgress,
      updated_at: new Date().toISOString(),
    }, null, 2),
    'utf8',
  );
}

async function healthy() {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid() {
  try {
    return Number((await readFile(pidPath, 'utf8')).trim());
  } catch {
    return null;
  }
}

async function waitForHealth(expected, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await healthy() === expected) return true;
    await sleep(100);
  }
  return false;
}

async function startRuntime() {
  await mkdir(stateDir, { recursive: true });
  await writeProgress(0.2, 'starting');
  const oldPid = await readPid();

  if (await healthy()) {
    if (!oldPid || !pidIsRunning(oldPid)) {
      throw new Error(`${baseUrl} is already serving /v1/models, but it is not tracked by ${pidPath}`);
    }
    await writeProgress(1, 'ready');
    return;
  }

  if (oldPid && pidIsRunning(oldPid)) {
    if (await waitForHealth(true, 5000)) {
      await writeProgress(1, 'ready');
      return;
    }
  }

  const child = spawn(process.execPath, [scriptPath, 'serve'], {
    detached: true,
    env: {
      ...process.env,
      LOCAL_MODEL_GATEWAY_QUICKSTART_RUNTIME_PORT: String(port),
      LOCAL_MODEL_GATEWAY_QUICKSTART_STATE_DIR: stateDir,
    },
    stdio: 'ignore',
  });
  child.unref();
  await writeFile(pidPath, `${child.pid}\n`, 'utf8');
  await writeProgress(0.7, 'waiting_for_health');

  if (!await waitForHealth(true, 10000)) {
    throw new Error(`quickstart runtime did not become healthy at ${baseUrl}/v1/models`);
  }

  await writeProgress(1, 'ready');
}

async function stopRuntime() {
  const pid = await readPid();
  if (pid && pidIsRunning(pid)) {
    process.kill(pid, 'SIGTERM');
    await waitForHealth(false, 5000);
  }
  await rm(pidPath, { force: true });
  await writeProgress(0, 'stopped');
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function lastUserPrompt(body) {
  if (Array.isArray(body.messages)) {
    const user = [...body.messages].reverse().find((message) => message?.role === 'user');
    return messageText(user?.content);
  }
  if (typeof body.input === 'string') return body.input;
  if (Array.isArray(body.input)) {
    return body.input.map((item) => messageText(item?.content ?? item)).filter(Boolean).join(' ');
  }
  return '';
}

function completionText(body) {
  const prompt = lastUserPrompt(body) || 'empty prompt';
  return `quickstart-mock response: the gateway reached a managed runtime and sent "${prompt}".`;
}

function responseDelayMs(body) {
  const value = Number(body.quickstart_delay_ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), 5000);
}

async function delayForRequest(body) {
  const delayMs = responseDelayMs(body);
  if (delayMs > 0) await sleep(delayMs);
}

async function sendChatStream(response, body) {
  await delayForRequest(body);
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-quickstart-${created}`;
  const base = { id, object: 'chat.completion.chunk', created, model };
  const events = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: completionText(body) }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];

  response.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream',
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function sendResponsesStream(response, body) {
  await delayForRequest(body);
  const id = `resp_quickstart_${Date.now()}`;
  const text = completionText(body);
  response.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream',
  });
  response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', response_id: id, delta: text })}\n\n`);
  response.write(`data: ${JSON.stringify({
    type: 'response.completed',
    response: {
      id,
      object: 'response',
      model,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      status: 'completed',
    },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function serveRuntime() {
  await mkdir(stateDir, { recursive: true });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);

    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/models')) {
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: model, object: 'model', created: 0, owned_by: 'local-model-gateway-quickstart' }],
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readRequestJson(request);
      if (body.stream) {
        await sendChatStream(response, body);
        return;
      }
      await delayForRequest(body);
      const created = Math.floor(Date.now() / 1000);
      sendJson(response, 200, {
        id: `chatcmpl-quickstart-${created}`,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: completionText(body) },
          finish_reason: 'stop',
        }],
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/responses') {
      const body = await readRequestJson(request);
      if (body.stream !== false) {
        await sendResponsesStream(response, body);
        return;
      }
      await delayForRequest(body);
      const text = completionText(body);
      sendJson(response, 200, {
        id: `resp_quickstart_${Date.now()}`,
        object: 'response',
        model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        status: 'completed',
      });
      return;
    }

    sendJson(response, 404, { error: { message: 'not found' } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  await writeFile(pidPath, `${process.pid}\n`, 'utf8');
  await writeProgress(1, 'ready');

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const command = process.argv[2] ?? 'status';
  if (command === 'start') {
    await startRuntime();
    return;
  }
  if (command === 'stop') {
    await stopRuntime();
    return;
  }
  if (command === 'serve') {
    await serveRuntime();
    return;
  }
  if (command === 'status') {
    console.log(await healthy() ? 'running' : 'stopped');
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
