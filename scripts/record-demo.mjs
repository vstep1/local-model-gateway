#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_OUTPUT = 'docs/assets/terminal-demo.svg';

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    mode: 'fake',
    model: 'qwen3-32b',
    output: DEFAULT_OUTPUT,
    timeoutMs: 15 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [key, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && key.startsWith('--')) index += 1;
    if (key === '--base-url') args.baseUrl = value;
    if (key === '--mode') args.mode = value;
    if (key === '--model') args.model = value;
    if (key === '--output') args.output = value;
    if (key === '--timeout-ms') args.timeoutMs = Number(value);
    if (key === '--help' || key === '-h') {
      console.log(`Usage: node scripts/record-demo.mjs [--mode fake|live] [--model qwen3-32b] [--base-url http://127.0.0.1:8787] [--output docs/assets/terminal-demo.svg]`);
      process.exit(0);
    }
  }
  if (!['fake', 'live'].includes(args.mode)) {
    throw new Error(`Unsupported --mode ${args.mode}; use fake or live`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return args;
}

function stripBaseUrl(value) {
  return value.replace(/^https?:\/\//, '');
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function truncate(value, max = 92) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

function textFromChatChunk(payload) {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta ?? {};
  const message = choice?.message ?? {};
  return String(delta.content ?? delta.reasoning_content ?? message.content ?? '');
}

async function streamChatCompletion({ baseUrl, model, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`demo request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref?.();
  try {
    const started = Date.now();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      body: JSON.stringify({
        max_tokens: 80,
        messages: [
          {
            role: 'user',
            content:
              'In one concise sentence, explain that Local Model Gateway queues OpenAI/MCP requests, loads local runtimes on demand, and streams responses. Do not mention a web interface.',
          },
        ],
        model,
        stream: true,
        temperature: 0.2,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`chat completion failed HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let firstTokenMs = null;
    let output = '';
    let events = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice('data:'.length).trim();
          if (!data || data === '[DONE]') continue;
          events += 1;
          try {
            const text = textFromChatChunk(JSON.parse(data));
            if (text) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - started;
              output += text;
            }
          } catch {
            // Ignore non-chat SSE events from compatible providers.
          }
        }
      }
    }

    return {
      elapsedMs: Date.now() - started,
      events,
      firstTokenMs,
      text: output.trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeStatus(status) {
  const runtimes = Array.isArray(status?.managed_runtimes) ? status.managed_runtimes : [];
  const runtimeText = runtimes
    .map((runtime) => `${runtime.alias}:${runtime.state}`)
    .join(', ');
  return {
    active_work: status?.active_work?.length ?? 0,
    gpu_queue: status?.gpu_queue?.length ?? 0,
    loaded_model: status?.loaded_model ?? null,
    loading_model: status?.loading_model ?? null,
    runtimes: runtimeText || 'none',
  };
}

async function liveTranscript(args) {
  const baseUrl = args.baseUrl.replace(/\/+$/, '');
  const lines = [];
  lines.push({ kind: 'cmd', text: `$ curl ${stripBaseUrl(baseUrl)}/health` });
  const healthResponse = await fetch(`${baseUrl}/health`);
  lines.push({ kind: 'ok', text: `ok    gateway health: ${await healthResponse.text()}` });

  lines.push({ kind: 'cmd', text: `$ curl ${stripBaseUrl(baseUrl)}/v1/models` });
  const models = await fetchJson(`${baseUrl}/v1/models`);
  const modelIds = models.data.map((item) => item.id).join(', ');
  lines.push({ kind: 'out', text: `models: ${modelIds}` });

  lines.push({ kind: 'cmd', text: `$ curl ${stripBaseUrl(baseUrl)}/status` });
  const before = summarizeStatus(await fetchJson(`${baseUrl}/status`));
  lines.push({ kind: 'json', text: safeJson(before) });

  lines.push({ kind: 'cmd', text: `$ curl -N ${stripBaseUrl(baseUrl)}/v1/chat/completions --model ${args.model}` });
  lines.push({ kind: 'note', text: 'streaming through the shared GPU coordinator...' });
  const streamed = await streamChatCompletion({ baseUrl, model: args.model, timeoutMs: args.timeoutMs });
  lines.push({
    kind: 'ok',
    text: `first token: ${streamed.firstTokenMs ?? 'n/a'}ms | events: ${streamed.events} | total: ${streamed.elapsedMs}ms`,
  });
  lines.push({ kind: 'stream', text: truncate(streamed.text || '(empty response)', 116) });

  lines.push({ kind: 'cmd', text: `$ curl ${stripBaseUrl(baseUrl)}/status` });
  const after = summarizeStatus(await fetchJson(`${baseUrl}/status`));
  lines.push({ kind: 'json', text: safeJson(after) });
  return lines;
}

function fakeTranscript() {
  return [
    { kind: 'cmd', text: '$ curl 127.0.0.1:8787/health' },
    { kind: 'ok', text: 'ok    gateway health: ok' },
    { kind: 'cmd', text: '$ curl 127.0.0.1:8787/v1/models' },
    { kind: 'out', text: 'models: ep2, qwen3-32b, minimax-m2.7' },
    { kind: 'cmd', text: '$ curl 127.0.0.1:8787/status' },
    {
      kind: 'json',
      text: safeJson({
        active_work: 0,
        gpu_queue: 0,
        loaded_model: null,
        loading_model: null,
        runtimes: 'qwen3-32b:unloaded, minimax-m2.7:unloaded',
      }),
    },
    { kind: 'cmd', text: '$ curl -N 127.0.0.1:8787/v1/chat/completions --model qwen3-32b' },
    { kind: 'note', text: 'streaming through the shared GPU coordinator...' },
    { kind: 'ok', text: 'first token: 824ms | events: 9 | total: 1380ms' },
    {
      kind: 'stream',
      text: 'Local Model Gateway queues local agent requests, loads one runtime at a time, and streams the result back.',
    },
    { kind: 'cmd', text: '$ curl 127.0.0.1:8787/status' },
    {
      kind: 'json',
      text: safeJson({
        active_work: 0,
        gpu_queue: 0,
        loaded_model: 'qwen3-32b',
        loading_model: null,
        runtimes: 'qwen3-32b:loaded, minimax-m2.7:unloaded',
      }),
    },
  ];
}

function colorFor(kind) {
  return {
    cmd: '#e2e8f0',
    json: '#dbeafe',
    note: '#94a3b8',
    ok: '#86efac',
    out: '#cbd5e1',
    stream: '#fcd34d',
  }[kind] ?? '#cbd5e1';
}

function renderSvg(lines) {
  const expanded = [];
  for (const line of lines) {
    for (const part of line.text.split('\n')) {
      expanded.push({ ...line, text: part });
    }
  }
  const lineHeight = 25;
  const top = 122;
  const height = Math.max(560, top + expanded.length * lineHeight + 92);
  const width = 1100;
  const rows = expanded.map((line, index) => {
    const y = top + index * lineHeight;
    const text = line.kind === 'cmd'
      ? line.text.replace(/^\$ /, '')
      : line.text;
    const prefix = line.kind === 'cmd'
      ? '<tspan fill="#93c5fd">$</tspan><tspan> </tspan>'
      : '';
    return `  <text x="86" y="${y}" fill="${colorFor(line.kind)}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="16">${prefix}<tspan>${xmlEscape(text)}</tspan></text>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Local Model Gateway live terminal demo</title>
  <desc id="desc">Terminal-style demo showing Local Model Gateway health, model discovery, streaming output, and runtime status.</desc>
  <defs>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101820"/>
      <stop offset="100%" stop-color="#1d2733"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#071018" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="#eef2f7"/>
  <rect x="56" y="46" width="${width - 112}" height="${height - 92}" rx="14" fill="url(#frame)" filter="url(#shadow)"/>
  <rect x="56" y="46" width="${width - 112}" height="44" rx="14" fill="#263241"/>
  <circle cx="84" cy="68" r="7" fill="#f87171"/>
  <circle cx="108" cy="68" r="7" fill="#fbbf24"/>
  <circle cx="132" cy="68" r="7" fill="#34d399"/>
  <text x="${width / 2}" y="73" text-anchor="middle" fill="#cbd5e1" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">local-model-gateway</text>
${rows}
  <text x="86" y="${height - 46}" fill="#94a3b8" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="15">OpenAI-compatible HTTP + MCP Streamable HTTP + SQLite GPU residency coordinator</text>
</svg>
`;
}

const args = parseArgs(process.argv.slice(2));
const lines = args.mode === 'live' ? await liveTranscript(args) : fakeTranscript();
await writeFile(args.output, renderSvg(lines), 'utf8');
console.log(`wrote ${args.output} (${args.mode} mode)`);
