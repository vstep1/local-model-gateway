import fs from 'node:fs/promises';
import path from 'node:path';
import { GatewayStore } from './db.js';
import { GatewayConfig, ModelRecord } from './types.js';
import { copyFileAtomic, ensureDir, fileSha256 } from './utils.js';

export interface SyncResult {
  imported: string[];
  updated: string[];
  skipped: string[];
  missingSources: string[];
}

export class ModelRegistry {
  constructor(
    private readonly store: GatewayStore,
    private readonly config: GatewayConfig,
  ) {}

  async syncStartup(): Promise<SyncResult> {
    return this.syncFromSourceMap(this.config.startupModels);
  }

  async syncFromSourceMap(sourceMap: Record<string, string>): Promise<SyncResult> {
    const imported: string[] = [];
    const updated: string[] = [];
    const skipped: string[] = [];
    const missingSources: string[] = [];

    for (const [alias, sourcePath] of Object.entries(sourceMap)) {
      try {
        const exists = await this.fileExists(sourcePath);
        if (!exists) {
          missingSources.push(`${alias}:${sourcePath}`);
          continue;
        }

        const sourceHash = await fileSha256(sourcePath);
        const existing = this.store.getModel(alias);

        if (existing && existing.checksumSha256 === sourceHash && existing.enabled) {
          skipped.push(alias);
          continue;
        }

        const managedPath = await this.copyIntoManagedStorage(alias, sourcePath);
        this.store.upsertModel({
          alias,
          adapterPath: managedPath,
          sourcePath,
          managedPath,
          checksumSha256: sourceHash,
          enabled: true,
        });

        if (existing) {
          updated.push(alias);
        } else {
          imported.push(alias);
        }
      } catch {
        missingSources.push(`${alias}:${sourcePath}`);
      }
    }

    return { imported, updated, skipped, missingSources };
  }

  listModels(enabledOnly = false): ModelRecord[] {
    return this.store.listModels(enabledOnly);
  }

  getModel(alias: string): ModelRecord | null {
    return this.store.getModel(alias);
  }

  async importModel(alias: string, sourcePath: string): Promise<ModelRecord> {
    if (!alias.trim()) {
      throw new Error('alias is required');
    }

    if (!(await this.fileExists(sourcePath))) {
      throw new Error(`Model source not found: ${sourcePath}`);
    }

    const checksumSha256 = await fileSha256(sourcePath);
    const managedPath = await this.copyIntoManagedStorage(alias, sourcePath);

    return this.store.upsertModel({
      alias,
      adapterPath: managedPath,
      sourcePath,
      managedPath,
      checksumSha256,
      enabled: true,
    });
  }

  async removeModel(alias: string): Promise<boolean> {
    const record = this.store.getModel(alias);
    const removed = this.store.removeModel(alias);

    if (record) {
      const folder = path.dirname(record.managedPath);
      try {
        await fs.rm(folder, { recursive: true, force: true });
      } catch {
        // Best effort cleanup only.
      }
    }

    return removed;
  }

  private async copyIntoManagedStorage(alias: string, sourcePath: string): Promise<string> {
    const filename = path.basename(sourcePath);
    const modelDir = path.join(this.config.modelsDir, alias);
    const managedPath = path.join(modelDir, filename);

    await ensureDir(modelDir);
    await copyFileAtomic(sourcePath, managedPath);

    return managedPath;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }
}
