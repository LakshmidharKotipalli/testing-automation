import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeHandoffHash,
  HandoffDocumentSchema,
  TestPlanSchema,
  type AgentInstance,
  type BrowserActionResult,
  type ContextUsage,
  type WorkPacket,
} from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { buildTestDataRedactor, resolveTestData } from "@browserswarm/policy-engine";
import { FakeClock, canonicalize } from "@browserswarm/shared";
import { FilesystemStorage, RunLayout } from "@browserswarm/storage";
import { fixturePlan } from "@browserswarm/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  buildResumeContext,
  createCheckpoint,
  DeterministicHandoffWriter,
  estimateHandoffTokens,
  loadCheckpoint,
  loadHandoff,
  persistCheckpoint,
  persistHandoff,
  replacementPreflight,
  verifyCheckpoint,
} from "../src/index.js";

const clock = new FakeClock();
const plan = TestPlanSchema.parse(
  fixturePlan({ url: "https://staging.example.com", contextLifecycle: { maxHandoffsPerWorkPacket: 2 } }),
);
const ep = generateExecutionPlan(plan, { runId: "run-h", clock });
const packet = ep.workPackets[0] as WorkPacket;
const testData = resolveTestData(plan.testData, "run-h");
const redactor = buildTestDataRedactor(testData);

const usage: ContextUsage = {
  agentInstanceId: "agent-001",
  estimatedTotalTokens: 20500,
  contextWindowTokens: 24000,
  contextUtilizationPercent: 85.4,
  messageCount: 14,
  browserActionCount: 3,
  llmCallCount: 0,
  startedAt: clock.iso(),
  updatedAt: clock.iso(),
};

const agent: AgentInstance = {
  agentInstanceId: "agent-001",
  runId: "run-h",
  workPacketId: packet.packetId,
  sequence: 1,
  kind: "scripted",
  state: "CHECKPOINTING",
  model: null,
  startedAt: clock.iso(),
  actionsExecuted: 3,
};

function ledgerEntry(i: number, extra: Partial<BrowserActionResult> = {}): BrowserActionResult {
  return {
    packetId: packet.packetId,
    agentInstanceId: "agent-001",
    actionNumber: i + 1,
    stepIndex: i,
    action: packet.steps[i]!.action,
    actionIntent: `step ${i}`,
    origin: "scripted",
    timestamp: clock.iso(),
    args: {},
    durationMs: 10,
    status: "passed",
    evidence: [],
    llmInvolved: false,
    ...extra,
  };
}

function checkpoint(seq = 1, next = 3) {
  return createCheckpoint({
    sequence: seq,
    runId: "run-h",
    workPacketId: packet.packetId,
    agentInstanceId: "agent-001",
    createdAt: clock.iso(),
    reason: "context_hard_limit",
    immutableWorkPacketHash: packet.workPacketHash,
    approvedExecutionPlanHash: ep.executionPlanHash,
    workPacketState: "CHECKPOINTING",
    completedStepIndexes: [0, 1, 2].filter((i) => i < next),
    currentStepIndex: next,
    remainingStepIndexes: packet.steps.map((_, i) => i).filter((i) => i >= next),
    stepResults: [0, 1, 2]
      .filter((i) => i < next)
      .map((i) => ({
        index: i,
        action: packet.steps[i]!.action,
        status: "passed" as const,
        summary: `done ${i}`,
        evidence: [],
      })),
    currentUrl: "https://staging.example.com/login",
    pageTitle: "Sign in",
    viewport: packet.viewport,
    browserSession: {
      type: "storage-state",
      artifactPath: "browser-state/storage-state.json",
      redactionApplied: true,
    },
    contextUsage: usage,
    actionLedgerReference: "actions.ndjson",
    artifactManifestReference: "artifact-manifest.json",
    findingReferences: [],
    pendingFindingReferences: [],
    handoffDocumentReference: `handoffs/handoff-000${seq}.json`,
  });
}

async function makeHandoff(extraLedger: BrowserActionResult[] = [], seq = 1) {
  const writer = new DeterministicHandoffWriter(redactor, clock);
  const cp = checkpoint(seq);
  const doc = await writer.create(
    {
      workPacket: packet,
      agentInstance: agent,
      checkpoint: cp,
      recentActions: [ledgerEntry(0), ledgerEntry(1), ledgerEntry(2), ...extraLedger],
      findings: [],
      artifacts: { runId: "run-h", packetId: packet.packetId, entries: [] },
    },
    {
      handoffSequence: seq,
      handoffsUsed: seq - 1,
      elapsedMsInPacket: 5000,
      actionsUsedInPacket: 3,
      llmCallsUsedInPacket: 0,
      confirmedFacts: [`Email filled with ${testData.values.validEmail}`, "Sign in heading visible"],
      relevantVisibleStateSummary: `Form shows ${testData.values.invalidPassword}`,
    },
  );
  return { writer, cp, doc };
}

