import { execFile } from 'node:child_process';
import { homedir, tmpdir, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { GatewayConfig, GenerationBackend, GenerationRequest, GenerationResult } from '../types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_CHILD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function childProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const existingPath = String(env.PATH ?? '').trim();
  const fallbackUser = userInfo().username || 'local';

  env.HOME = String(env.HOME ?? '').trim() || homedir();
  env.PATH = existingPath
    ? ['/opt/homebrew/bin', existingPath].filter((entry, index, entries) => entries.indexOf(entry) === index).join(':')
    : DEFAULT_CHILD_PATH;
  env.TMPDIR = String(env.TMPDIR ?? '').trim() || tmpdir();
  env.USER = String(env.USER ?? '').trim() || fallbackUser;
  env.LOGNAME = String(env.LOGNAME ?? '').trim() || env.USER;

  return env;
}

function cleanOutput(raw: string, sourcePrompt: string): string {
  let text = raw.replace(/\r\n/g, '\n');
  text = text.replace(/<\|im_start\|>|<\|im_end\|>/g, '');

  if (text.includes('Exiting...')) {
    text = text.split('Exiting...')[0] ?? text;
  }

  if (sourcePrompt && text.includes(sourcePrompt)) {
    text = text.split(sourcePrompt).pop() ?? text;
  }

  const truncatedPromptMarker = '... (truncated)';
  if (text.includes(truncatedPromptMarker)) {
    text = text.slice(text.lastIndexOf(truncatedPromptMarker) + truncatedPromptMarker.length);
  }

  const filtered = text
    .split('\n')
    .filter((line) => {
      const value = line.trim();
      if (!value) return true;
      if (value === 'Loading model...') return false;
      if (value === 'modalities : text') return false;
      if (value === 'available commands:') return false;
      if (value.startsWith('load_backend:')) return false;
      if (value.startsWith('ggml_')) return false;
      if (value.startsWith('build      :')) return false;
      if (value.startsWith('model      :')) return false;
      if (value.startsWith('> SYSTEM:')) return false;
      if (value.startsWith('SYSTEM:')) return false;
      if (value.startsWith('USER:')) return false;
      if (value.startsWith('TEXT:')) return false;
      if (value.startsWith('/exit')) return false;
      if (value.startsWith('/regen')) return false;
      if (value.startsWith('/clear')) return false;
      if (value.startsWith('/read')) return false;
      if (value.startsWith('/glob')) return false;
      if (/^[▄█▀\s]+$/.test(value)) return false;
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
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    const temperature = request.temperature ?? this.config.temperature;
    const topP = request.topP ?? this.config.topP;
    const repeatPenalty = request.repeatPenalty ?? this.config.repeatPenalty;

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
      String(maxTokens),
      '--temp',
      String(temperature),
      '--top-p',
      String(topP),
      '--repeat-penalty',
      String(repeatPenalty),
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

    const execEnv = childProcessEnv();
    const execCwd = process.cwd();

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        timeout: this.config.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        cwd: execCwd,
        env: execEnv,
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
          `cwd=${execCwd}`,
          `child_env_home=${String(execEnv.HOME ?? '')}`,
          `child_env_tmpdir=${String(execEnv.TMPDIR ?? '')}`,
          `child_env_path=${String(execEnv.PATH ?? '')}`,
          stdoutTail ? `stdout_tail=${stdoutTail}` : null,
          stderrTail ? `stderr_tail=${stderrTail}` : null,
        ].filter(Boolean).join('\n'),
      );
    }
  }
}
