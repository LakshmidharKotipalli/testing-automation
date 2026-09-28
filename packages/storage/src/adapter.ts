import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, ensureDir, pathExists, stableStringify } from "@browserswarm/shared";

/**
 * Storage backend abstraction. Paths are always relative to the adapter root and use '/' separators,
 * so future S3 or database backends can map them to keys.
 */
export interface StorageAdapter {
  readonly root: string;
  /** Absolute/local location for a relative path (used for Playwright outputs like screenshots and traces). */
  resolve(relPath: string): string;
  writeText(relPath: string, data: string, options?: { atomic?: boolean }): Promise<void>;
  writeBytes(relPath: string, data: Uint8Array): Promise<void>;
  writeJson(relPath: string, value: unknown, options?: { atomic?: boolean }): Promise<void>;
  appendLine(relPath: string, line: string): Promise<void>;
  readText(relPath: string): Promise<string>;
  readJson<T = unknown>(relPath: string): Promise<T>;
  exists(relPath: string): Promise<boolean>;
  list(relDir: string): Promise<string[]>;
  ensureDir(relDir: string): Promise<void>;
}

function assertRelative(relPath: string): void {
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
    throw new Error(`storage paths must be relative and inside the root: ${relPath}`);
  }
}

export class FilesystemStorage implements StorageAdapter {
  constructor(readonly root: string) {}

  resolve(relPath: string): string {
    assertRelative(relPath);
    return path.join(this.root, relPath);
  }

  async writeText(relPath: string, data: string, options: { atomic?: boolean } = {}): Promise<void> {
    const file = this.resolve(relPath);
    if (options.atomic === false) {
      await ensureDir(path.dirname(file));
      await writeFile(file, data);
      return;
    }
    await atomicWriteFile(file, data);
  }

  async writeBytes(relPath: string, data: Uint8Array): Promise<void> {
    await atomicWriteFile(this.resolve(relPath), data);
  }

  async writeJson(relPath: string, value: unknown, options: { atomic?: boolean } = {}): Promise<void> {
    await this.writeText(relPath, `${stableStringify(value)}\n`, options);
  }

  async appendLine(relPath: string, line: string): Promise<void> {
    const file = this.resolve(relPath);
    await ensureDir(path.dirname(file));
    await appendFile(file, line.endsWith("\n") ? line : `${line}\n`);
  }

  async readText(relPath: string): Promise<string> {
    return readFile(this.resolve(relPath), "utf8");
  }

  async readJson<T = unknown>(relPath: string): Promise<T> {
    return JSON.parse(await this.readText(relPath)) as T;
  }

  async exists(relPath: string): Promise<boolean> {
    return pathExists(this.resolve(relPath));
  }

  async list(relDir: string): Promise<string[]> {
    try {
      return (await readdir(this.resolve(relDir))).sort();
    } catch {
      return [];
    }
  }

  async ensureDir(relDir: string): Promise<void> {
    await ensureDir(this.resolve(relDir));
  }
}
