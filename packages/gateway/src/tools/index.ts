import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { GatewayStore } from '@local-model-gateway/core';
import { GpuCoordinator } from '@local-model-gateway/core';
import { ModelRegistry } from '@local-model-gateway/core';
import { Scheduler } from '@local-model-gateway/core';
import type { GatewayConfig, JobState } from '@local-model-gateway/core';

const stateSchema = z
  .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'])
  .optional();

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

export function clientRecipe(
  kind: 'generic-openai' | 'generic-mcp' | 'hermes',
  endpoint: Pick<GatewayConfig, 'host' | 'port'>,
): Record<string, unknown> {
  const baseUrl = `http://${endpoint.host}:${endpoint.port}`;
  const openAiBaseUrl = `${baseUrl}/v1`;
  const mcpUrl = `${baseUrl}/mcp`;
  if (kind === 'generic-openai') {
    return {
      kind,
      openai_base_url: openAiBaseUrl,
      ['api_key']: 'local-model-gateway',
      model_source: 'GET /v1/models',
    };
  }
  if (kind === 'generic-mcp') {
    return {
      kind,
      mcp_url: mcpUrl,
      transport: 'streamable-http',
    };
  }
  return {
    kind,
    provider: {
      type: 'custom',
      base_url: openAiBaseUrl,
      api_mode: 'chat_completions',
      ['api_key']: 'local-model-gateway',
    },
    mcp_servers: {
      'local-model-gateway': {
        url: mcpUrl,
        transport: 'httpStream',
      },
    },
  };
}

