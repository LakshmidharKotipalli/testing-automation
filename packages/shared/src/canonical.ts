/**
 * Deterministic JSON serialization: object keys sorted lexicographically, `undefined` members dropped,
 * no insignificant whitespace. Used for every hash in BrowserSwarm so identical content always hashes
 * identically regardless of key insertion order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet()));
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonicalize: non-finite numbers are not serializable");
    }
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
    }
    return value;
  }
  if (seen.has(value)) {
    throw new TypeError("canonicalize: circular structure");
  }
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => (item === undefined ? null : normalize(item, seen)));
  } else if (value instanceof Date) {
    out = value.toISOString();
  } else {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) continue;
      sorted[key] = normalize(member, seen);
    }
    out = sorted;
  }
  seen.delete(value);
  return out;
}

/** Pretty, still key-sorted JSON for human-facing files. Parsing it yields the canonical value. */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(JSON.parse(canonicalize(value)), null, indent);
}
