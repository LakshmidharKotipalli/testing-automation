import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRedactor } from "@browserswarm/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildChildEnv,
  estimateTokens,
  extractJson,
  generateStructured,
  LLMClientError,
  MockLLMClient,
  OpenCodeCliClient,
  parseOpenCodeJson,
  renderArgs,
} from "../src/index.js";

describe("MockLLMClient", () => {
  it("returns scripted responses and records calls", async () => {
    const m = new MockLLMClient({ responses: [{ kind: "json", value: { ok: true } }] });
    const out = await m.generate({ prompt: "hi" });
    expect(JSON.parse(out.text)).toEqual({ ok: true });
    expect(m.callCount).toBe(1);
    expect(out.usage?.exact).toBe(true);
  });

  it("simulates growing context, small windows, malformed output and process failure", async () => {
    const m = new MockLLMClient({
      responses: [{ kind: "text", text: "a" }, { kind: "malformed" }, { kind: "process_failure" }],
      contextWindowTokens: 2000,
      syntheticInputTokensPerCall: 900,
    });
    const first = await m.generate({ prompt: "p" });
    expect(first.contextWindowTokens).toBe(2000);
    const second = await m.generate({ prompt: "p" });
    expect(second.usage!.inputTokens).toBeGreaterThan(first.usage!.inputTokens);
    await expect(m.generate({ prompt: "p" })).rejects.toBeInstanceOf(LLMClientError);
  });
});

describe("structured output", () => {
  const schema = z.object({ locator: z.object({ label: z.string() }).strict() }).strict();

  it("extracts JSON from fenced or noisy text", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
  });

  it("repairs once, then validates", async () => {
    const m = new MockLLMClient({
      responses: [{ kind: "malformed" }, { kind: "json", value: { locator: { label: "Email" } } }],
    });
    const res = await generateStructured(m, { prompt: "find" }, schema, 1);
    expect(res.attempts).toBe(2);
    expect(res.value.locator.label).toBe("Email");
  });

  it("fails after the repair budget", async () => {
    const m = new MockLLMClient({ responses: [{ kind: "json", value: { locator: { css: "#x" } } }] });
    await expect(generateStructured(m, { prompt: "find" }, schema, 1)).rejects.toMatchObject({
      code: "LLM_OUTPUT_INVALID",
    });
    expect(m.callCount).toBe(2);
  });
});

describe("OpenCodeCliClient", () => {
  it("renders configurable argument templates", () => {
    expect(renderArgs(["run", "--model", "{model}", "--x", "{unknown}"], { model: "p/m" })).toEqual([
      "run",
      "--model",
      "p/m",
      "--x",
      "{unknown}",
    ]);
  });

  it("passes only allowlisted environment variables", () => {
    expect(buildChildEnv(["PATH"], { PATH: "/bin", SECRET_KEY: "x" })).toEqual({ PATH: "/bin" });
  });

  it("parses JSON and NDJSON output with usage", () => {
    expect(parseOpenCodeJson('{"text":"hello","usage":{"input_tokens":10,"output_tokens":2}}')).toEqual({
      text: "hello",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, exact: true },
    });
    const nd =
      '{"type":"part","part":{"text":"a"}}\nlog line\n{"type":"part","part":{"text":"b"}}\n{"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}';
    expect(parseOpenCodeJson(nd)).toEqual({
      text: "ab",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, exact: true },
    });
  });

  it("runs a configured executable via stdin, redacting the prompt and estimating usage when absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bs-oc-"));
    const script = path.join(dir, "fake-opencode.mjs");
    await writeFile(
      script,
      `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ text: "model:" + process.argv[2] + " saw:" + input.length + (input.includes("TopSecret1") ? " LEAK" : " clean") }));
});
`,
    );
    await chmod(script, 0o755);
    const client = new OpenCodeCliClient({
      command: process.execPath,
      argsTemplate: [script, "{model}"],
      model: "provider/model-a",
      outputFormat: "json",
      redactor: createRedactor([{ label: "pw", value: "TopSecret1" }]),
      timeoutMs: 20_000,
    });
    const out = await client.generate({ prompt: "use TopSecret1 please" });
    expect(out.text).toMatch(/^model:provider\/model-a saw:\d+ clean$/);
    expect(out.usage?.exact).toBe(false);
    expect(out.usage?.inputTokens).toBeGreaterThan(0);
  });

  it("reports process failures", async () => {
    const client = new OpenCodeCliClient({
      command: "/nonexistent/opencode",
      argsTemplate: [],
      model: "m",
      timeoutMs: 5000,
    });
    await expect(client.generate({ prompt: "x" })).rejects.toMatchObject({ kind: "process" });
  });
});

describe("token estimation", () => {
  it("is conservative (3.5 chars per token)", () => {
    expect(estimateTokens("a".repeat(35)).tokens).toBe(10);
  });
});
