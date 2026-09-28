import type { TokenUsage } from "@browserswarm/core";
import { estimateTokens } from "./tokens.js";
import { LLMClientError, type LLMClient, type LLMGenerateInput, type LLMGenerateOutput } from "./types.js";

export type MockResponse =
  | { kind: "text"; text: string; usage?: Partial<TokenUsage> }
  | { kind: "json"; value: unknown; usage?: Partial<TokenUsage> }
  | { kind: "malformed"; text?: string }
  | { kind: "process_failure"; message?: string };

export interface MockLLMOptions {
  /** Responses returned in order; the last one repeats. Alternatively supply a handler. */
  responses?: MockResponse[];
  handler?: (input: LLMGenerateInput, callIndex: number) => MockResponse;
  /** Reported context window (lets tests simulate a small context to force warnings/hard limits). */
  contextWindowTokens?: number;
  /** Adds this many input tokens per call on top of the prompt estimate (simulates growing context). */
  syntheticInputTokensPerCall?: number;
  /** Report usage as exact (true) or omit usage so callers must estimate (false). */
  reportExactUsage?: boolean;
}

/** Deterministic LLM client for tests and offline development. Records every call. */
export class MockLLMClient implements LLMClient {
  readonly calls: LLMGenerateInput[] = [];
  private cumulativeInput = 0;

  constructor(private readonly options: MockLLMOptions = {}) {}

  get callCount(): number {
    return this.calls.length;
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    if (input.signal?.aborted) throw new LLMClientError("aborted", "aborted");
    const index = this.calls.length;
    this.calls.push(input);
    const response = this.pick(input, index);
    if (response.kind === "process_failure") {
      throw new LLMClientError("process", response.message ?? "mock model process failed");
    }
    const text =
      response.kind === "json"
        ? JSON.stringify(response.value)
        : response.kind === "malformed"
          ? (response.text ?? "this is not json {")
          : response.text;

    const promptTokens = estimateTokens(`${input.system ?? ""}\n${input.prompt}`).tokens;
    this.cumulativeInput += promptTokens + (this.options.syntheticInputTokensPerCall ?? 0);
    const outputTokens = estimateTokens(text).tokens;
    const override = "usage" in response ? response.usage : undefined;
    const usage: TokenUsage = {
      inputTokens: override?.inputTokens ?? this.cumulativeInput,
      outputTokens: override?.outputTokens ?? outputTokens,
      totalTokens:
        override?.totalTokens ??
        (override?.inputTokens ?? this.cumulativeInput) + (override?.outputTokens ?? outputTokens),
      exact: true,
    };
    const out: LLMGenerateOutput = { text, model: input.model?.model ?? "mock/model" };
    if (this.options.reportExactUsage !== false) out.usage = usage;
    if (this.options.contextWindowTokens !== undefined)
      out.contextWindowTokens = this.options.contextWindowTokens;
    return out;
  }

  private pick(input: LLMGenerateInput, index: number): MockResponse {
    if (this.options.handler) return this.options.handler(input, index);
    const list = this.options.responses ?? [{ kind: "text", text: "{}" }];
    return list[Math.min(index, list.length - 1)] as MockResponse;
  }
}