describe("checkpoints", () => {
  it("are hash-protected and persisted atomically with a sidecar", async () => {
    const cp = checkpoint();
    expect(verifyCheckpoint(cp)).toEqual(cp);
    expect(() => verifyCheckpoint({ ...cp, currentStepIndex: 0 })).toThrow(/integrity/);
    const storage = new FilesystemStorage(await mkdtemp(path.join(tmpdir(), "bs-cp-")));
    const rel = await persistCheckpoint(storage, cp);
    expect(rel).toBe(RunLayout.packet(packet.packetId).checkpoint(1));
    expect((await loadCheckpoint(storage, packet.packetId, 1)).integrityHash).toBe(cp.integrityHash);
  });

  it("persistence failures surface as CHECKPOINT_PERSISTENCE_FAILED", async () => {
    // A regular file used as the storage root: every mkdir below it fails with ENOTDIR.
    const dir = await mkdtemp(path.join(tmpdir(), "bs-cp-broken-"));
    const fileRoot = path.join(dir, "not-a-directory");
    await writeFile(fileRoot, "x");
    const broken = new FilesystemStorage(fileRoot);
    await expect(persistCheckpoint(broken, checkpoint())).rejects.toMatchObject({
      code: "CHECKPOINT_PERSISTENCE_FAILED",
    });
  });
});

describe("HandoffWriter", () => {
  it("builds a schema-valid, hash-valid handoff from checkpoint and ledger", async () => {
    const { writer, doc } = await makeHandoff();
    expect(HandoffDocumentSchema.parse(doc)).toBeTruthy();
    expect(writer.validate(doc)).toEqual({ valid: true, errors: [] });
    expect(doc.continuationInstructions.resumeFromStepIndex).toBe(3);
    expect(doc.executionProgress.completedSteps.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(doc.executionProgress.remainingSteps.map((s) => s.index)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(doc.executionProgress.currentStep?.index).toBe(3);
    expect(doc.mission.allowedDomains).toEqual(["staging.example.com"]);
    expect(doc.budgetsRemaining.handoffsRemaining).toBe(2);
    expect(doc.currentBrowserState.sessionRestorationAvailable).toBe(true);
  });

  it("redacts every test value and contains no transcripts, cookies or reasoning", async () => {
    const { doc } = await makeHandoff();
    const text = canonicalize(doc);
    expect(text).not.toContain("InvalidPassword123!");
    expect(text).not.toContain(testData.values.validEmail);
    expect(text).toContain("[REDACTED:testData.invalidPassword]");
    expect(text).not.toMatch(/"cookies"|"transcript"|chain-of-thought/);
  });

  it("validation catches tampering, secrets and raw storage state", async () => {
    const { writer, doc } = await makeHandoff();
    expect(writer.validate({ ...doc, conciseStatusSummary: "changed" }).errors).toContain(
      "integrity hash mismatch",
    );
    const leakBase = { ...doc, conciseStatusSummary: "password InvalidPassword123!" };
    const leak = { ...leakBase, integrityHash: computeHandoffHash(leakBase) };
    expect(writer.validate(leak).errors).toContain("contains an unredacted secret value");
  });

  it("compacts deterministically to the configured size budget", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      ledgerEntry(2, {
        actionNumber: 10 + i,
        status: "failed",
        error: `locator timeout ${"x".repeat(150)} #${i}`,
      }),
    );
    const { doc } = await makeHandoff(many);
    expect(estimateHandoffTokens(doc)).toBeLessThanOrEqual(packet.contextPolicy.handoffMaxTokensEstimate);
    expect(doc.executionProgress.remainingSteps).toHaveLength(6);
    expect(doc.actionHistorySummary.failedActions.length).toBeLessThanOrEqual(8);
  });

  it("renders readable Markdown", async () => {
    const { writer, doc } = await makeHandoff();
    const md = writer.renderMarkdown(doc);
    expect(md).toContain("# Handoff handoff-0001");
    expect(md).toContain("Resume from step **3**");
    expect(md).toContain("### Remaining");
    expect(md).not.toContain("InvalidPassword123!");
  });

  it("persists JSON, Markdown and hash; loading verifies all three", async () => {
    const { doc } = await makeHandoff();
    const storage = new FilesystemStorage(await mkdtemp(path.join(tmpdir(), "bs-ho-")));
    await persistHandoff(storage, doc);
    const layout = RunLayout.packet(packet.packetId);
    expect((await readFile(storage.resolve(layout.handoffHash(1)), "utf8")).trim()).toBe(doc.integrityHash);
    expect(await storage.exists(layout.handoffMarkdown(1))).toBe(true);
    expect((await loadHandoff(storage, packet.packetId, 1)).handoffId).toBe("handoff-0001");
  });
});

