import { BrowserSwarmError, formatZodIssues } from "@browserswarm/core";
import type { z } from "zod";
import type { LLMClient, LLMGenerateInput, LLMGenerateOutput } from "./types.js";

/** Extracts the first JSON value from model text: a ```json fenced block, or the outermost {...} / [...]. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("no JSON value found in model output");
  }
}

export interface StructuredResult<T> {
  value: T;
  outputs: LLMGenerateOutput[];
  attempts: number;
}

/**
 * Strict-JSON generation: the output must parse and validate against `schema`. On failure the model gets
 * `maxRepairAttempts` chances with the validation errors appended (never the original prompt's secrets,
 * which the caller has already excluded).
 */
export async function generateStructured<S extends z.ZodTypeAny>(
  client: LLMClient,
  input: LLMGenerateInput,
  schema: S,
  maxRepairAttempts: number,
): Promise<StructuredResult<z.infer<S>>> {
  const outputs: LLMGenerateOutput[] = [];
  let prompt = input.prompt;
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    const out = await client.generate({ ...input, prompt, responseFormat: "json" });
    outputs.push(out);
    let raw: unknown;
    try {
      raw = extractJson(out.text);
    } catch (e) {
      lastErrors = [(e as Error).message];
      prompt = `${input.prompt}\n\nYour previous output was not valid JSON (${lastErrors[0]}). Respond with JSON only.`;
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { value: parsed.data, outputs, attempts: attempt + 1 };
    lastErrors = formatZodIssues(parsed.error);
    prompt = `${input.prompt}\n\nYour previous output failed schema validation:\n- ${lastErrors.join("\n- ")}\nRespond with corrected JSON only.`;
  }
  throw new BrowserSwarmError(
    "LLM_OUTPUT_INVALID",
    `model output invalid after ${maxRepairAttempts + 1} attempt(s)`,
    {
      errors: lastErrors,
    },
  );
}
