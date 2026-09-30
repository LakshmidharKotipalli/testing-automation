import { it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TestPlanSchema } from "@browserswarm/core";
import { startFixtureServer, fixturePlan } from "@browserswarm/test-fixtures";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { recordDecision, buildApprovedExecutionPlan } from "@browserswarm/approval";
import type { ChatClient, ChatInput, ChatOutput } from "@browserswarm/opencode-adapter";
import { executeApprovedPlan } from "../../src/index.js";
const response = (name: string, args: unknown): ChatOutput => ({
  content: "",
  toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }],
  usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70, exact: true },
  cost: 0,
  stopReason: "tool_calls",
});
class RecordedLogin implements ChatClient {
  async chat(input: ChatInput): Promise<ChatOutput> {
    const last = input.messages.filter((m) => m.role === "tool").at(-1)?.content ?? "";
    const calls = input.messages.flatMap((m) => m.toolCalls ?? []);
    const mission = JSON.parse(input.messages[1]!.content).mission;
    if (!calls.length) return response("browser_navigate", { url: "/login" });
    const target = (label: string) => {
      const line = last.split("\n").find((l) => l.includes(`"${label}"`) && l.includes("[ref="));
      if (!line) throw new Error("Missing target " + label + " in " + last);
      return line.match(/\[ref=([^\]]+)\]/)![1];
    };
    if (calls.length === 1)
      return response("browser_type", { ref: target("Email"), element: "Email", text: "qa@example.test" });
    if (calls.length === 2)
      return response("browser_type", { ref: target("Password"), element: "Password", text: "invalid" });
    if (calls.length === 3) {
      const line = last.split("\n").find((l) => l.includes('button "Sign in"'))!;
      return response("browser_click", { ref: line.match(/\[ref=([^\]]+)\]/)![1], element: "Sign in" });
    }
    expect(last).toContain("Invalid email or password");
    return response("report_verdict", {
      status: "pass",
      summary: "Invalid login was rejected",
      outcomes: [
        {
          expectedOutcome: mission.expectedOutcome,
          met: true,
          evidence: [last.match(/Evidence ID: (\S+)/)![1]],
        },
      ],
    });
  }
}
it("executes parallel login packets with recorded model calls through real MCP", async () => {
  const server = await startFixtureServer();
  try {
    const original = TestPlanSchema.parse(fixturePlan({ url: server.url }));
    const plan = TestPlanSchema.parse({
      ...original,
      mode: "agentic",
      models: { default: { provider: "mock", model: "recorded-login" } },
      contextLifecycle: { checkpointAfterEveryStep: false },
      scenarios: [{ ...original.scenarios[0], viewports: ["desktop", "mobile"] }],
    });
    const ep = generateExecutionPlan(plan);
    const approval = buildApprovedExecutionPlan(
      ep,
      recordDecision({
        executionPlan: ep,
        plan,
        decision: "approve",
        mode: "noninteractive",
        operator: "test",
      }),
    );
    const result = await executeApprovedPlan(approval, {
      outputDir: await mkdtemp(path.join(os.tmpdir(), "bs-agentic-")),
      modelClient: new RecordedLogin(),
    });
    expect(result.report.packets.map((p) => ({ outcome: p.outcome, reason: p.outcomeReason }))).toEqual([
      { outcome: "passed", reason: undefined },
      { outcome: "passed", reason: undefined },
    ]);
    expect(result.report.execution.llmCalls).toBe(10);
    expect(result.report.packets.every((p) => p.verdict?.status === "pass")).toBe(true);
  } finally {
    await server.close();
  }
}, 90000);
