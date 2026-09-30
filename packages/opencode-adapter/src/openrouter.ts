import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
  ChatClient,
  ChatInput,
  ChatOutput,
  LLMClient,
  LLMGenerateInput,
  LLMGenerateOutput,
} from "./types.js";
import { estimateTokens } from "./tokens.js";
const ResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function"),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});
export class OpenRouterClient implements ChatClient, LLMClient {
  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl?: string;
      timeoutMs?: number;
      retries?: number;
      fetch?: typeof fetch;
    },
  ) {}
  async chat(input: ChatInput): Promise<ChatOutput> {
    const signal = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(this.options.timeoutMs ?? input.model.timeoutMs ?? 60000),
    ]);
    const base = input.model.baseUrl ?? this.options.baseUrl ?? "https://openrouter.ai/api/v1";
    const messages = input.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls?.length
        ? {
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: "function",
              function: { name: t.name, arguments: t.arguments },
            })),
          }
        : {}),
    }));
    const body = JSON.stringify({
      model: input.model.model,
      messages,
      max_tokens: input.maxTokens,
      ...(input.tools.length
        ? {
            tools: input.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: "auto",
            parallel_tool_calls: false,
            provider: { require_parameters: true },
          }
        : {}),
    });
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await (this.options.fetch ?? fetch)(base.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body,
        signal,
      });
      if ((response.status === 429 || response.status >= 500) && attempt < (this.options.retries ?? 2)) {
        await response.body?.cancel();
        const retry = Number(response.headers.get("retry-after"));
        await delay(Math.min(retry > 0 ? retry * 1000 : 250 * 2 ** attempt, 5000), undefined, { signal });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          response.status === 400 || response.status === 404
            ? "OpenRouter model or native tool calling unsupported (HTTP " + response.status + ")"
            : `OpenRouter HTTP ${response.status}`,
        );
      }
      const parsed = ResponseSchema.parse(await response.json());
      const choice = parsed.choices[0]!;
      const content = choice.message.content ?? "";
      const toolCalls = (choice.message.tool_calls ?? []).map((t) => ({
        id: t.id,
        name: t.function.name,
        arguments: t.function.arguments,
      }));
      const inputTokens = parsed.usage?.prompt_tokens ?? estimateTokens(body).tokens;
      const outputTokens =
        parsed.usage?.completion_tokens ?? estimateTokens(JSON.stringify(choice.message)).tokens;
      return {
        content,
        toolCalls,
        stopReason: choice.finish_reason ?? "unknown",
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: parsed.usage?.total_tokens ?? inputTokens + outputTokens,
          exact: !!parsed.usage,
        },
        cost: parsed.usage?.cost ?? null,
      };
    }
  }
  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    if (!input.model) throw new Error("OpenRouter generate requires model");
    const result = await this.chat({
      messages: [
        ...(input.system ? [{ role: "system" as const, content: input.system }] : []),
        { role: "user", content: input.prompt },
      ],
      tools: [],
      model: input.model,
      maxTokens: input.maxTokens ?? 1500,
      signal: input.signal,
    });
    return { text: result.content, usage: result.usage, model: input.model.model };
  }
}
