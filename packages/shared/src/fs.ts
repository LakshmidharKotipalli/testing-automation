import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Atomic file write: data goes to a unique temp file in the same directory, is fsync'd, then renamed
 * over the destination. Readers never observe a partially written file.
 */
export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(tmp, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
