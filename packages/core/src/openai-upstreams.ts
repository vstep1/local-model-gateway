import { OpenAiUpstreamConfig } from './types.js';

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface ProxyTelemetryCallbacks {
  onFirstByte?: () => void;
  onRequestBytes?: (bytes: number) => void;
  onResponseBytes?: (bytes: number) => void;
  onUpstreamSelected?: (upstreamName: string) => void;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function copyHeaders(headers: Headers): Headers {
  const copied = new Headers();
  for (const key of ['cache-control', 'content-type']) {
    const value = headers.get(key);
    if (value) copied.set(key, value);
  }
  return copied;
}

function describeProxyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'upstream request aborted or timed out';
  }
  if (error instanceof Error) {
    const cause = error.cause as { code?: string; message?: string } | undefined;
    if (cause?.code === 'ECONNREFUSED') return `connection refused (${cause.message ?? error.message})`;
    if (cause?.code === 'ENOTFOUND') return `host not found (${cause.message ?? error.message})`;
    if (cause?.code === 'ECONNRESET') return `connection reset (${cause.message ?? error.message})`;
    return error.message;
  }
  return String(error);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function makeProxyError(status: number, message: string): Response {
  return Response.json(
    {
      error: {
        code: null,
        message,
        param: null,
        type: status === 429 ? 'rate_limit_error' : status === 499 ? 'client_closed_request' : 'api_error',
      },
    },
    { status },
  );
}

export async function proxyOpenAiJson(
  upstreams: OpenAiUpstreamConfig[],
  path: '/chat/completions' | '/responses',
  body: Record<string, unknown>,
  model: string,
  clientSignal?: AbortSignal,
  onComplete?: () => void,
  telemetry?: ProxyTelemetryCallbacks,
): Promise<Response> {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onComplete?.();
  };

  if (upstreams.length === 0) {
    finish();
    return makeProxyError(404, `No upstream configured for model: ${model}`);
  }

  const errors: string[] = [];
  for (const upstream of upstreams) {
    if (clientSignal?.aborted) {
      finish();
      return clientClosedResponse();
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Upstream ${upstream.name} timeout after ${upstream.timeoutMs}ms`)),
      upstream.timeoutMs,
    );
    let cleanedUp = false;
    const abortUpstream = () => {
      controller.abort(clientSignal?.reason ?? new Error('Client request aborted'));
    };
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      clientSignal?.removeEventListener('abort', abortUpstream);
    };
    const cleanupAndFinish = () => {
      cleanup();
      finish();
    };
    clientSignal?.addEventListener('abort', abortUpstream, { once: true });

    const mappedBody = {
      ...body,
      model: upstream.upstreamModel || model,
    };
    const requestBody = JSON.stringify(mappedBody);
    telemetry?.onUpstreamSelected?.(upstream.name);
    telemetry?.onRequestBytes?.(byteLength(requestBody));

    try {
      const response = await fetch(`${normalizeBaseUrl(upstream.baseUrl)}${path}`, {
        body: requestBody,
        headers: {
          ...(upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (response.ok || !RETRYABLE_STATUSES.has(response.status)) {
        return new Response(wrapResponseBody(response.body, controller, cleanupAndFinish, telemetry), {
          headers: copyHeaders(response.headers),
          status: response.status,
          statusText: response.statusText,
        });
      }

      const text = await response.text().catch(() => '');
      telemetry?.onResponseBytes?.(byteLength(text));
      cleanup();
      if (clientSignal?.aborted) {
        finish();
        return clientClosedResponse();
      }
      errors.push(`${upstream.name}: HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ''}`);
    } catch (error) {
      cleanup();
      if (clientSignal?.aborted) {
        finish();
        return clientClosedResponse();
      }
      errors.push(`${upstream.name}: ${describeProxyError(error)}`);
    }
  }

  finish();
  return makeProxyError(503, `All upstreams failed for ${model}: ${errors.join(' | ')}`);
}

function clientClosedResponse(): Response {
  return makeProxyError(499, 'Client cancelled request');
}

function wrapResponseBody(
  body: ReadableStream<Uint8Array> | null,
  upstreamController: AbortController,
  cleanup: () => void,
  telemetry?: ProxyTelemetryCallbacks,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    cleanup();
    return null;
  }

  const reader = body.getReader();
  let sawFirstByte = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        if (!sawFirstByte) {
          sawFirstByte = true;
          telemetry?.onFirstByte?.();
        }
        telemetry?.onResponseBytes?.(value.byteLength);
        controller.enqueue(value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      upstreamController.abort(reason);
      try {
        await reader.cancel(reason);
      } finally {
        cleanup();
      }
    },
  });
}

export class OpenAiUpstreamPool {
  private readonly byModel = new Map<string, OpenAiUpstreamConfig[]>();
  private readonly displayNames = new Map<string, string>();
  private readonly cursors = new Map<string, number>();

  constructor(upstreams: OpenAiUpstreamConfig[]) {
    for (const upstream of upstreams) {
      const normalized = {
        ...upstream,
        baseUrl: normalizeBaseUrl(upstream.baseUrl),
        models: upstream.models.map((model) => model.trim()).filter(Boolean),
      };
      if (!normalized.baseUrl || normalized.models.length === 0) continue;

      for (const model of normalized.models) {
        const key = model.toLowerCase();
        const existing = this.byModel.get(key) ?? [];
        existing.push(normalized);
        this.byModel.set(key, existing);
        this.displayNames.set(key, model);
      }
    }
  }

  listModels(): string[] {
    return Array.from(this.displayNames.values()).sort();
  }

  hasModel(model: string | undefined): boolean {
    if (!model) return false;
    return this.byModel.has(model.toLowerCase());
  }

  describe(): Array<{ baseUrl: string; models: string[]; name: string; timeoutMs: number }> {
    const seen = new Set<string>();
    const result: Array<{ baseUrl: string; models: string[]; name: string; timeoutMs: number }> = [];
    for (const upstreams of this.byModel.values()) {
      for (const upstream of upstreams) {
        const key = `${upstream.name}\n${upstream.baseUrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          baseUrl: upstream.baseUrl,
          models: upstream.models,
          name: upstream.name,
          timeoutMs: upstream.timeoutMs,
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async proxyChatCompletions(
    body: Record<string, unknown>,
    model: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.proxyJson('/chat/completions', body, model, signal);
  }

  async proxyResponses(
    body: Record<string, unknown>,
    model: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.proxyJson('/responses', body, model, signal);
  }

  private orderedUpstreams(model: string): OpenAiUpstreamConfig[] {
    const key = model.toLowerCase();
    const upstreams = this.byModel.get(key) ?? [];
    if (upstreams.length <= 1) return upstreams;

    const cursor = this.cursors.get(key) ?? 0;
    this.cursors.set(key, (cursor + 1) % upstreams.length);
    return [...upstreams.slice(cursor), ...upstreams.slice(0, cursor)];
  }

  private async proxyJson(
    path: '/chat/completions' | '/responses',
    body: Record<string, unknown>,
    model: string,
    clientSignal?: AbortSignal,
  ): Promise<Response> {
    return proxyOpenAiJson(this.orderedUpstreams(model), path, body, model, clientSignal);
  }
}
