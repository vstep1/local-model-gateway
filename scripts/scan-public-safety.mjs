#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const ignored = new Set(['node_modules', 'dist', '.git']);
const forbidden = [
  { pattern: /\/Users\/vs\b/, message: 'hardcoded local user path' },
  { pattern: /\bcom\.vs\./, message: 'personal launchd label' },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/, message: 'literal bearer token' },
  { pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i, message: 'possible checked-in secret' },
];
const forbiddenPackageFiles = [
  /(^|\/)data\//,
  /(^|\/)models\//,
  /\.sqlite(-shm|-wal)?$/,
  /\.gguf$/,
  /\.safetensors$/,
  /(^|\/)\.env$/,
];

async function walk(dir, files = []) {
  for (const entry of await readdir(dir)) {
    if (ignored.has(entry)) continue;
    const full = path.join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      await walk(full, files);
    } else {
      files.push(full);
    }
  }
  return files;
}

const failures = [];
for (const file of await walk(root)) {
  const rel = path.relative(root, file);
  if (forbiddenPackageFiles.some((pattern) => pattern.test(rel))) {
    failures.push(`${rel}: forbidden runtime artifact`);
    continue;
  }
  if (!/\.(ts|js|mjs|json|md|yaml|yml|example|gitignore)$/.test(rel)) continue;
  const text = await readFile(file, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) {
      failures.push(`${rel}: ${rule.message}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('public safety scan passed');
