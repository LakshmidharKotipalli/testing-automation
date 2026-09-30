import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApprovedExecutionPlan, recordDecision } from "@browserswarm/approval";
import { McpBrowserSession, type SessionFactory } from "@browserswarm/mcp-browser";
import {
  AgentCheckpointSchema,
  TestPlanSchema,
  type ApprovedExecutionPlan,
  type TestPlan,
} from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { loadHandoff, verifyCheckpoint } from "@browserswarm/handoff";
import { EventStore, FilesystemStorage, RunLayout } from "@browserswarm/storage";
import {
  fixturePlan,
  flowScenario,
  startFixtureServer,
  type FixtureServer,
} from "@browserswarm/test-fixtures";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeApprovedPlan } from "../../src/index.js";

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server?.close();
});

const tmp = (p: string) => mkdtemp(path.join(tmpdir(), `bs-it-${p}-`));

function approve(plan: TestPlan, parallel?: number): ApprovedExecutionPlan {
  const ep = generateExecutionPlan(plan, parallel ? { parallel } : {});
  const record = recordDecision({
    executionPlan: ep,
    plan,
    decision: "approve",
    mode: "noninteractive",
    operator: "vitest",
  });
  return buildApprovedExecutionPlan(ep, record);
}

function scenario(id: string, steps: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    objective: `objective ${id}`,
    priority: "high",
    roles: ["functional"],
    viewports: ["desktop"],
    expectedOutcome: `expected ${id}`,
    steps,
    ...extra,
  };
}

function planWith(scenarios: unknown[], extra: Record<string, unknown> = {}): TestPlan {
  return TestPlanSchema.parse({ ...fixturePlan({ url: server.url }), scenarios, ...extra });
}

describe("approval gate", () => {
  it("starts no browser and makes no request before approval, on rejection, or on tampering", async () => {
    const plan = TestPlanSchema.parse(fixturePlan({ url: server.url }));
    const ep = generateExecutionPlan(plan);
    const sessionFactory = vi.fn<SessionFactory>((options) => new McpBrowserSession(options));
    const before = server.requestCount();
    const out = await tmp("gate");

    await expect(executeApprovedPlan(ep, { outputDir: out, sessionFactory })).rejects.toThrow();
    const rejected = recordDecision({
      executionPlan: ep,
      plan,
      decision: "reject",
      mode: "interactive",
      operator: "me",
    });
    await expect(
      executeApprovedPlan(
        { version: 1, executionPlan: ep, approvalRecord: rejected, approvedPlanHash: ep.executionPlanHash },
        { outputDir: out, sessionFactory },
      ),
    ).rejects.toThrow();

    const approved = approve(plan);
    const tampered = structuredClone(approved);
    tampered.executionPlan.workPackets[0]!.steps[0] = { action: "navigate", url: "/risky" };
    await expect(executeApprovedPlan(tampered, { outputDir: out, sessionFactory })).rejects.toThrow(
      /modified/,
    );

    const edited = TestPlanSchema.parse({
      ...fixturePlan({ url: server.url }),
      name: "Edited after approval",
    });
    await expect(
      executeApprovedPlan(approved, { outputDir: out, sessionFactory, currentPlan: edited }),
    ).rejects.toThrow(/changed after approval/);

    expect(sessionFactory).not.toHaveBeenCalled();
    expect(server.requestCount()).toBe(before);
    expect(await readdir(out)).toEqual([]);
  });
});

describe("browser project matrix", () => {
  it("runs each project as its own packet with separate directories and persistent profiles", async () => {
    const plan = TestPlanSchema.parse({
      ...fixturePlan({ url: server.url }),
      browser: { persistentProfile: true },
      browserProjects: [
        { name: "alpha", channel: "chromium" },
        { name: "beta", channel: "chromium" },
      ],
    });
    const approved = approve(plan, 2);
    const out = await tmp("projects");
    const result = await executeApprovedPlan(approved, { outputDir: out });
    expect(result.report.execution.packetsPassed).toBe(2);
    const ids = approved.executionPlan.workPackets.map((p) => p.packetId).sort();
    expect(ids.map((i) => i.split("-").pop())).toEqual(["alpha", "beta"]);
    for (const id of ids) {
      const dir = path.join(out, "packets", id);
      expect(await readdir(path.join(dir, "mcp-1"))).toContain("profile");
    }
  }, 120000);
});

