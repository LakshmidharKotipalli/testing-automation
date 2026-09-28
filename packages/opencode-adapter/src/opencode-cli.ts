import { spawn } from "node:child_process";
import type { ModelRef, TokenUsage } from "@browserswarm/core";
import { createRedactor, llmApiKeyFromEnv, type LlmApiKey, type Redactor } from "@browserswarm/shared";
import { estimateTokens } from "./tokens.js";
import { LLMClientError, type LLMClient, type LLMGenerateInput, type LLMGenerateOutput } from "./types.js";

export interface OpenCodeCliOptions {
  /** Executable name or path, e.g. "opencode". */
  command: string;
  /**
   * Argument template. Placeholders: {model}, {maxTokens}. The shape of OpenCode's CLI varies between
   * versions; this is configuration, not an assumption baked into the code (see docs/opencode.md).
   */
  argsTemplate: string[];
  model: string;
  timeoutMs?: number;
  cwd?: string;
  /** How the prompt is delivered. Only stdin is supported: prompts never appear in process listings. */
  promptMode?: "stdin";
  /** "json": stdout is JSON (or NDJSON events); "text-json-block": stdout is text to be returned as-is. */
  outputFormat?: "json" | "text-json-block";
  /** Environment variables passed through to the child. Everything else is dropped. */
  envAllowlist?: string[];
  /** Applied to prompts before they leave the process, as a last line of defense. */
  redactor?: Redactor;
  contextWindowTokens?: number;
  /**
   * LLM API key from the central .env (BROWSERSWARM_LLM_API_KEY). Exported to the OpenCode child process
   * only, under `exportAs` (e.g. ANTHROPIC_API_KEY); never logged, persisted or placed in prompts.
   */
  apiKey?: LlmApiKey;
}

const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

export function renderArgs(template: string[], vars: Record<string, string>): string[] {
  return template.map((arg) => arg.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m));
}

export function buildChildEnv(
  allowlist: string[],
  source: NodeJS.ProcessEnv = process.env,
  apiKey?: LlmApiKey,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) if (source[key] !== undefined) env[key] = source[key];
  if (apiKey) env[apiKey.exportAs] = apiKey.value;
  return env;
}

/**
 * Subprocess-backed client. Credentials come either from OpenCode's own login or from the central
 * BROWSERSWARM_LLM_API_KEY in .env, which is handed to the child process only.
 */
export class OpenCodeCliClient implements LLMClient {
  constructor(private readonly options: OpenCodeCliOptions) {}

  static fromModelRef(
    ref: ModelRef,
    extra: Partial<OpenCodeCliOptions> = {},
    env: NodeJS.ProcessEnv = process.env,
  ): OpenCodeCliClient {
    const apiKey = llmApiKeyFromEnv(env, ref.apiKeyEnv);
    return new OpenCodeCliClient({
      ...(apiKey ? { apiKey } : {}),
      command: ref.command ?? "opencode",
      argsTemplate: ref.argsTemplate ?? ["run", "--model", "{model}"],
      model: ref.model,
      ...(ref.timeoutMs !== undefined ? { timeoutMs: ref.timeoutMs } : {}),
      ...(ref.outputFormat !== undefined ? { outputFormat: ref.outputFormat } : {}),
      ...(ref.contextWindowTokens !== undefined ? { contextWindowTokens: ref.contextWindowTokens } : {}),
      ...extra,
    });
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    const o = this.options;
    const keyRedactor = o.apiKey
      ? createRedactor([{ label: "llmApiKey", value: o.apiKey.value }])
      : undefined;
    const redact = (s: string) => {
      const r = o.redactor ? o.redactor.redactString(s) : s;
      return keyRedactor ? keyRedactor.redactString(r) : r;
    };
    const promptText = redact(input.system ? `${input.system}\n\n${input.prompt}` : input.prompt);
    const args = renderArgs(o.argsTemplate, {
      model: input.model?.model ?? o.model,
      maxTokens: String(input.maxTokens ?? 1500),
    });

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(o.command, args, {
        cwd: o.cwd,
        env: buildChildEnv(o.envAllowlist ?? DEFAULT_ENV_ALLOWLIST, process.env, o.apiKey),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new LLMClientError("timeout", `opencode timed out after ${o.timeoutMs ?? 120_000}ms`));
      }, o.timeoutMs ?? 120_000);
      const onAbort = () => {
        child.kill("SIGTERM");
        reject(new LLMClientError("aborted", "aborted"));
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new LLMClientError("process", `failed to start ${o.command}: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        if (code === 0) resolve(out);
        else
          reject(
            new LLMClientError("process", `${o.command} exited with ${code}: ${redact(err).slice(0, 500)}`),
          );
      });
      child.stdin.end(promptText);
    });

    const parsed = o.outputFormat === "text-json-block" ? { text: stdout } : parseOpenCodeJson(stdout);
    const usage =
      parsed.usage ??
      ({
        inputTokens: estimateTokens(promptText).tokens,
        outputTokens: estimateTokens(parsed.text).tokens,
        totalTokens: estimateTokens(promptText).tokens + estimateTokens(parsed.text).tokens,
        exact: false,
      } satisfies TokenUsage);
    const result: LLMGenerateOutput = { text: parsed.text, usage, model: input.model?.model ?? o.model };
    if (o.contextWindowTokens !== undefined) result.contextWindowTokens = o.contextWindowTokens;
    return result;
  }
}

const TEXT_PATHS = [
  ["text"],
  ["content"],
  ["output"],
  ["response"],
  ["message", "content"],
  ["result"],
  ["part", "text"],
];

function dig(obj: unknown, pathParts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of pathParts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function num(obj: unknown, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = dig(obj, k.split("."));
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Parses OpenCode JSON output: a single JSON document or NDJSON events. Text fragments are concatenated;
 * token usage is taken from the last event that reports it.
 */
export function parseOpenCodeJson(stdout: string): { text: string; usage?: TokenUsage } {
  const docs: unknown[] = [];
  try {
    docs.push(JSON.parse(stdout));
  } catch {
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        docs.push(JSON.parse(t));
      } catch {
        /* non-JSON log line: ignored */
      }
    }
  }
  if (docs.length === 0) return { text: stdout.trim() };
  let text = "";
  let usage: TokenUsage | undefined;
  for (const doc of docs) {
    for (const p of TEXT_PATHS) {
      const v = dig(doc, p);
      if (typeof v === "string") {
        text += v;
        break;
      }
    }
    const input = num(doc, [
      "usage.input_tokens",
      "usage.inputTokens",
      "usage.prompt_tokens",
      "tokens.input",
    ]);
    const output = num(doc, [
      "usage.output_tokens",
      "usage.outputTokens",
      "usage.completion_tokens",
      "tokens.output",
    ]);
    if (input !== undefined || output !== undefined) {
      const total = num(doc, ["usage.total_tokens", "usage.totalTokens"]) ?? (input ?? 0) + (output ?? 0);
      usage = { inputTokens: input ?? 0, outputTokens: output ?? 0, totalTokens: total, exact: true };
    }
  }
  return usage ? { text, usage } : { text };
}
