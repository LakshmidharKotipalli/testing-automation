import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ContextLifecycleManager } from "@browserswarm/context-lifecycle";
import { ContextPolicySchema } from "@browserswarm/core";
import { compilePrompt, loadPlanFile, validatePlan } from "@browserswarm/plan-compiler";
import { FakeClock } from "@browserswarm/shared";
import { describe, expect, it } from "vitest";
import { verifyHandoff } from "../src/index.js";

const examples = (p: string) => fileURLToPath(new URL(`../../../examples/${p}`, import.meta.url));

describe("shipped examples", () => {
  it.each([
    "login-validation/compiled-plan.yaml",
    "long-running-agent-handoff/compiled-plan.yaml",
    "checkout-safe-validation/compiled-plan.yaml",
  ])("%s is schema- and policy-valid", async (file) => {
    // Explicit env so the test never depends on a developer's local .env.
    const { plan, targetSource } = await loadPlanFile(examples(file), {
      env: { BROWSERSWARM_TARGET_URL: "http://127.0.0.1:4173" },
    });
    expect(targetSource).toBe("env");
    const report = validatePlan(plan);
    expect(report.errors).toEqual([]);
  });

  it.each([
    ["login-validation/testing-request.md", "http://127.0.0.1:4173"],
    ["long-running-agent-handoff/testing-request.md", "http://127.0.0.1:4173"],
    ["checkout-safe-validation/testing-request.md", "https://staging.example.com"],
    ["multi-model/testing-request.md", "https://staging.example.com"],
  ])("%s compiles without dropped steps", async (file, url) => {
    const res = compilePrompt({ promptText: await readFile(examples(file), "utf8"), url });
    expect(res.droppedSteps).toEqual([]);
    expect(validatePlan(res.plan).valid).toBe(true);
  });

  it("the example handoff is schema-valid, integrity-valid and secret-free", async () => {
    const doc = verifyHandoff(
      JSON.parse(await readFile(examples("long-running-agent-handoff/handoff-example.json"), "utf8")),
    );
    expect(doc.continuationInstructions.resumeFromStepIndex).toBe(3);
    expect(JSON.stringify(doc)).not.toContain("InvalidPassword123!");
  });

  it("the mock context-rotation profile produces the documented decisions", async () => {
    const profile = JSON.parse(
      await readFile(examples("long-running-agent-handoff/mock-context-rotation.json"), "utf8"),
    );
    const m = new ContextLifecycleManager(ContextPolicySchema.parse(profile.contextPolicy), {
      agentInstanceId: "agent-001",
      clock: new FakeClock(),
      model: { provider: "mock", model: "mock/model", contextWindowTokens: profile.contextWindowTokens },
    });
    profile.responses.forEach((r: { usage: { inputTokens: number; outputTokens: number } }, i: number) => {
      m.recordLlmCall({
        promptText: "p",
        outputText: "o",
        usage: { ...r.usage, totalTokens: r.usage.inputTokens + r.usage.outputTokens, exact: true },
      });
      const expected = profile.expected[i];
      expect(m.utilizationPercent()).toBe(expected.utilizationPercent);
      const d = m.evaluate();
      expect(d.kind).toBe(expected.decision);
      if (expected.trigger) expect(d).toMatchObject({ trigger: expected.trigger });
    });
  });
});
