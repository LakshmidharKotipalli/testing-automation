import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  atomicWriteFile,
  canonicalize,
  createRedactor,
  hashExcluding,
  hashObject,
  isSha256,
  newRunId,
  stableStringify,
} from "../src/index.js";

describe("canonical JSON and hashing", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalize({ b: 1, a: { d: [1, 2], c: undefined } })).toBe('{"a":{"d":[1,2]},"b":1}');
    expect(hashObject({ x: 1, y: [1, { z: 2, a: 1 }] })).toBe(hashObject({ y: [1, { a: 1, z: 2 }], x: 1 }));
  });

  it("produces sha256-prefixed hashes and detects changes", () => {
    const h = hashObject({ a: 1 });
    expect(isSha256(h)).toBe(true);
    expect(hashObject({ a: 2 })).not.toBe(h);
  });

  it("excludes the hash field itself", () => {
    const doc = { a: 1, integrityHash: "sha256:placeholder" };
    expect(hashExcluding(doc, "integrityHash")).toBe(hashObject({ a: 1 }));
  });

  it("rejects non-serializable values", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalize(circular)).toThrow();
  });

  it("stableStringify round-trips to the canonical value", () => {
    const value = { z: 1, a: [3, { y: 2, b: 1 }] };
    expect(canonicalize(JSON.parse(stableStringify(value)))).toBe(canonicalize(value));
  });
});

describe("redaction", () => {
  const r = createRedactor([
    { label: "testData.password", value: "S3cretValue!" },
    { label: "testData.email", value: "qa@example.test" },
  ]);

  it("replaces registered secret values", () => {
    expect(r.redactString("login qa@example.test / S3cretValue!")).toBe(
      "login [REDACTED:testData.email] / [REDACTED:testData.password]",
    );
    expect(r.containsSecret("xx S3cretValue! xx")).toBe(true);
    expect(r.containsSecret("nothing here")).toBe(false);
  });

  it("redacts bearer tokens, JWTs and sensitive keys in objects", () => {
    const out = r.redactValue({
      header: "Bearer abcdefghijklmnop",
      nested: {
        password: "hunter22",
        cookie: "sid=1",
        note: "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f",
      },
    });
    expect(JSON.stringify(out)).not.toMatch(/hunter22|sid=1|abcdefghijklmnop|SflKxwRJ/);
  });

  it("keeps unresolved templates under sensitive keys", () => {
    expect(r.redactValue({ password: "{{testData.password}}" })).toEqual({
      password: "{{testData.password}}",
    });
  });

  it("does not corrupt sha256 hashes", () => {
    const h = hashObject({ a: 1 });
    expect(r.redactString(h)).toBe(h);
  });
});

describe("atomic writes and ids", () => {
  it("writes atomically without leaving temp files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bs-shared-"));
    const file = path.join(dir, "nested", "x.json");
    await atomicWriteFile(file, "one");
    await atomicWriteFile(file, "two");
    expect(await readFile(file, "utf8")).toBe("two");
    expect((await readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("run ids sort chronologically", () => {
    const a = newRunId(new Date("2026-01-01T00:00:00Z"));
    const b = newRunId(new Date("2026-01-02T00:00:00Z"));
    expect(a < b).toBe(true);
    expect(a).toMatch(/^run-20260101-000000-[a-f0-9]{8}$/);
  });
});