describe("replacement preflight and resume context", () => {
  it("passes for a valid chain and yields a bounded, secret-free resume context", async () => {
    const { cp, doc } = await makeHandoff();
    const pre = replacementPreflight({
      packet,
      approvedExecutionPlanHash: ep.executionPlanHash,
      checkpoint: cp,
      handoff: doc,
      handoffsUsed: 0,
      packetTerminal: false,
      redactor,
    });
    expect(pre.ok).toBe(true);
    const { context } = buildResumeContext({
      packet,
      approvedExecutionPlanHash: ep.executionPlanHash,
      checkpoint: cp,
      handoff: doc,
      replacementAgentInstanceId: "agent-002",
      handoffsUsed: 1,
      elapsedMsInPacket: 5000,
      actionsUsedInPacket: 3,
      llmCallsUsedInPacket: 0,
      redactor,
    });
    expect(context.workPacket.workPacketHash).toBe(packet.workPacketHash);
    expect(context.nextStep?.index).toBe(3);
    expect(context.nextStep?.step).toEqual(packet.steps[3]);
    expect(context.handoff.replacementAgentInstanceId).toBe("agent-002");
    expect(context.safetyPolicy).toEqual(packet.safety);
    expect(canonicalize(context)).not.toContain("InvalidPassword123!");
  });

  it("compacts an oversized resume context", async () => {
    const { cp, doc } = await makeHandoff();
    const { context, compacted } = buildResumeContext({
      packet,
      approvedExecutionPlanHash: ep.executionPlanHash,
      checkpoint: cp,
      handoff: doc,
      replacementAgentInstanceId: "agent-002",
      handoffsUsed: 1,
      elapsedMsInPacket: 0,
      actionsUsedInPacket: 3,
      llmCallsUsedInPacket: 0,
      redactor,
      maxTokens: 100,
    });
    expect(compacted).toBe(true);
    expect(context.compacted).toBe(true);
  });

  it("blocks on handoff limit, hash mismatch, invalid checkpoint and terminal packets", async () => {
    const { cp, doc } = await makeHandoff();
    const base = {
      packet,
      approvedExecutionPlanHash: ep.executionPlanHash,
      checkpoint: cp,
      handoff: doc,
      handoffsUsed: 0,
      packetTerminal: false,
      redactor,
    };
    expect(replacementPreflight({ ...base, handoffsUsed: 2 })).toMatchObject({
      ok: false,
      code: "HANDOFF_LIMIT_EXCEEDED",
    });
    expect(
      replacementPreflight({ ...base, approvedExecutionPlanHash: `sha256:${"0".repeat(64)}` }),
    ).toMatchObject({ ok: false, code: "INTEGRITY_MISMATCH" });
    expect(replacementPreflight({ ...base, checkpoint: { ...cp, currentStepIndex: 1 } })).toMatchObject({
      ok: false,
      code: "INTEGRITY_MISMATCH",
    });
    expect(replacementPreflight({ ...base, packetTerminal: true })).toMatchObject({
      ok: false,
      code: "PACKET_TERMINAL",
    });
    const widened = { ...packet, allowedDomains: ["staging.example.com", "evil.example.org"] };
    expect(replacementPreflight({ ...base, packet: widened })).toMatchObject({
      ok: false,
      code: "INTEGRITY_MISMATCH",
    });
  });

  it("refuses a resume context that would broaden scope", async () => {
    const { cp, doc } = await makeHandoff();
    const scopeBase = {
      ...doc,
      mission: { ...doc.mission, allowedDomains: [...doc.mission.allowedDomains, "evil.example.org"] },
    };
    const widened = { ...scopeBase, integrityHash: computeHandoffHash(scopeBase) };
    expect(() =>
      buildResumeContext({
        packet,
        approvedExecutionPlanHash: ep.executionPlanHash,
        checkpoint: cp,
        handoff: widened,
        replacementAgentInstanceId: "agent-002",
        handoffsUsed: 1,
        elapsedMsInPacket: 0,
        actionsUsedInPacket: 3,
        llmCallsUsedInPacket: 0,
        redactor,
      }),
    ).toThrow(/allowed domains/);
  });
});
