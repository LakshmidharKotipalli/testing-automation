import { it, expect } from "vitest";
import { OpenRouterClient } from "../src/openrouter.js";
const input = {
  messages: [{ role: "user" as const, content: "test" }],
  tools: [{ name: "browser_snapshot", inputSchema: { type: "object" } }],
  model: { provider: "openrouter" as const, model: "provider/model" },
  maxTokens: 100,
};
it("preserves tool calls, usage and response cost after 429 retry", async () => {
  let n = 0;
  const client = new OpenRouterClient({
    apiKey: "secret",
    fetch: async (_url, init) => {
      expect(JSON.parse(String(init?.body)).provider.require_parameters).toBe(true);
      return ++n === 1
        ? new Response("", { status: 429 })
        : Response.json({
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "1", type: "function", function: { name: "browser_snapshot", arguments: "{}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.001 },
          });
    },
  });
  const out = await client.chat(input);
  expect(out.toolCalls[0]?.name).toBe("browser_snapshot");
  expect(out.usage).toMatchObject({ totalTokens: 16, exact: true });
  expect(out.cost).toBe(0.001);
  expect(n).toBe(2);
});
it("rejects malformed output without fabricating success", async () => {
  const client = new OpenRouterClient({
    apiKey: "secret",
    fetch: async () => Response.json({ choices: [] }),
  });
  await expect(client.chat(input)).rejects.toThrow();
});
it("aborts before making a request", async () => {
  const c = new AbortController();
  c.abort();
  const client = new OpenRouterClient({
    apiKey: "secret",
    fetch: async () => {
      throw new Error("should not call");
    },
  });
  await expect(client.chat({ ...input, signal: c.signal })).rejects.toThrow();
});
