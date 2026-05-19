import { Hono } from 'hono';
import { z } from 'zod';
import { Scheduler } from '@local-model-gateway/core';
import type { ActiveRuntimeSettings, ChatMessage, JobRecord } from '@local-model-gateway/core';
import { compilePromptFromMessages, parseResponsesInputToMessages } from '@local-model-gateway/core';
import { OpenAiUpstreamPool } from '@local-model-gateway/core';
import { GpuCoordinator } from '@local-model-gateway/core';

const chatSchema = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant', 'tool']),
          content: z.unknown(),
        }),
      )
      .min(1),
    max_queue_wait_ms: z.number().int().positive().optional(),
    model: z.string().optional(),
    priority: z.number().int().optional(),
    stream: z.boolean().optional().default(false),
  })
  .passthrough();

const responsesSchema = z
  .object({
    input: z.unknown(),
    instructions: z.string().optional(),
    max_queue_wait_ms: z.number().int().positive().optional(),
    model: z.string().optional(),
    priority: z.number().int().optional(),
    stream: z.boolean().optional().default(false),
  })
  .passthrough();

function makeError(status: number, message: string, type = 'invalid_request_error'): Response {
  return Response.json(
    {
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    },
    { status },
  );
}

function chunkTextForStream(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > 60 && current) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function streamHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });
}

function asPriority(value: number | undefined): 0 | 1 | 2 | undefined {
  if (value === undefined) return undefined;
  if (value <= 0) return 0;
  if (value >= 2) return 2;
  return 1;
}

function ensureSuccessOrError(job: JobRecord): Response | null {
  if (job.state === 'succeeded') {
    return null;
  }

  if (job.state === 'timed_out') {
    return makeError(504, 'Queue wait timeout exceeded', 'rate_limit_error');
  }

  const message = job.errorText || `Job failed with state ${job.state}`;
  return makeError(500, message, 'api_error');
}

async function waitForStartedThenTerminal(
  scheduler: Scheduler,
  jobId: string,
  maxQueueWaitMs: number,
): Promise<JobRecord> {
  const started = await scheduler.waitForOpenAiJobStart(jobId, maxQueueWaitMs);
  if (started.timedOut) {
    return started.job;
  }

  if (
    started.job.state === 'succeeded' ||
    started.job.state === 'failed' ||
    started.job.state === 'cancelled' ||
    started.job.state === 'timed_out'
  ) {
    return started.job;
  }

  const terminal = await scheduler.waitForJob(jobId);
  return terminal.job;
}

