import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GatewayConfig, GenerationBackend, GenerationRequest, GenerationResult } from '../types.js';

const execFileAsync = promisify(execFile);

function cleanOutput(raw: string, sourcePrompt: string): string {
  let text = raw.replace(/\r\n/g, '\n');
  text = text.replace(/<\|im_start\|>|<\|im_end\|>/g, '');

  if (text.includes('Exiting...')) {
    text = text.split('Exiting...')[0] ?? text;
  }

  if (sourcePrompt && text.includes(sourcePrompt)) {
    text = text.split(sourcePrompt).pop() ?? text;
  }

  const filtered = text
    .split('\n')
    .filter((line) => {
      const value = line.trim();
      if (!value) return true;
      if (value.startsWith('load_backend:')) return false;
      if (value.startsWith('ggml_')) return false;
      if (value.startsWith('build      :')) return false;
      if (value.startsWith('model      :')) return false;
      if (value.startsWith('/exit')) return false;
      return true;
    })
    .join('\n')
    .trim();

  return filtered;
}

export class LlamaCliBackend implements GenerationBackend {
  constructor(private readonly config: GatewayConfig) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const start = Date.now();

    const cmd = this.config.llamaCliPath;
    const args = [
      '-m',
      this.config.baseModelPath,
      '--lora',
      request.adapterPath,
      '-ngl',
      this.config.gpuLayers,
      '-c',
      String(this.config.ctxSize),
      '-n',
      String(this.config.maxTokens),
      '--temp',
      String(this.config.temperature),
      '--top-p',
      String(this.config.topP),
      '--repeat-penalty',
      String(this.config.repeatPenalty),
      '--no-display-prompt',
      '--simple-io',
      '--no-show-timings',
      '--log-disable',
      '--no-warmup',
      '--single-turn',
      '--reasoning',
      'off',
      '-p',
      request.prompt,
    ];

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        timeout: this.config.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        signal: request.signal,
      });

      const raw = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
      const output = cleanOutput(raw, request.prompt);
      const durationMs = Date.now() - start;

      if (!output) {
        throw new Error('llama-cli produced empty output');
      }

      return {
        outputText: output,
        rawTail: raw.slice(-4000),
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      const childError = error as {
        code?: unknown;
        signal?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
      const stdoutTail = String(childError.stdout ?? '').slice(-2000);
      const stderrTail = String(childError.stderr ?? '').slice(-4000);
      throw new Error(
        [
          `llama-cli failed after ${durationMs}ms: ${message}`,
          childError.code === undefined ? null : `exit_code=${String(childError.code)}`,
          childError.signal === undefined ? null : `signal=${String(childError.signal)}`,
          stdoutTail ? `stdout_tail=${stdoutTail}` : null,
          stderrTail ? `stderr_tail=${stderrTail}` : null,
        ].filter(Boolean).join('\n'),
      );
    }
  }
}
