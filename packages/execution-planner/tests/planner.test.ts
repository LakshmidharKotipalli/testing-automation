import {
  computeExecutionPlanHash,
  computeWorkPacketHash,
  TestPlanSchema,
  ValidationError,
} from "@browserswarm/core";
import { FakeClock } from "@browserswarm/shared";
import { fixturePlan, pricingScenario } from "@browserswarm/test-fixtures";
import { describe, expect, it } from "vitest";
import { generateExecutionPlan, renderExecutionPlanReview } from "../src/index.js";

const url = "https://staging.example.com";

describe("execution plan generation", () => {
  it("expands scenario x role x viewport exactly (2 roles x 2 viewports = 4 packets)", () => {
    const plan = TestPlanSchema.parse(
      fixturePlan({ url, roles: ["functional", "accessibility"], viewports: ["desktop", "mobile"] }),
    );
    const ep = generateExecutionPlan(plan, { runId: "run-test", clock: new FakeClock() });
    expect(ep.workPackets.map((p) => p.packetId)).toEqual([
      "login-invalid-password-functional-desktop",
      "login-invalid-password-functional-mobile",
      "login-invalid-password-accessibility-desktop",
      "login-invalid-password-accessibility-mobile",
    ]);
    expect(ep.summary.workPacketCount).toBe(4);
    expect(new Set(ep.workPackets.map((p) => p.artifactDir)).size).toBe(4);
  });

  it("creates no packets beyond the plan", () => {
    const plan = TestPlanSchema.parse(fixturePlan({ url, extraScenarios: [pricingScenario()] }));
    const ep = generateExecutionPlan(plan);
    expect(ep.workPackets).toHaveLength(2);
    expect(
      ep.workPackets.every((p) =>
        plan.scenarios.some((s) => s.id === p.scenarioId && s.roles.includes(p.role)),
      ),
    ).toBe(true);
  });

  it("packets are immutable, hash-bound and carry exact steps with unresolved templates", () => {
    const plan = TestPlanSchema.parse(fixturePlan({ url }));
    const ep = generateExecutionPlan(plan);
    for (const p of ep.workPackets) {
      expect(computeWorkPacketHash(p)).toBe(p.workPacketHash);
      expect(p.planHash).toBe(ep.planHash);
      expect(p.steps).toEqual(plan.scenarios[0]!.steps);
      expect(JSON.stringify(p)).not.toContain("InvalidPassword123!");
    }
    expect(computeExecutionPlanHash(ep)).toBe(ep.executionPlanHash);
  });

  it("--parallel changes the execution plan hash (and so invalidates approval)", () => {
    const plan = TestPlanSchema.parse(
      fixturePlan({ url, roles: ["functional", "accessibility"], viewports: ["desktop", "mobile"] }),
    );
    const a = generateExecutionPlan(plan, { parallel: 4, runId: "r" });
    const b = generateExecutionPlan(plan, { parallel: 2, runId: "r" });
    expect(a.concurrency.maxConcurrentWorkPackets).toBe(4);
    expect(b.concurrency.maxConcurrentWorkPackets).toBe(2);
    expect(a.executionPlanHash).not.toBe(b.executionPlanHash);
  });

  it("estimates rotations from the per-instance action limit", () => {
    const plan = TestPlanSchema.parse(
      fixturePlan({ url, contextLifecycle: { maxActionsPerAgentInstance: 4, maxHandoffsPerWorkPacket: 3 } }),
    );
    const ep = generateExecutionPlan(plan);
    // 9 steps / 4 per instance => 3 instances => 2 handoffs.
    expect(ep.summary.estimatedContextHandoffs).toBe(2);
    expect(ep.summary.estimatedMaxAgentInstances).toBe(3);
    expect(ep.summary.maxLlmCalls).toBe(0);
  });

  it("refuses invalid plans", () => {
    const raw = fixturePlan({ url }) as { scenarios: { steps: unknown[] }[] };
    raw.scenarios[0]!.steps.push({ action: "click", locator: { role: "button", name: "Delete account" } });
    expect(() => generateExecutionPlan(TestPlanSchema.parse(raw))).toThrow(ValidationError);
  });

  it("flags risky steps for separate approval when policy allows them", () => {
    const raw = fixturePlan({ url, safety: { destructiveActions: "allow-with-approval" } }) as {
      scenarios: { steps: unknown[] }[];
    };
    raw.scenarios[0]!.steps.push({ action: "click", locator: { role: "button", name: "Delete account" } });
    const ep = generateExecutionPlan(TestPlanSchema.parse(raw));
    expect(ep.requiresExplicitRiskApproval).toBe(true);
    expect(ep.riskPlanHash).toMatch(/^sha256:/);
    expect(ep.workPackets[0]!.requiresExplicitRiskApproval).toBe(true);
  });
});

describe("approval review display", () => {
  it("shows every section the user approves", () => {
    const plan = TestPlanSchema.parse(
      fixturePlan({ url, roles: ["functional", "accessibility"], viewports: ["desktop", "mobile"] }),
    );
    const ep = generateExecutionPlan(plan, { parallel: 4 });
    const text = renderExecutionPlanReview(ep);
    for (const needle of [
      "BrowserSwarm Execution Plan Review",
      "Fixture Smoke Suite",
      "Allowed domains:",
      "- staging.example.com",
      "Work packets:",
      "Maximum concurrent browser contexts:",
      "Models:",
      "LLM policy:",
      "Context lifecycle policy:",
      "Maximum handoffs per work packet: 3",
      "Raw conversation transcript persistence: disabled",
      "Estimated execution:",
      "Safety:",
      "Account creation: blocked",
      "Subagent assignments (work packets):",
      "login-invalid-password-accessibility-mobile",
      "Expected outcome:",
      "Test plan hash: sha256:",
      "Execution plan hash: sha256:",
      "Type: approve / reject / export / edit",
    ]) {
      expect(text).toContain(needle);
    }
    expect(text).not.toContain("InvalidPassword123!");
  });
});