describe("deterministic parallel execution", () => {
  it("runs a scripted plan with zero LLM calls across 4 concurrent isolated packets", async () => {
    const plan = TestPlanSchema.parse(
      fixturePlan({
        url: server.url,
        roles: ["functional", "accessibility"],
        viewports: ["desktop", "mobile"],
      }),
    );
    const approved = approve(plan, 4);
    const sessionFactory = vi.fn<SessionFactory>((options) => new McpBrowserSession(options));
    const out = await tmp("parallel");
    const result = await executeApprovedPlan(approved, { outputDir: out, sessionFactory });

    expect(result.state).toBe("COMPLETED");
    expect(result.exitCode).toBe(0);
    expect(result.report.execution.llmCalls).toBe(0);
    expect(result.report.execution.llmAssistedOperations).toBe(0);
    expect(result.report.overview.modelsInvoked).toEqual([]);
    expect(result.report.execution.packetsPassed).toBe(4);
    expect(result.report.execution.maxObservedConcurrency).toBe(4);
    expect(sessionFactory).toHaveBeenCalledTimes(4);

    // Only approved packets ran, each with its own artifact directory.
    const approvedIds = approved.executionPlan.workPackets.map((p) => p.packetId).sort();
    expect((await readdir(path.join(out, "packets"))).sort()).toEqual(approvedIds);
    expect(result.report.packets.map((p) => p.packetId).sort()).toEqual(approvedIds);

    const storage = new FilesystemStorage(out);
    for (const id of approvedIds) {
      const layout = RunLayout.packet(id);
      const ledger = (await storage.readText(layout.actions))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(ledger).toHaveLength(9);
      expect(ledger.every((l: { llmInvolved: boolean }) => !l.llmInvolved)).toBe(true);
      const ledgerText = JSON.stringify(ledger);
      expect(ledgerText).not.toContain("InvalidPassword123!");
      expect(ledgerText).toContain("{{testData.invalidPassword}}");
      // A checkpoint after every step, each hash-verified with a matching sidecar.
      for (let seq = 1; seq <= 9; seq++) {
        const cp = verifyCheckpoint(await storage.readJson(layout.checkpoint(seq)));
        expect((await storage.readText(layout.checkpointHash(seq))).trim()).toBe(cp.integrityHash);
        expect(AgentCheckpointSchema.parse(cp).completedStepIndexes).toHaveLength(seq);
      }
      expect(await storage.exists(`packets/${id}/mcp-1/invalid-password-error.png`)).toBe(true);
    }

    const events = await EventStore.read(storage, RunLayout.events);
    const firstStart = events.findIndex((e) => e.type === "packet.started");
    expect(events.findIndex((e) => e.type === "run.approved")).toBeLessThan(firstStart);
    expect(events.filter((e) => e.type === "packet.completed")).toHaveLength(4);
    const run = await storage.readJson<{ stateHistory: { state: string }[] }>(RunLayout.metadata.run);
    expect(run.stateHistory.map((s) => s.state)).toEqual(["APPROVED", "RUNNING", "COMPLETED"]);

    const md = await readFile(path.join(out, RunLayout.reports.markdown), "utf8");
    expect(md).toContain("BrowserSwarm Report: Fixture Smoke Suite");
    expect(md).not.toContain("InvalidPassword123!");
    expect(result.deferredReports).toEqual([]);
  });

  it("keeps simultaneous packets' browser state isolated", async () => {
    const mk = (m: string) =>
      scenario(
        `cookie-${m}`,
        [
          { action: "navigate", url: `/whoami?m=${m}` },
          { action: "click", locator: { role: "button", name: "Set marker" } },
          { action: "assert_text_equals", locator: { role: "status" }, text: `bs_${m}=1` },
          { action: "navigate", url: `/whoami?m=${m}` },
          { action: "assert_text_equals", locator: { role: "status" }, text: `bs_${m}=1` },
        ],
        { viewports: ["desktop", "mobile"] },
      );
    const plan = planWith([mk("alpha"), mk("beta")]);
    const result = await executeApprovedPlan(approve(plan, 4), { outputDir: await tmp("isolation") });
    expect(result.report.packets.map((p) => p.outcome)).toEqual(["passed", "passed", "passed", "passed"]);
  });
});

