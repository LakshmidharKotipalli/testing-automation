import {
  RunReportSchema,
  type ApprovalRecord,
  type ExecutionPlan,
  type Finding,
  type PacketReport,
  type RunReport,
  type RunState,
} from "@browserswarm/core";

export interface BuildReportInput {
  executionPlan: ExecutionPlan;
  approvalRecord: ApprovalRecord;
  runState: RunState;
  packets: PacketReport[];
  findings: Finding[];
  startedAt: string;
  endedAt: string;
  generatedAt: string;
  contextWarnings: number;
  checkpointCount: number;
  llmCalls: number;
  llmTokens: number;
  modelsInvoked: string[];
  maxObservedConcurrency: number;
  packetsBlockedByHandoffLimit: number;
  packetsBlockedByCheckpointFailure: number;
  extraLimitations?: string[];
}

export function buildRunReport(input: BuildReportInput): RunReport {
  const ep = input.executionPlan;
  const packets = input.packets;
  const count = (outcome: PacketReport["outcome"]) => packets.filter((p) => p.outcome === outcome).length;
  const handoffs = packets.flatMap((p) => p.handoffs);
  const replacements = packets.reduce((n, p) => n + Math.max(0, p.agentInstances.length - 1), 0);
  const limitations: string[] = [...ep.limitations, ...(input.extraLimitations ?? [])];
  for (const p of packets) {
    const skipped = p.stepResults.filter((s) => s.status === "skipped");
    if (skipped.length) {
      limitations.push(
        `${p.packetId}: ${skipped.length} step(s) not executed (${[...new Set(skipped.map((s) => s.summary))].join("; ")})`,
      );
    }
    const blocked = p.stepResults.filter((s) => s.status === "blocked");
    for (const b of blocked)
      limitations.push(`${p.packetId}: step ${b.index} blocked: ${b.error ?? b.summary}`);
    if (p.rotationReasons.length)
      limitations.push(`${p.packetId}: context lifecycle interruption(s): ${p.rotationReasons.join("; ")}`);
  }
  limitations.push("Routes, roles and viewports not listed in the approved plan were not tested by design.");
  const startedMs = Date.parse(input.startedAt);
  const endedMs = Date.parse(input.endedAt);

  const report: RunReport = {
    version: 1,
    generatedAt: input.generatedAt,
    overview: {
      runId: ep.runId,
      planId: ep.planId,
      planName: ep.planName,
      target: ep.target.url,
      allowedDomains: ep.target.allowedDomains,
      runState: input.runState,
      planHash: ep.planHash,
      executionPlanHash: ep.executionPlanHash,
      approval: {
        approvalId: input.approvalRecord.approvalId,
        mode: input.approvalRecord.mode,
        operator: input.approvalRecord.operator,
        decidedAt: input.approvalRecord.decidedAt,
      },
      modelsConfigured: ep.models,
      modelsInvoked: input.modelsInvoked,
      browserMatrix: ep.summary.browserMatrix.map(
        (b) =>
          `${b.engine}${b.project ? ` [${b.project}]` : ""} ${b.viewportName} ${b.viewport.width}x${b.viewport.height}`,
      ),
      concurrency: ep.concurrency.maxConcurrentWorkPackets,
      safetyPolicy: ep.safety,
      contextPolicy: ep.contextLifecycle,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: Math.max(0, endedMs - startedMs),
    },
    execution: {
      scenarioCount: ep.summary.scenarioCount,
      packetCount: packets.length,
      agentInstanceCount: packets.reduce((n, p) => n + p.agentInstances.length, 0),
      packetsPassed: count("passed"),
      packetsFailed: count("failed"),
      packetsBlocked: count("blocked"),
      packetsErrored: count("error"),
      packetsCancelled: count("cancelled"),
      deterministicOperations: packets.reduce((n, p) => n + p.deterministicActions, 0),
      llmAssistedOperations: packets.reduce((n, p) => n + p.llmAssistedActions, 0),
      totalActions: packets.reduce((n, p) => n + p.deterministicActions + p.llmAssistedActions, 0),
      llmCost: packets.some((p) => p.telemetry?.cost === null)
        ? null
        : packets.reduce((n, p) => n + (p.telemetry?.cost ?? 0), 0),
      usageExact: packets.every((p) => p.telemetry?.usageExact !== false),
      toolCalls: packets.reduce((n, p) => n + (p.telemetry?.toolCalls ?? 0), 0),
      loopGuardTrips: packets.reduce((n, p) => n + (p.telemetry?.loopGuardTrips ?? 0), 0),
      llmCalls: input.llmCalls,
      llmTokens: input.llmTokens,
      contextWarnings: input.contextWarnings,
      checkpointCount: input.checkpointCount,
      handoffCount: handoffs.length,
      replacementAgentCount: replacements,
      packetsResumedSuccessfully: packets.filter(
        (p) => p.resumeOutcome.startsWith("resumed") || p.resumeOutcome === "storage_state_restored",
      ).length,
      packetsBlockedByCheckpointOrHandoffFailure: input.packetsBlockedByCheckpointFailure,
      packetsBlockedByHandoffLimit: input.packetsBlockedByHandoffLimit,
      maxObservedConcurrency: input.maxObservedConcurrency,
    },
    packets,
    findings: input.findings,
    limitations,
  };
  return RunReportSchema.parse(report);
}
