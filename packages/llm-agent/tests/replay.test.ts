import type { Tool } from "@browserswarm/mcp-browser";
import { describe, expect, it } from "vitest";
import { TestPlanSchema } from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { fixturePlan } from "@browserswarm/test-fixtures";
import { replayFingerprint } from "../src/replay.js";

const tools: Tool[] = [
  { name: "browser_click", description: "", inputSchema: { type: "object", properties: {} } },
];
const build = (over: Record<string, unknown> = {}, runId = "run-a") =>
  generateExecutionPlan(
    TestPlanSchema.parse({
      ...fixturePlan({ url: "https://staging.example.com" }),
      mode: "agentic",
      models: { default: { provider: "mock", model: "m1" } },
      replay: { enabled: true },
      verification: { enabled: true },
      ...over,
    }),
    { runId },
  );

describe("replay fingerprint", () => {
  const fp = (ep = build(), t = tools) => replayFingerprint(ep.workPackets[0]!, t, ["user"]);
  it("ignores run identity but tracks semantics", () => {
    expect(fp(build({}, "run-a"))).toBe(fp(build({}, "run-b")));
    expect(fp(build({ models: { default: { provider: "mock", model: "m2" } } }))).not.toBe(fp());
    expect(fp(build({ browser: { headless: false } }))).not.toBe(fp());
    expect(fp(build({ agent: { maxToolCalls: 10 } }))).not.toBe(fp());
    expect(
      fp(undefined, [{ ...tools[0]!, inputSchema: { type: "object", properties: { a: {} } } }]),
    ).not.toBe(fp());
  });
  it("is enabled on primaries only, never on reserved verifiers", () => {
    const ep = build();
    expect(ep.workPackets[0]!.replay?.enabled).toBe(true);
    expect(ep.verifierPackets![0]!.replay).toBeUndefined();
  });
  it("is absent unless the plan opts in", () => {
    expect(build({ replay: undefined }).workPackets[0]!.replay).toBeUndefined();
  });
});
