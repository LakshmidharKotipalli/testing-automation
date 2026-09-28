import type { ModelRef, TokenUsage } from "@browserswarm/core";

export interface LLMGenerateInput {
  /** Bounded instruction context. Never contains secrets, cookies, raw DOM or prior transcripts. */
  system?: string;
  prompt: string;
  maxTokens?: number;
  responseFormat?: "json" | "text";
  model?: ModelRef;
  /** Free-form tags for telemetry (e.g. purpose: "locator_fallback"). Never sent to the model. */
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

export interface LLMGenerateOutput {
  text: string;
  usage?: TokenUsage;
  /** Context window reported by the provider, when available. */
  contextWindowTokens?: number;
  model?: string;
}

export type LLMStreamEvent =
  | { type: "text"; text: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done" };

export interface LLMClient {
  generate(input: LLMGenerateInput): Promise<LLMGenerateOutput>;
  stream?(input: LLMGenerateInput): AsyncIterable<LLMStreamEvent>;
}

export class LLMClientError extends Error {
  constructor(
    readonly kind: "timeout" | "process" | "malformed" | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "LLMClientError";
  }
}
