import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalError, IntegrityError, TestPlanSchema, type TestPlan } from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { FilesystemStorage, RunLayout } from "@browserswarm/storage";
import { fixturePlan } from "@browserswarm/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  buildApprovedExecutionPlan,
  createApprovalRequest,
  persistApproval,
  promptForDecision,
  recordDecision,
  riskConfirmationPhrase,
  verifyApprovedPlan,
} from "../src/index.js";

const url = "https://staging.example.com";
const plan = (extra: Record<string, unknown> = {}): TestPlan =>
  TestPlanSchema.parse({ ...fixturePlan({ url }), ...extra });

function approve(p: TestPlan) {
  const ep = generateExecutionPlan(p, { runId: "run-a" });
  const record = recordDecision({
    executionPlan: ep,
    plan: p,
    decision: "approve",
    mode: "noninteractive",
    operator: "ci",
  });
  return { ep, record, approved: buildApprovedExecutionPlan(ep, record) };
}

describe("approval records", () => {
  it("binds the approval to plan and execution-plan hashes", () => {
    const p = plan();
    const { ep, record, approved } = approve(p);
    expect(record.planHash).toBe(ep.planHash);
    expect(record.executionPlanHash).toBe(ep.executionPlanHash);
    expect(verifyApprovedPlan(approved, { currentPlan: p }).executionPlan.runId).toBe("run-a");
    expect(createApprovalRequest(ep).display).toContain("Approve execution of this exact plan?");
  });

  it("persists approval record and immutable approved plan", async () => {
    const { record, approved } = approve(plan());
    const storage = new FilesystemStorage(await mkdtemp(path.join(tmpdir(), "bs-approval-")));
    await persistApproval(storage, record, approved);
    expect(await storage.readJson(RunLayout.metadata.approvalRecord)).toEqual(
      JSON.parse(JSON.stringify(record)),
    );
    expect(verifyApprovedPlan(await storage.readJson(RunLayout.metadata.approvedExecutionPlan))).toBeTruthy();
  });

  it("a rejection cannot be turned into an approved plan", () => {
    const p = plan();
    const ep = generateExecutionPlan(p);
    const rejected = recordDecision({
      executionPlan: ep,
      plan: p,
      decision: "reject",
      mode: "interactive",
      operator: "me",
    });
    expect(() => buildApprovedExecutionPlan(ep, rejected)).toThrow(ApprovalError);
  });

  it.each([
    [
      "target url",
      { target: { url: "https://staging.example.com/app", allowedDomains: ["staging.example.com"] } },
    ],
    ["allowed domains", { target: { url, allowedDomains: ["staging.example.com", "cdn.example.com"] } }],
    ["safety policy", { safety: { allowUploads: true } }],
    ["llm policy", { llm: { strategy: "disabled", maxTokensPerCall: 900 } }],
    ["context policy", { contextLifecycle: { maxHandoffsPerWorkPacket: 1 } }],
    ["concurrency", { execution: { maxConcurrentAgents: 1 } }],
    ["browser config", { browser: { engine: "chromium", headless: false } }],
    ["models", { models: { default: { provider: "opencode-cli", model: "provider/other" } } }],
    ["test data", { testData: { validEmail: "other@example.test", invalidPassword: "x-pass-1", note: "n" } }],
    [
      "viewports",
      { viewports: { desktop: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } } },
    ],
  ])("changing %s invalidates the approval", (_name, change) => {
    const { approved } = approve(plan());
    expect(() => verifyApprovedPlan(approved, { currentPlan: plan(change) })).toThrow(
      /changed after approval/,
    );
  });

  it("changing scenarios, steps or expectations invalidates the approval", () => {
    const { approved } = approve(plan());
    const raw = fixturePlan({ url }) as { scenarios: Record<string, unknown>[] };
    raw.scenarios[0]!.expectedOutcome = "Something else";
    expect(() => verifyApprovedPlan(approved, { currentPlan: TestPlanSchema.parse(raw) })).toThrow(
      ApprovalError,
    );
    const raw2 = fixturePlan({ url }) as { scenarios: { steps: unknown[] }[] };
    raw2.scenarios[0]!.steps.pop();
    expect(() => verifyApprovedPlan(approved, { currentPlan: TestPlanSchema.parse(raw2) })).toThrow(
      ApprovalError,
    );
  });

  it("tampering with any part of the approved file is detected", () => {
    const { approved } = approve(plan());
    const t1 = structuredClone(approved);
    t1.executionPlan.workPackets[0]!.steps.push({ action: "navigate", url: "/admin" });
    expect(() => verifyApprovedPlan(t1)).toThrow(IntegrityError);
    const t2 = structuredClone(approved);
    t2.executionPlan.concurrency.maxConcurrentWorkPackets = 64;
    expect(() => verifyApprovedPlan(t2)).toThrow(IntegrityError);
    const t3 = structuredClone(approved);
    t3.approvalRecord.operator = "someone-else";
    expect(() => verifyApprovedPlan(t3)).toThrow(IntegrityError);
    const t4 = structuredClone(approved) as unknown as Record<string, unknown>;
    t4.extra = true;
    expect(() => verifyApprovedPlan(t4)).toThrow(IntegrityError);
  });

  it("refuses approval when the plan no longer matches the execution plan", () => {
    const ep = generateExecutionPlan(plan());
    expect(() =>
      recordDecision({
        executionPlan: ep,
        plan: plan({ execution: { maxConcurrentAgents: 2 } }),
        decision: "approve",
        mode: "interactive",
        operator: "me",
      }),
    ).toThrow(/changed after the execution plan was generated/);
  });
});

