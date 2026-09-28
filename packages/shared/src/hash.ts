import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

export const HASH_PREFIX = "sha256:";
export type Sha256 = `sha256:${string}`;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256(data: string | Uint8Array): Sha256 {
  return `${HASH_PREFIX}${sha256Hex(data)}`;
}

/** SHA-256 over the canonical JSON form of `value`. */
export function hashObject(value: unknown): Sha256 {
  return sha256(canonicalize(value));
}

/**
 * Hash an object while ignoring one of its own fields (typically the field that will hold the hash).
 * The field is removed, not blanked, so the result does not depend on the placeholder value.
 */
export function hashExcluding<T extends object>(value: T, field: keyof T): Sha256 {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete copy[field as string];
  return hashObject(copy);
}

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

/** Constant-time-ish comparison is unnecessary here (no secrets), but normalize casing. */
export function hashesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
