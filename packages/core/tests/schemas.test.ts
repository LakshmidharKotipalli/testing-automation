import { fixturePlan } from "@browserswarm/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  AgentCheckpointSchema,
  AgentEventSchema,
  ApprovalRecordSchema,
  computePlanHash,
  ContextPolicySchema,
  FindingSchema,
  HandoffDocumentSchema,
  LocatorSchema,
  STEP_ACTIONS,
  TestPlanSchema,
  TestStepSchema,
} from "../src/index.js";

const base = () => fixturePlan({ url: "https://staging.example.com" });

describe("TestPlan schema", () => {
  it("accepts a valid plan and applies documented defaults", () => {
    const plan = TestPlanSchema.parse(base());
    expect(plan.safety.allowPurchases).toBe(false);
    expect(plan.safety.destructiveActions).toBe("deny");
    expect(plan.contextLifecycle.includeRawDomInHandoff).toBe(false);
    expect(plan.llm.strategy).toBe("disabled");
  });

  it("rejects unknown keys at every level", () => {
    expect(TestPlanSchema.safeParse({ ...base(), surprise: true }).success).toBe(false);
    const p = base() as { target: Record<string, unknown> };
    p.target.extra = 1;
    expect(TestPlanSchema.safeParse(p).success).toBe(false);
    expect(
      TestStepSchema.safeParse({ action: "click", locator: { role: "button" }, force: true }).success,
    ).toBe(false);
    expect(LocatorSchema.safeParse({ role: "button", xpath: "//a" }).success).toBe(false);
  });

  it("accepts only x- prefixed extensions", () => {
    expect(TestPlanSchema.safeParse({ ...base(), extensions: { "x-team": "qa" } }).success).toBe(true);
    expect(TestPlanSchema.safeParse({ ...base(), extensions: { team: "qa" } }).success).toBe(false);
  });

  it("rejects unknown step actions (no arbitrary JavaScript)", () => {
    expect(TestStepSchema.safeParse({ action: "evaluate", script: "alert(1)" }).success).toBe(false);
    expect(STEP_ACTIONS).not.toContain("evaluate");
    expect(STEP_ACTIONS).toHaveLength(33);
  });

  it("requires a locator strategy and role for name", () => {
    expect(LocatorSchema.safeParse({}).success).toBe(false);
    expect(LocatorSchema.safeParse({ name: "Sign in" }).success).toBe(false);
    expect(LocatorSchema.safeParse({ role: "button", name: "Sign in" }).success).toBe(true);
  });

  it("enforces context threshold ordering and literal-false handoff content flags", () => {
    expect(
      ContextPolicySchema.safeParse({
        contextWarningThresholdPercent: 90,
        contextHardStopThresholdPercent: 80,
      }).success,
    ).toBe(false);
    expect(ContextPolicySchema.safeParse({ includeRawDomInHandoff: true }).success).toBe(false);
    expect(ContextPolicySchema.safeParse({ includeScreenshotsInHandoff: true }).success).toBe(false);
  });

  it("test data objects need exactly one of value/fromEnv", () => {
    const p = base() as { testData: Record<string, unknown> };
    p.testData.token = { fromEnv: "QA_TOKEN", secret: true };
    expect(TestPlanSchema.safeParse(p).success).toBe(true);
    p.testData.token = { value: "a", fromEnv: "QA_TOKEN" };
    expect(TestPlanSchema.safeParse(p).success).toBe(false);
  });

  it("plan hash is stable and sensitive to every relevant change", () => {
    const a = TestPlanSchema.parse(base());
    const b = TestPlanSchema.parse(base());
    expect(computePlanHash(a)).toBe(computePlanHash(b));
    const changed = TestPlanSchema.parse({ ...base(), execution: { maxConcurrentAgents: 2 } });
    expect(computePlanHash(changed)).not.toBe(computePlanHash(a));
  });
});

describe("runtime schemas", () => {
  it("findings require evidence", () => {
    const f = {
      findingId: "f1",
      runId: "r",
      packetId: "p",
      scenarioId: "s",
      role: "functional",
      viewportName: "desktop",
      agentInstanceId: "a",
      stepIndex: 0,
      title: "t",
      severity: "high",
      confidence: "high",
      status: "candidate",
      origin: "deterministic",
      probabilistic: false,
      expected: "e",
      actual: "a",
      reproductionSteps: [],
      evidence: [],
      persistedThroughHandoff: false,
      verificationStatus: "pending",
      dedupeKey: "k",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(FindingSchema.safeParse(f).success).toBe(false);
    expect(
      FindingSchema.safeParse({
        ...f,
        evidence: [{ evidenceId: "e", type: "url", summary: "u", createdAt: f.createdAt }],
      }).success,
    ).toBe(true);
  });

  it("strict runtime documents reject unknown keys", () => {
    expect(
      AgentEventSchema.safeParse({
        eventId: "e",
        seq: 1,
        type: "run.started",
        timestamp: "2026-01-01T00:00:00.000Z",
        runId: "r",
        data: {},
        x: 1,
      }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        eventId: "e",
        seq: 1,
        type: "run.exploded",
        timestamp: "2026-01-01T00:00:00.000Z",
        runId: "r",
      }).success,
    ).toBe(false);
    expect(ApprovalRecordSchema.safeParse({}).success).toBe(false);
    expect(AgentCheckpointSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(HandoffDocumentSchema.safeParse({ version: 1, transcript: [] }).success).toBe(false);
  });
});