describe("risk approval", () => {
  const risky = () => {
    const raw = fixturePlan({ url, safety: { destructiveActions: "allow-with-approval" } }) as {
      scenarios: { steps: unknown[] }[];
    };
    raw.scenarios[0]!.steps.push({ action: "click", locator: { role: "button", name: "Delete account" } });
    return TestPlanSchema.parse(raw);
  };

  it("requires a separate typed risk approval bound to the risk plan hash", () => {
    const p = risky();
    const ep = generateExecutionPlan(p);
    const base = {
      executionPlan: ep,
      plan: p,
      decision: "approve" as const,
      mode: "noninteractive" as const,
      operator: "ci",
    };
    expect(() => recordDecision(base)).toThrow(/risk approval is required/);
    expect(() =>
      recordDecision({ ...base, riskAcceptance: { accepted: true, riskPlanHash: "sha256:wrong" } }),
    ).toThrow(/does not match/);
    const rec = recordDecision({
      ...base,
      riskAcceptance: { accepted: true, riskPlanHash: ep.riskPlanHash as string },
    });
    expect(rec.riskAccepted).toBe(true);
    expect(verifyApprovedPlan(buildApprovedExecutionPlan(ep, rec)).approvalRecord.riskAccepted).toBe(true);
  });
});

describe("interactive prompt", () => {
  const run = async (answers: string[], ep = generateExecutionPlan(plan())) => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const pending = promptForDecision(ep, { input, output });
    input.end(answers.map((a) => `${a}\n`).join(""));
    return pending;
  };

  it("accepts approve / reject / export / edit and re-asks on junk", async () => {
    expect((await run(["approve"])).decision).toBe("approve");
    expect((await run(["reject"])).decision).toBe("reject");
    expect((await run(["maybe", "export"])).decision).toBe("export");
    expect((await run(["edit"])).decision).toBe("edit");
  });

  it("treats EOF as reject", async () => {
    expect((await run([])).decision).toBe("reject");
  });

  it("risky plans need the typed risk phrase", async () => {
    const raw = fixturePlan({ url, safety: { destructiveActions: "allow-with-approval" } }) as {
      scenarios: { steps: unknown[] }[];
    };
    raw.scenarios[0]!.steps.push({ action: "click", locator: { role: "button", name: "Delete account" } });
    const ep = generateExecutionPlan(TestPlanSchema.parse(raw));
    expect((await run(["approve", "yes"], ep)).decision).toBe("reject");
    const ok = await run(["approve", riskConfirmationPhrase(ep)], ep);
    expect(ok.decision).toBe("approve");
    expect(ok.riskAcceptance?.riskPlanHash).toBe(ep.riskPlanHash);
  });
});
