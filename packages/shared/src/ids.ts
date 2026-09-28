import { randomBytes } from "node:crypto";

export function shortRandom(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

export function newId(prefix: string): string {
  return `${prefix}-${shortRandom(6)}`;
}

/** Run IDs sort chronologically: run-YYYYMMDD-HHMMSS-xxxxxxxx. */
export function newRunId(date: Date = new Date()): string {
  const iso = date.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  return `run-${stamp}-${shortRandom(4)}`;
}

export function padSequence(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
