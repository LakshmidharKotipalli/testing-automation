import { buildApprovedExecutionPlan, recordDecision } from "@browserswarm/approval";
import { TestPlanSchema, type Finding, type PacketReport } from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { fixturePlan } from "@browserswarm/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildRunReport, renderMarkdownReport } from "../src/index.js";

const plan = TestPlanSchema.parse(fixturePlan({ url: "https://staging.example.com" }));
const ep = generateExecutionPlan(plan, { runId: "run-r" });
const record = recordDecision({
  executionPlan: ep,
  plan,
  decision: "approve",
  mode: "interactive",
  operator: "qa",
});
buildApprovedExecutionPlan(ep, record);
const at = "2026-01-01T00:00:00.000Z";
const packet = ep.workPackets[0]!;

const packetReport: PacketReport = {
  packetId: packet.packetId,
  scenarioId: packet.scenarioId,
  scenarioTitle: packet.scenarioTitle,
  role: packet.role,
  viewportName: packet.viewportName,
  viewport: packet.viewport,
  model: null,
  state: "BLOCKED",
  outcome: "blocked",
  outcomeReason: "replacement_agent_unavailable",
  agentInstances: [
    {
      agentInstanceId: "agent-001-aa",
      runId: "run-r",
      workPacketId: packet.packetId,
      sequence: 1,
      kind: "scripted",
      state: "TERMINATED",
      model: null,
      startedAt: at,
      endedAt: at,
      terminationReason: "agent-instance action count 4 reached limit 4",
      actionsExecuted: 4,
    },
  ],
  actionsCompleted: 4,
  deterministicActions: 4,
  llmAssistedActions: 0,
  checkpoints: 5,
  handoffs: [
    {
      handoffId: "handoff-0001",
      workPacketId: packet.packetId,
      previousAgentInstanceId: "agent-001-aa",
      triggerReason: "action_limit",
      progressAtHandoff: { completed: 4, total: 9 },
      remainingStepIndexes: [4, 5, 6, 7, 8],
      restorationOutcome: "blocked",
      integrityValid: true,
      path: "handoffs/handoff-0001.json",
    },
  ],
  rotationReasons: ["agent-001-aa: agent-instance action count 4 reached limit 4"],
  resumeOutcome: "blocked: replacement_agent_unavailable",
  stepResults: packet.steps.map((s, i) => ({
    index: i,
    action: s.action,
    status: i < 4 ? "passed" : "skipped",
    summary: i < 4 ? "ok" : "Not executed: replacement_agent_unavailable",
    evidence: [],
  })),
  findingIds: ["finding-1"],
  artifactDir: packet.artifactDir,
  durationMs: 1234,
};

const finding: Finding = {
  findingId: "finding-1",
  runId: "run-r",
  packetId: packet.packetId,
  scenarioId: packet.scenarioId,
  role: "functional",
  viewportName: "desktop",
  agentInstanceId: "agent-001-aa",
  stepIndex: 3,
  title: "Alert missing",
  severity: "high",
  confidence: "high",
  status: "candidate",
  origin: "deterministic",
  probabilistic: false,
  expected: "alert visible",
  actual: "no alert",
  reproductionSteps: ["0. Navigate to /login"],
  evidence: [
    {
      evidenceId: "e1",
      type: "screenshot",
      path: "packets/x/screenshots/a.png",
      summary: "Screenshot at failure",
      createdAt: at,
    },
  ],
  persistedThroughHandoff: false,
  verificationStatus: "pending",
  dedupeKey: "k",
  createdAt: at,
};

describe("run report", () => {
  const report = buildRunReport({
    executionPlan: ep,
    approvalRecord: record,
    runState: "COMPLETED",
    packets: [packetReport],
    findings: [finding],
    startedAt: at,
    endedAt: "2026-01-01T00:00:05.000Z",
    generatedAt: at,
    contextWarnings: 1,
    checkpointCount: 5,
    llmCalls: 0,
    llmTokens: 0,
    modelsInvoked: [],
    maxObservedConcurrency: 1,
    packetsBlockedByHandoffLimit: 0,
    packetsBlockedByCheckpointFailure: 0,
  });

  it("aggregates lifecycle, checkpoint and handoff metrics", () => {
    expect(report.execution.handoffCount).toBe(1);
    expect(report.execution.checkpointCount).toBe(5);
    expect(report.execution.contextWarnings).toBe(1);
    expect(report.execution.packetsBlocked).toBe(1);
    expect(report.execution.deterministicOperations).toBe(4);
    expect(report.overview.durationMs).toBe(5000);
    expect(report.limitations.join("\n")).toMatch(/context lifecycle interruption/);
    expect(report.limitations.join("\n")).toMatch(/not tested by design/);
  });

  it("renders Markdown with agent sequence, handoffs and labeled findings", () => {
    const md = renderMarkdownReport(report);
    expect(md).toContain("## Execution overview");
    expect(md).toContain("#### Handoff handoff-0001");
    expect(md).toContain("Trigger: action_limit; progress 4/9");
    expect(md).toContain("agent-001-aa [TERMINATED");
    expect(md).toContain("deterministic, evidence-backed");
    expect(md).toContain("none (zero LLM calls)");
  });

  it("labels AI-originated findings as probabilistic", () => {
    const ai = {
      ...finding,
      findingId: "f2",
      origin: "llm-assisted" as const,
      probabilistic: true,
      confidence: "medium" as const,
    };
    const md = renderMarkdownReport({ ...report, findings: [ai] });
    expect(md).toContain("probabilistic, AI-generated claim");
  });
});