describe("accessibility steps", () => {
  it("blocks unavailable axe checks and captures the accessible tree", async () => {
    const plan = planWith([
      scenario("a11y-bad", [
        { action: "navigate", url: "/a11y" },
        { action: "inspect_accessibility_tree" },
        { action: "run_accessibility_scan", tags: ["wcag2a", "wcag2aa"] },
      ]),
    ]);
    const out = await tmp("a11y");
    const result = await executeApprovedPlan(approve(plan), { outputDir: out });
    const packet = result.report.packets[0]!;
    expect(packet.stepResults[1]!.status).toBe("passed");
    expect(packet.stepResults[2]!.status).toBe("blocked");
    expect(packet.outcomeReason).toMatch(/unsupported_scripted_check/);
    expect(result.report.findings).toHaveLength(0);
  });
});

describe("failures, evidence and policy at runtime", () => {
  it("captures evidence-backed findings and blocks off-domain navigation", async () => {
    const plan = planWith([
      scenario("wrong-text", [
        { action: "navigate", url: "/" },
        {
          action: "assert_text_contains",
          locator: { role: "heading", name: "Fixture Shop" },
          text: "Welcome back, admin",
          timeoutMs: 500,
        },
        { action: "screenshot", name: "never-reached" },
      ]),
      scenario(
        "console-error",
        [{ action: "navigate", url: "/console-error" }, { action: "assert_no_console_errors" }],
        { priority: "low" },
      ),
      scenario("external-link", [
        { action: "navigate", url: "/external" },
        { action: "click", locator: { role: "link", name: "Partner site" } },
        { action: "assert_visible", locator: { role: "heading" } },
      ]),
      scenario(
        "failed-resource",
        [{ action: "navigate", url: "/failed-resource" }, { action: "assert_no_network_failures" }],
        { priority: "medium" },
      ),
    ]);
    const out = await tmp("failures");
    const result = await executeApprovedPlan(approve(plan), { outputDir: out });
    const byScenario = Object.fromEntries(result.report.packets.map((p) => [p.scenarioId, p]));
    expect(result.exitCode).toBe(1);

    expect(byScenario["wrong-text"]!.outcome).toBe("failed");
    expect(byScenario["wrong-text"]!.stepResults[2]!.status).toBe("skipped");
    const finding = result.report.findings.find((f) => f.scenarioId === "wrong-text")!;
    expect(finding.origin).toBe("deterministic");
    expect(finding.probabilistic).toBe(false);
    expect(finding.verificationStatus).toBe("pending");
    expect(finding.expected).toContain("Welcome back, admin");
    expect(finding.actual).toContain("Fixture Shop");
    const shot = finding.evidence.find((e) => e.type === "screenshot");
    expect(shot?.path).toBeDefined();
    await expect(
      readFile(path.isAbsolute(shot!.path!) ? shot!.path! : path.join(out, shot!.path!)),
    ).resolves.toBeTruthy();
    expect(finding.evidence.some((e) => e.type === "dom")).toBe(true);

    expect(byScenario["console-error"]!.outcome).toBe("failed");
    const ce = result.report.findings.find((f) => f.scenarioId === "console-error")!;
    expect(ce.actual).toContain("Fixture deliberate console error");
    expect(ce.verificationStatus).toBe("not_required");

    expect(byScenario["external-link"]!.outcome).toBe("blocked");
    expect(byScenario["external-link"]!.stepResults[1]!.status).toBe("blocked");
    expect(byScenario["external-link"]!.outcomeReason).toMatch(/scope_exit/);

    expect(byScenario["failed-resource"]!.outcome).toBe("failed");

    const events = await EventStore.read(new FilesystemStorage(out), RunLayout.events);
    expect(events.some((e) => e.type === "policy.blocked")).toBe(true);
    expect(events.filter((e) => e.type === "finding.created").length).toBe(3);
  });

  it("blocks the packet when a checkpoint cannot be persisted", async () => {
    const plan = planWith([
      scenario("home", [
        { action: "navigate", url: "/" },
        { action: "assert_visible", locator: { role: "heading", name: "Fixture Shop" } },
      ]),
    ]);
    const approved = approve(plan);
    const out = await tmp("cpfail");
    const packetId = approved.executionPlan.workPackets[0]!.packetId;
    await mkdir(path.join(out, "packets", packetId), { recursive: true });
    await writeFile(path.join(out, "packets", packetId, "checkpoints"), "not a directory");
    const result = await executeApprovedPlan(approved, { outputDir: out });
    const p = result.report.packets[0]!;
    expect(p.state).toBe("BLOCKED");
    expect(p.outcomeReason).toMatch(/checkpoint persistence failed/);
    expect(result.report.execution.packetsBlockedByCheckpointOrHandoffFailure).toBe(1);
  });
});

