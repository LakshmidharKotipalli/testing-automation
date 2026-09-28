import type { ContextEstimate } from "@browserswarm/core";

/**
 * Conservative token estimate when a provider does not report usage. 3.5 characters per token
 * over-estimates for English prose and JSON (typically ~4), so budgets trip early rather than late.
 */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): ContextEstimate {
  return {
    tokens: Math.ceil(text.length / CHARS_PER_TOKEN),
    method: "chars-per-token",
    charCount: text.length,
  };
}
