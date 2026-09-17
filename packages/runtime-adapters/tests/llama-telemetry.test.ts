import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const adapterPath = join(repoRoot, 'examples/runtime-adapters/macos/launchd-llama-server.sh');
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8');
  await chmod(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function telemetrySnapshots(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('llama runtime telemetry adapter', () => {
  it('parses modern and legacy slot events without inferring totals or regressing generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llama-telemetry-'));
    try {
      const bin = join(root, 'bin');
      const state = join(root, 'state');
      const logs = join(root, 'logs');
      const tempDir = join(root, 'tmp');
      const progressPath = join(root, 'progress.json');
      const probePath = join(root, 'progress-snapshots.jsonl');
      const envPath = join(root, 'runtime.env');
      const launchctlLog = join(root, 'launchctl.log');
      await mkdir(bin, { recursive: true });
      await mkdir(tempDir, { recursive: true });
      await writeFile(envPath, [
        'RUNTIME_ALIAS=synthetic',
        'RUNTIME_LABEL=ai.local.runtime.synthetic',
        `RUNTIME_LLAMA_SERVER=${shellQuote(join(bin, 'fake-llama'))}`,
        `RUNTIME_MODEL_PATH=${shellQuote(join(root, 'model.gguf'))}`,
        `export RUNTIME_PROGRESS_FILE=${shellQuote(progressPath)}`,
        `export PROBE_PATH=${shellQuote(probePath)}`,
        `RUNTIME_STATE_DIR=${shellQuote(state)}`,
        `RUNTIME_LOG_DIR=${shellQuote(logs)}`,
        `RUNTIME_PLIST_DIR=${shellQuote(join(root, 'plists'))}`,
        'RUNTIME_EXTRA_ARGS=--synthetic',
      ].join('\n') + '\n');
      await writeExecutable(join(bin, 'launchctl'), [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"',
        'if [[ "$1" == print ]]; then exit 1; fi',
        'exit 0',
      ].join('\n') + '\n');
      await writeExecutable(join(bin, 'fake-llama'), [
        '#!/usr/bin/env bash',
        'wait_for_change() {',
        '  local before="$1"',
        '  local attempts=0',
        '  while :; do',
        '    if [[ -f "$RUNTIME_PROGRESS_FILE" ]] && [[ "$(<"$RUNTIME_PROGRESS_FILE")" != "$before" ]]; then return 0; fi',
        '    attempts=$((attempts + 1))',
        '    if (( attempts >= 500 )); then echo "timed out waiting for telemetry" >&2; return 1; fi',
        '    sleep 0.01',
        '  done',
        '}',
        'record_snapshot() {',
        '  cat "$RUNTIME_PROGRESS_FILE" >> "$PROBE_PATH"',
        '  printf "\\n" >> "$PROBE_PATH"',
        '}',
        'emit() {',
        '  local line="$1"',
        '  local wait_for_write="${2:-false}"',
        '  local before=""',
        '  if [[ "$wait_for_write" == true && -f "$RUNTIME_PROGRESS_FILE" ]]; then before="$(<"$RUNTIME_PROGRESS_FILE")"; fi',
        '  printf "%s\\n" "$line" >&2',
        '  printf "fake-runtime:%s\\n" "$line"',
        '  if [[ "$wait_for_write" == true ]]; then wait_for_change "$before"; record_snapshot; fi',
        '}',
        'emit "2.17.234.411 I slot print_timing: id 0 | task 7 | prompt processing, n_tokens = 30351, progress = 0.69, t = 135.20 s" true',
        'emit "4.00.000.000 I slot print_timing: id 0 | task 6 | n_gen = 100, tg = 5.00 t/s"',
        'emit "4.10.000.000 I slot print_timing: id 0 | task 7 | n_gen = 100, tg = 5.00 t/s" true',
        'emit "4.20.000.000 I slot print_timing: id 0 | task 7 | prompt processing, n_tokens = 40000, progress = 0.80, t = 150.00 s"',
        'emit "slot print_timing: id 0 | task 8 | prompt processing, n_tokens = 12, progress = 0.25, t = 1.00 s" true',
        'emit "slot update_slots: task 9 new prompt task.n_tokens = 4096" true',
        'emit "slot update_slots: task 9 prompt processing progress, n_tokens = 1024, progress = 0.25" true',
        'emit "slot update_slots: task 9 prompt processing done" true',
        'emit "slot print_timing: id 0 | task 9 | n_gen = 100, tg = 5.00 t/s" true',
        'emit "slot      release: id 0 | task 9"',
      ].join('\n') + '\n');

      const env = {
        ...process.env,
        HOME: root,
        TMPDIR: tempDir,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        LAUNCHCTL_LOG: launchctlLog,
        LOCAL_MODEL_GATEWAY_RUNTIME_ENV: envPath,
      };
      const start = await run('bash', [adapterPath, 'start'], env);
      assert.equal(start.code, 0, start.stderr);
      assert.match(await readFile(launchctlLog, 'utf8'), /bootstrap/);
      assert.match(await readFile(launchctlLog, 'utf8'), /kickstart/);
      const wrapperPath = join(state, 'llama-server-wrapper.sh');
      const execution = await run(wrapperPath, [], env);
      const snapshots = telemetrySnapshots(await readFile(probePath, 'utf8'));
      const final = JSON.parse(await readFile(progressPath, 'utf8')) as Record<string, unknown>;
      assert.equal(execution.code, 0, execution.stderr);
      assert.match(execution.stdout, /fake-runtime:/);
      const modernPrefillIndex = snapshots.findIndex((item) => item.prefill_task_id === 7 && item.prefill_progress === 0.69);
      assert.notEqual(modernPrefillIndex, -1);
      assert.equal(snapshots[modernPrefillIndex + 1]?.prefill_progress, null);
      assert.equal(snapshots[modernPrefillIndex + 1]?.prefill_task_id, null);
      assert.ok(snapshots.some((item) => item.prefill_task_id === 8 && item.prefill_tokens_total === null));
      assert.ok(snapshots.some((item) => item.prefill_task_id === 9 && item.prefill_progress === 0.25 && item.prefill_tokens_total === 4096));
      assert.equal(snapshots.some((item) => item.prefill_task_id === 7 && item.prefill_progress === 0.8), false);
      assert.deepEqual(final, { ...final, prefill_progress: null, prefill_task_id: null, prefill_tokens_done: null, prefill_tokens_total: null });
      assert.equal((await readdir(root)).some((name) => name.includes('.tmp.')), false);
      assert.deepEqual(await readdir(tempDir), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads a path-with-spaces default env file while preserving an env override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llama telemetry with spaces-'));
    try {
      const bin = join(root, 'bin');
      const state = join(root, 'state');
      const logs = join(root, 'logs');
      const tempDir = join(root, 'tmp');
      const defaultProgressPath = join(root, 'default progress.json');
      const overrideProgressPath = join(root, 'override progress.json');
      const defaultEnvPath = join(root, 'default runtime.env');
      const overrideEnvPath = join(root, 'override runtime.env');
      await mkdir(bin, { recursive: true });
      await mkdir(tempDir, { recursive: true });
      await writeExecutable(join(bin, 'launchctl'), '#!/usr/bin/env bash\nexit 0\n');
      await writeExecutable(join(bin, 'fake-llama'), [
        '#!/usr/bin/env bash',
        'printf "env-marker:%s\\n" "${RUNTIME_MARKER:-missing}"',
      ].join('\n') + '\n');
      const commonEnv = [
        'RUNTIME_ALIAS=synthetic',
        'RUNTIME_LABEL=ai.local.runtime.synthetic',
        `RUNTIME_LLAMA_SERVER=${shellQuote(join(bin, 'fake-llama'))}`,
        `RUNTIME_MODEL_PATH=${shellQuote(join(root, 'model file.gguf'))}`,
        `RUNTIME_STATE_DIR=${shellQuote(state)}`,
        `RUNTIME_LOG_DIR=${shellQuote(logs)}`,
        `RUNTIME_PLIST_DIR=${shellQuote(join(root, 'plists'))}`,
      ];
      await writeFile(defaultEnvPath, [
        ...commonEnv,
        `export RUNTIME_PROGRESS_FILE=${shellQuote(defaultProgressPath)}`,
        'export RUNTIME_MARKER=default',
      ].join('\n') + '\n');
      await writeFile(overrideEnvPath, [
        ...commonEnv,
        `export RUNTIME_PROGRESS_FILE=${shellQuote(overrideProgressPath)}`,
        'export RUNTIME_MARKER=override',
      ].join('\n') + '\n');
      const env = {
        ...process.env,
        HOME: root,
        TMPDIR: tempDir,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        LOCAL_MODEL_GATEWAY_RUNTIME_ENV: defaultEnvPath,
      };
      const start = await run('bash', [adapterPath, 'start'], env);
      assert.equal(start.code, 0, start.stderr);
      const wrapperPath = join(state, 'llama-server-wrapper.sh');
      const defaultExecutionEnv: NodeJS.ProcessEnv = { ...env };
      delete defaultExecutionEnv.LOCAL_MODEL_GATEWAY_RUNTIME_ENV;
      const defaultExecution = await run(wrapperPath, [], defaultExecutionEnv);
      assert.equal(defaultExecution.code, 0, defaultExecution.stderr);
      assert.match(defaultExecution.stdout, /env-marker:default/);
      const overrideExecution = await run(wrapperPath, [], { ...env, LOCAL_MODEL_GATEWAY_RUNTIME_ENV: overrideEnvPath });
      assert.equal(overrideExecution.code, 0, overrideExecution.stderr);
      assert.match(overrideExecution.stdout, /env-marker:override/);
      assert.equal((await readdir(root)).some((name) => name.includes('.tmp.')), false);
      assert.deepEqual(await readdir(tempDir), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
