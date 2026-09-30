import { z } from "zod";
import { AgentTelemetrySchema, VerdictSchema } from "./agent.js";
import { AgentRoleSchema, IsoDateSchema, Sha256Schema, ViewportSizeSchema } from "./common.js";
import { ContextPolicySchema, ModelRefSchema, SafetyPolicySchema } from "./plan.js";
import {
  AgentInstanceSchema,
  FindingSchema,
  HandoffSummarySchema,
  RunStateSchema,
  StepResultSummarySchema,
  WorkPacketStateSchema,
} from "./runtime.js";

export const PacketOutcomeSchema = z.enum(["passed", "failed", "blocked", "error", "cancelled"]);
export type PacketOutcome = z.infer<typeof PacketOutcomeSchema>;

export const PacketReportSchema = z
  .object({
    packetId: z.string(),
    telemetry: AgentTelemetrySchema.optional(),
    verdict: VerdictSchema.optional(),
    scenarioId: z.string(),
    scenarioTitle: z.string(),
    role: AgentRoleSchema,
    viewportName: z.string(),
    viewport: ViewportSizeSchema,
    model: z.string().nullable(),
    state: WorkPacketStateSchema,
    outcome: PacketOutcomeSchema,
    outcomeReason: z.string().optional(),
    agentInstances: z.array(AgentInstanceSchema),
    actionsCompleted: z.number().int(),
    deterministicActions: z.number().int(),
    llmAssistedActions: z.number().int(),
    checkpoints: z.number().int(),
    handoffs: z.array(HandoffSummarySchema),
    rotationReasons: z.array(z.string()),
    resumeOutcome: z.string(),
    stepResults: z.array(StepResultSummarySchema),
    findingIds: z.array(z.string()),
    artifactDir: z.string(),
    durationMs: z.number().int(),
  })
  .strict();
export type PacketReport = z.infer<typeof PacketReportSchema>;

export const RunReportSchema = z
  .object({
    version: z.literal(1),
    generatedAt: IsoDateSchema,
    overview: z
      .object({
        runId: z.string(),
        planId: z.string(),
        planName: z.string(),
        target: z.string(),
        allowedDomains: z.array(z.string()),
        runState: RunStateSchema,
        planHash: Sha256Schema,
        executionPlanHash: Sha256Schema,
        approval: z
          .object({
            approvalId: z.string(),
            mode: z.string(),
            operator: z.string(),
            decidedAt: IsoDateSchema,
          })
          .strict(),
        modelsConfigured: z.record(z.string(), ModelRefSchema.nullable()),
        modelsInvoked: z.array(z.string()),
        browserMatrix: z.array(z.string()),
        concurrency: z.number().int(),
        safetyPolicy: SafetyPolicySchema,
        contextPolicy: ContextPolicySchema,
        startedAt: IsoDateSchema,
        endedAt: IsoDateSchema,
        durationMs: z.number().int(),
      })
      .strict(),
    execution: z
      .object({
        scenarioCount: z.number().int(),
        packetCount: z.number().int(),
        agentInstanceCount: z.number().int(),
        packetsPassed: z.number().int(),
        packetsFailed: z.number().int(),
        packetsBlocked: z.number().int(),
        packetsErrored: z.number().int(),
        packetsCancelled: z.number().int(),
        deterministicOperations: z.number().int(),
        llmAssistedOperations: z.number().int(),
        totalActions: z.number().int(),
        llmCost: z.number().nullable().optional(),
        usageExact: z.boolean().optional(),
        toolCalls: z.number().int().optional(),
        loopGuardTrips: z.number().int().optional(),
        llmCalls: z.number().int(),
        llmTokens: z.number().int(),
        contextWarnings: z.number().int(),
        checkpointCount: z.number().int(),
        handoffCount: z.number().int(),
        replacementAgentCount: z.number().int(),
        packetsResumedSuccessfully: z.number().int(),
        packetsBlockedByCheckpointOrHandoffFailure: z.number().int(),
        packetsBlockedByHandoffLimit: z.number().int(),
        maxObservedConcurrency: z.number().int(),
      })
      .strict(),
    packets: z.array(PacketReportSchema),
    findings: z.array(FindingSchema),
    limitations: z.array(z.string()),
  })
  .strict();
export type RunReport = z.infer<typeof RunReportSchema>;