describe("context lifecycle with validated MCP restoration", () => {
  it("rotates at the action limit and restores a fresh MCP session from the validated handoff", async () => {
    const flow = flowScenario(6);
    (flow.steps as unknown[])[11] = {
      action: "assert_visible",
      locator: { role: "heading", name: "Flow step 6 of 6" },
    };
    const plan = planWith([flow], {
      contextLifecycle: { maxActionsPerAgentInstance: 4, maxHandoffsPerWorkPacket: 3 },
    });
    const out = await tmp("rotation");
    const result = await executeApprovedPlan(approve(plan), { outputDir: out });
    const p = result.report.packets[0]!;
    expect(p.state).toBe("COMPLETED");
    expect(p.resumeOutcome).toBe("storage_state_restored");
    expect(p.handoffs).toHaveLength(2);
    expect(p.rotationReasons[0]).toMatch(/action count 4 reached limit 4/);
    expect(p.agentInstances[0]!.state).toBe("TERMINATED");
    expect(p.stepResults.filter((s) => s.status === "passed")).toHaveLength(12);
    expect(result.report.execution.handoffCount).toBe(2);

    const storage = new FilesystemStorage(out);
    const handoff = await loadHandoff(storage, p.packetId, 1);
    expect(handoff.continuationInstructions.resumeFromStepIndex).toBe(4);
    expect(handoff.executionProgress.remainingSteps.map((s) => s.index)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(handoff.currentBrowserState.sessionRestorationAvailable).toBe(true);
    const raw = await storage.readText(RunLayout.packet(p.packetId).handoff(1));
    expect(raw).not.toContain("fixture note value");
    expect(raw).not.toContain("InvalidPassword123!");
    expect(raw).not.toMatch(/"cookies"/);
    expect(await storage.exists(RunLayout.packet(p.packetId).handoffMarkdown(1))).toBe(true);

    const events = await EventStore.read(storage, RunLayout.events);
    const types = events.filter((e) => e.packetId === p.packetId).map((e) => e.type);
    const order = [
      "agent.context.limit_reached",
      "packet.handoff.required",
      "packet.checkpoint.created",
      "packet.handoff.validated",
      "packet.handoff.created",
      "agent.terminated",
      "packet.completed",
    ] as const;
    let cursor = -1;
    for (const t of order) {
      const idx = types.indexOf(t, cursor + 1);
      expect(idx, `${t} after index ${cursor}`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("blocks safely when the handoff limit is exhausted", async () => {
    const flow = flowScenario(6);
    (flow.steps as unknown[])[11] = {
      action: "assert_visible",
      locator: { role: "heading", name: "Flow step 6 of 6" },
    };
    const plan = planWith([flow], {
      contextLifecycle: { maxActionsPerAgentInstance: 4, maxHandoffsPerWorkPacket: 0 },
    });
    const result = await executeApprovedPlan(approve(plan), { outputDir: await tmp("limit") });
    const p = result.report.packets[0]!;
    expect(p.state).toBe("BLOCKED");
    expect(p.outcomeReason).toMatch(/handoff_limit_exceeded/);
    expect(result.report.execution.packetsBlockedByHandoffLimit).toBe(1);
    expect(result.report.limitations.join("\n")).toMatch(/context lifecycle interruption/);
  });
});