export function registerOpenAiRoutes(
  app: Hono,
  scheduler: Scheduler,
  settings: ActiveRuntimeSettings,
  getModelAliases: () => string[],
  upstreamPool?: OpenAiUpstreamPool,
  gpuCoordinator?: GpuCoordinator,
): void {
  app.get('/v1/models', async () => {
    const aliases = getModelAliases();
    const data = aliases.map((alias) => ({
      id: alias,
      object: 'model',
      created: 0,
      owned_by: 'local-model-gateway',
    }));

    return Response.json({ object: 'list', data });
  });

  app.post('/v1/chat/completions', async (c) => {
    let parsed: z.infer<typeof chatSchema>;
    try {
      const body = await c.req.json();
      parsed = chatSchema.parse(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body';
      return makeError(400, message);
    }

    const maxQueueWaitMs = parsed.max_queue_wait_ms ?? settings.maxQueueWaitMs;
    const requestedModel = parsed.model?.trim() || settings.defaultModel;

    if (gpuCoordinator?.hasModel(requestedModel)) {
      return gpuCoordinator.proxyChatCompletions(
        parsed as Record<string, unknown>,
        requestedModel,
        'openai',
        2,
        maxQueueWaitMs,
        c.req.raw.signal,
      );
    }

    if (upstreamPool?.hasModel(requestedModel)) {
      return upstreamPool.proxyChatCompletions(
        parsed as Record<string, unknown>,
        requestedModel,
        c.req.raw.signal,
      );
    }

    const prompt = compilePromptFromMessages(parsed.messages as ChatMessage[]);

    let job: JobRecord;
    try {
      job = scheduler.submitJob({
        source: 'openai',
        requestedPriority: asPriority(parsed.priority),
        model: requestedModel,
        prompt,
        metadata: {
          endpoint: '/v1/chat/completions',
          stream: parsed.stream,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Queue submit failed';
      return makeError(429, message, 'rate_limit_error');
    }

    if (!parsed.stream) {
      const terminal = await waitForStartedThenTerminal(scheduler, job.id, maxQueueWaitMs);
      const err = ensureSuccessOrError(terminal);
      if (err) return err;

      const content = terminal.resultText ?? '';
      return Response.json({
        id: `chatcmpl-${terminal.id}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: terminal.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      });
    }

    const started = await scheduler.waitForOpenAiJobStart(job.id, maxQueueWaitMs);
    if (started.timedOut) {
      return makeError(504, 'Queue wait timeout exceeded', 'rate_limit_error');
    }

    if (
      started.job.state === 'failed' ||
      started.job.state === 'cancelled' ||
      started.job.state === 'timed_out'
    ) {
      return ensureSuccessOrError(started.job) ?? makeError(500, 'Unexpected job state', 'api_error');
    }

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          const terminal =
            started.job.state === 'succeeded'
              ? started.job
              : (await scheduler.waitForJob(job.id)).job;

          const err = ensureSuccessOrError(terminal);
          if (err) {
            const payload = {
              error: {
                message: terminal.errorText || 'Generation failed',
                type: 'api_error',
              },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          const created = Math.floor(Date.now() / 1000);
          const base = {
            id: `chatcmpl-${terminal.id}`,
            object: 'chat.completion.chunk',
            created,
            model: terminal.model,
          };

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                ...base,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              })}\n\n`,
            ),
          );

          const chunks = chunkTextForStream(terminal.resultText ?? '');
          for (const chunk of chunks) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  ...base,
                  choices: [{ index: 0, delta: { content: `${chunk} ` }, finish_reason: null }],
                })}\n\n`,
              ),
            );
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              })}\n\n`,
            ),
          );

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        })().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        });
      },
    });

    return new Response(body, { status: 200, headers: streamHeaders() });
  });

  app.post('/v1/responses', async (c) => {
    let parsed: z.infer<typeof responsesSchema>;
    try {
      const body = await c.req.json();
      parsed = responsesSchema.parse(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body';
      return makeError(400, message);
    }

    const maxQueueWaitMs = parsed.max_queue_wait_ms ?? settings.maxQueueWaitMs;
    const requestedModel = parsed.model?.trim() || settings.defaultModel;

    if (gpuCoordinator?.hasModel(requestedModel)) {
      return gpuCoordinator.proxyResponses(
        parsed as Record<string, unknown>,
        requestedModel,
        'openai',
        2,
        maxQueueWaitMs,
        c.req.raw.signal,
      );
    }

    if (upstreamPool?.hasModel(requestedModel)) {
      return upstreamPool.proxyResponses(
        parsed as Record<string, unknown>,
        requestedModel,
        c.req.raw.signal,
      );
    }

    const messages = parseResponsesInputToMessages(parsed.input);
    if (parsed.instructions) {
      messages.unshift({ role: 'system', content: parsed.instructions });
    }

    const prompt = compilePromptFromMessages(messages);

    let job: JobRecord;
    try {
      job = scheduler.submitJob({
        source: 'openai',
        requestedPriority: asPriority(parsed.priority),
        model: requestedModel,
        prompt,
        metadata: {
          endpoint: '/v1/responses',
          stream: parsed.stream,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Queue submit failed';
      return makeError(429, message, 'rate_limit_error');
    }

    const streamRequested = parsed.stream !== false;

    if (!streamRequested) {
      const terminal = await waitForStartedThenTerminal(scheduler, job.id, maxQueueWaitMs);
      const err = ensureSuccessOrError(terminal);
      if (err) return err;

      return Response.json({
        id: `resp_${terminal.id}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: terminal.model,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: terminal.resultText ?? '' }],
          },
        ],
        status: 'completed',
      });
    }

    const started = await scheduler.waitForOpenAiJobStart(job.id, maxQueueWaitMs);
    if (started.timedOut) {
      return makeError(504, 'Queue wait timeout exceeded', 'rate_limit_error');
    }

    if (
      started.job.state === 'failed' ||
      started.job.state === 'cancelled' ||
      started.job.state === 'timed_out'
    ) {
      return ensureSuccessOrError(started.job) ?? makeError(500, 'Unexpected job state', 'api_error');
    }

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          const terminal =
            started.job.state === 'succeeded'
              ? started.job
              : (await scheduler.waitForJob(job.id)).job;

          const err = ensureSuccessOrError(terminal);
          if (err) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'response.failed', error: terminal.errorText || 'Generation failed' })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          const chunks = chunkTextForStream(terminal.resultText ?? '');
          const responseId = `resp_${terminal.id}`;

          for (const chunk of chunks) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'response.output_text.delta',
                  response_id: responseId,
                  delta: `${chunk} `,
                })}\n\n`,
              ),
            );
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'response.completed',
                response: {
                  id: responseId,
                  object: 'response',
                  model: terminal.model,
                  status: 'completed',
                  output: [
                    {
                      type: 'message',
                      role: 'assistant',
                      content: [{ type: 'output_text', text: terminal.resultText ?? '' }],
                    },
                  ],
                },
              })}\n\n`,
            ),
          );

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        })().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'response.failed', error: message })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        });
      },
    });

    return new Response(body, { status: 200, headers: streamHeaders() });
  });
}