export function registerTools(
  server: FastMCP,
  scheduler: Scheduler,
  store: GatewayStore,
  registry: ModelRegistry,
  config: Pick<GatewayConfig, 'host' | 'port'>,
  gpuCoordinator?: GpuCoordinator,
): void {
  server.addTool({
    name: 'gateway_status',
    description: 'Read-only gateway queue, runtime, and persisted config status.',
    parameters: z.object({}),
    execute: async () => {
      return textResult({
        config: store.listConfig(),
        queue: scheduler.queueStatus(),
        ...(gpuCoordinator?.status() ?? {
          gpu_queue: [],
          managed_runtimes: [],
        }),
      });
    },
  });

  server.addTool({
    name: 'recommend_local_profile',
    description: 'Recommend a local client profile based on available runtime models and prompt needs.',
    parameters: z.object({
      prompt_tokens: z.number().int().positive().optional(),
      use_case: z.string().optional().default('interactive agent work'),
    }),
    execute: async (args) => {
      const runtimes = gpuCoordinator?.listRuntimeModels() ?? [];
      const viable = runtimes.filter((runtime) => (
        args.prompt_tokens === undefined ||
        runtime.contextWindow === null ||
        runtime.contextWindow >= args.prompt_tokens
      ));
      const preferred = viable.find((runtime) => runtime.state === 'loaded') ?? viable[0] ?? null;
      return textResult({
        use_case: args.use_case,
        recommended_model: preferred?.alias ?? null,
        reason: preferred
          ? 'Selected the first available managed runtime that can satisfy the requested prompt budget.'
          : 'No managed runtime is currently configured for the requested prompt budget.',
        available_runtime_models: runtimes,
      });
    },
  });

  server.addTool({
    name: 'generate_client_config',
    description: 'Generate a protocol-first client config snippet for generic OpenAI, generic MCP, or Hermes.',
    parameters: z.object({
      client: z.enum(['generic-openai', 'generic-mcp', 'hermes']),
    }),
    execute: async (args) => textResult(clientRecipe(args.client, config)),
  });

  server.addTool({
    name: 'validate_client_config',
    description: 'Validate that a client points at the local OpenAI and/or MCP protocol endpoints.',
    parameters: z.object({
      mcp_url: z.string().optional(),
      openai_base_url: z.string().optional(),
    }),
    execute: async (args) => {
      const issues: string[] = [];
      if (args.openai_base_url && !args.openai_base_url.endsWith('/v1')) {
        issues.push('openai_base_url should point at the /v1 endpoint.');
      }
      if (args.openai_base_url && !args.openai_base_url.includes('127.0.0.1') && !args.openai_base_url.includes('localhost')) {
        issues.push('openai_base_url is not a loopback URL.');
      }
      if (args.mcp_url && !args.mcp_url.endsWith('/mcp')) {
        issues.push('mcp_url should point at the /mcp endpoint.');
      }
      return textResult({
        ok: issues.length === 0,
        issues,
      });
    },
  });

  server.addTool({
    name: 'submit_job',
    description: 'Submit a queued inference job to the local GPU scheduler.',
    parameters: z.object({
      model: z.string().optional(),
      prompt: z.string().min(1),
      priority: z.number().int().min(0).max(2).optional().default(1),
      metadata: z.record(z.string(), z.unknown()).optional().default({}),
    }),
    execute: async (args) => {
      try {
        const job = scheduler.submitJob({
          source: 'mcp',
          requestedPriority: args.priority as 0 | 1 | 2,
          model: args.model,
          prompt: args.prompt,
          metadata: args.metadata,
        });
        return textResult({ job });
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : String(error));
      }
    },
  });

  server.addTool({
    name: 'get_job',
    description: 'Get job details by id.',
    parameters: z.object({
      include_events: z.boolean().optional().default(false),
      job_id: z.string(),
    }),
    execute: async (args) => {
      const job = scheduler.getJob(args.job_id);
      if (!job) {
        throw new UserError(`Job not found: ${args.job_id}`);
      }

      if (!args.include_events) {
        return textResult({ job });
      }

      const events = store.listJobEvents(args.job_id);
      return textResult({ events, job });
    },
  });

  server.addTool({
    name: 'wait_job',
    description: 'Wait until a job reaches a terminal state.',
    parameters: z.object({
      job_id: z.string(),
      timeout_ms: z.number().int().positive().optional(),
    }),
    execute: async (args) => {
      const waited = await scheduler.waitForJob(args.job_id, args.timeout_ms);
      return textResult(waited);
    },
  });

  server.addTool({
    name: 'cancel_job',
    description: 'Cancel a queued or running MCP job.',
    parameters: z.object({ job_id: z.string() }),
    execute: async (args) => {
      const cancelled = scheduler.cancelQueuedJob(args.job_id);
      if (!cancelled) {
        throw new UserError(
          `Job ${args.job_id} could not be cancelled.`,
        );
      }
      return textResult({ job: cancelled });
    },
  });

  server.addTool({
    name: 'queue_status',
    description: 'Get queue depth and running counts.',
    parameters: z.object({}),
    execute: async () => {
      return textResult(scheduler.queueStatus());
    },
  });

  server.addTool({
    name: 'list_jobs',
    description: 'List recent jobs, optionally filtered by state.',
    parameters: z.object({
      limit: z.number().int().min(1).max(500).optional().default(100),
      state: stateSchema,
    }),
    execute: async (args) => {
      return textResult({
        jobs: scheduler.listJobs(args.limit, args.state as JobState | undefined),
      });
    },
  });

  server.addTool({
    name: 'list_models',
    description: 'List model aliases from the MCP-managed LoRA registry, optionally including managed runtime aliases.',
    parameters: z.object({
      enabled_only: z.boolean().optional().default(false),
      include_runtimes: z.boolean().optional().default(false),
    }),
    execute: async (args) => {
      return textResult({
        models: registry.listModels(args.enabled_only),
        ...(args.include_runtimes && gpuCoordinator
          ? { runtime_models: gpuCoordinator.listModels() }
          : {}),
      });
    },
  });

  server.addTool({
    name: 'list_runtime_models',
    description: 'List managed local OpenAI-compatible runtime aliases and runtime settings.',
    parameters: z.object({}),
    execute: async () => {
      return textResult({
        runtime_models: gpuCoordinator?.listRuntimeModels() ?? [],
      });
    },
  });

  server.addTool({
    name: 'runtime_status',
    description: 'Show local GPU managed runtime residency, active requests, queue, and last errors.',
    parameters: z.object({}),
    execute: async () => {
      return textResult(
        gpuCoordinator?.status() ?? {
          gpu_queue: [],
          managed_runtimes: [],
        },
      );
    },
  });

  server.addTool({
    name: 'cancel_runtime_request',
    description: 'Cancel a queued or active local GPU runtime request by GPU work item id.',
    parameters: z.object({
      work_item_id: z.string().min(1),
      reason: z.string().optional().default('Cancelled by user'),
    }),
    execute: async (args) => {
      const cancelled = gpuCoordinator?.cancelRuntimeRequest(args.work_item_id, args.reason);
      if (!cancelled) {
        throw new UserError(`Runtime request not found: ${args.work_item_id}`);
      }
      return textResult({ work_item: cancelled });
    },
  });

  server.addTool({
    name: 'force_unload_runtime',
    description: 'Admin escape hatch: fail active work for a runtime and stop its service script.',
    parameters: z.object({
      alias: z.string().min(1),
      reason: z.string().optional().default('Force unload requested'),
    }),
    execute: async (args) => {
      if (!gpuCoordinator) {
        throw new UserError('GPU coordinator is not configured');
      }
      return textResult(await gpuCoordinator.forceUnloadRuntime(args.alias, args.reason));
    },
  });

  server.addTool({
    name: 'import_model',
    description: 'Import a LoRA adapter into MCP-managed model storage and register its alias.',
    parameters: z.object({
      alias: z.string().min(1),
      source_path: z.string().min(1),
    }),
    execute: async (args) => {
      const model = await registry.importModel(args.alias, args.source_path);
      return textResult({
        model,
        restart_required: true,
      });
    },
  });

  server.addTool({
    name: 'remove_model',
    description: 'Remove a model alias and delete its managed copy.',
    parameters: z.object({ alias: z.string().min(1) }),
    execute: async (args) => {
      const removed = await registry.removeModel(args.alias);
      return textResult({
        alias: args.alias,
        removed,
        restart_required: true,
      });
    },
  });

  server.addTool({
    name: 'sync_models',
    description: 'Auto-sync configured startup models into MCP-managed storage.',
    parameters: z.object({}),
    execute: async () => {
      const result = await registry.syncStartup();
      return textResult({
        ...result,
        restart_required: true,
      });
    },
  });

  server.addTool({
    name: 'get_config',
    description: 'Get persisted runtime config values from the gateway database.',
    parameters: z.object({}),
    execute: async () => {
      return textResult({
        config: store.listConfig(),
      });
    },
  });

  server.addTool({
    name: 'update_config',
    description:
      'Persist config values for next restart. Changes do not apply to the running process.',
    parameters: z.object({
      entries: z.record(z.string(), z.string()),
    }),
    execute: async (args) => {
      if (Object.keys(args.entries).length === 0) {
        throw new UserError('entries must include at least one key/value pair');
      }

      store.updateConfig(args.entries);
      return textResult({
        updated_keys: Object.keys(args.entries),
        restart_required: true,
      });
    },
  });
}
