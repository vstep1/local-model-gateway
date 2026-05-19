import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export async function copyFileAtomic(sourcePath: string, targetPath: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await ensureDir(dir);
  const tempPath = `${targetPath}.tmp-${Date.now()}`;
  await fs.copyFile(sourcePath, tempPath);
  await fs.rename(tempPath, targetPath);
}
