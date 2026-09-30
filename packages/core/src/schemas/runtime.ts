import { z } from "zod";
import { AgentTelemetrySchema, VerdictSchema } from "./agent.js";

const AgentProgressSchema = z
  .object({
    telemetry: AgentTelemetrySchema,
    evidenceIds: z.array(z.string()),
    remainingToolCalls: z.number().int().nonnegative(),
    remainingTokens: z.number().int().nonnegative(),
    verdict: VerdictSchema.optional(),
  })
  .strict();
import {
  AgentRoleSchema,
  IsoDateSchema,
  RunPhaseSchema,
  Sha256Schema,
  SeveritySchema,
  ViewportSizeSchema,
} from "./common.js";
import { LocatorSchema, TestStepSchema } from "./steps.js";
import { ModelRefSchema } from "./plan.js";

export const RunStateSchema = z.enum([
  "DRAFT",
  "DISCOVERY_PLANNED",
  "DISCOVERY_RUNNING",
  "DISCOVERY_COMPLETED",
  "WEBSITE_PROFILE_GENERATED",
  "TEST_PLAN_GENERATED",
  "COMPILED",
  "VALIDATED",
  "EXECUTION_PLAN_GENERATED",
  "PENDING_APPROVAL",
  "APPROVED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const WorkPacketStateSchema = z.enum([
  "PENDING",
  "QUEUED",
  "RUNNING",
  "CHECKPOINTING",
  "HANDOFF_PENDING",
  "RESUMING",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
]);
export type WorkPacketState = z.infer<typeof WorkPacketStateSchema>;

export const AgentInstanceStateSchema = z.enum([
  "CREATED",
  "STARTING",
  "ACTIVE",
  "CONTEXT_WARNING",
  "CHECKPOINTING",
  "TERMINATED",
  "REPLACED",
]);
export type AgentInstanceState = z.infer<typeof AgentInstanceStateSchema>;

export const HandoffStateSchema = z.enum([
  "NOT_REQUIRED",
  "REQUIRED",
  "WRITING",
  "VALIDATED",
  "PERSISTED",
  "CONSUMED",
  "COMPLETED",
]);
export type HandoffState = z.infer<typeof HandoffStateSchema>;

export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    exact: z.boolean(),
  })
  .strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ContextUsageSchema = z
  .object({
    agentInstanceId: z.string(),
    model: ModelRefSchema.optional(),
    exactInputTokens: z.number().int().min(0).optional(),
    exactOutputTokens: z.number().int().min(0).optional(),
    estimatedInputTokens: z.number().int().min(0).optional(),
    estimatedOutputTokens: z.number().int().min(0).optional(),
    estimatedTotalTokens: z.number().int().min(0),
    contextWindowTokens: z.number().int().min(0).optional(),
    contextUtilizationPercent: z.number().min(0).optional(),
    messageCount: z.number().int().min(0),
    browserActionCount: z.number().int().min(0),
    llmCallCount: z.number().int().min(0),
    startedAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  })
  .strict();
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const ContextEstimateSchema = z
  .object({
    tokens: z.number().int().min(0),
    method: z.enum(["exact", "chars-per-token"]),
    charCount: z.number().int().min(0),
  })
  .strict();
export type ContextEstimate = z.infer<typeof ContextEstimateSchema>;

export const LifecycleTriggerSchema = z.enum([
  "context_warning",
  "context_hard_limit",
  "input_token_budget",
  "output_token_budget",
  "total_token_budget",
  "message_limit",
  "action_limit",
  "duration_limit",
  "fallback_limit",
  "model_error",
  "manual",
]);
export type LifecycleTrigger = z.infer<typeof LifecycleTriggerSchema>;

export const ContextWarningSchema = z
  .object({
    agentInstanceId: z.string(),
    trigger: LifecycleTriggerSchema,
    utilizationPercent: z.number().optional(),
    thresholdPercent: z.number().optional(),
    message: z.string(),
    at: IsoDateSchema,
  })
  .strict();
export type ContextWarning = z.infer<typeof ContextWarningSchema>;

export const EvidenceSchema = z
  .object({
    evidenceId: z.string(),
    type: z.enum(["screenshot", "dom", "console", "network", "trace", "url", "note", "ledger"]),
    path: z.string().optional(),
    summary: z.string().max(4000),
    createdAt: IsoDateSchema,
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const StepStatusSchema = z.enum(["passed", "failed", "skipped", "blocked", "not_started"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/** A requested browser action: the typed step plus its origin. The only thing an agent may ask to execute. */
export const BrowserActionSchema = z
  .object({
    stepIndex: z.number().int().min(0),
    step: TestStepSchema,
    actionIntent: z.string().max(300),
    origin: z.enum(["scripted", "llm-fallback", "replay"]),
  })
  .strict();
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

/** One line of the per-packet action ledger (actions.ndjson). */
export const BrowserActionResultSchema = z
  .object({
    packetId: z.string(),
    agentInstanceId: z.string(),
    actionNumber: z.number().int().min(1),
    stepIndex: z.number().int().min(0),
    action: z.string(),
    actionIntent: z.string().max(300),
    origin: z.enum(["scripted", "llm-fallback", "replay"]),
    timestamp: IsoDateSchema,
    args: z.record(z.string(), z.unknown()),
    locator: LocatorSchema.optional(),
    url: z.string().optional(),
    durationMs: z.number().min(0),
    status: z.enum(["passed", "failed", "skipped", "blocked"]),
    evidence: z.array(z.string()),
    llmInvolved: z.boolean(),
    error: z.string().max(2000).optional(),
    skipReason: z.string().optional(),
  })
  .strict();
export type BrowserActionResult = z.infer<typeof BrowserActionResultSchema>;

export const StepResultSummarySchema = z
  .object({
    index: z.number().int().min(0),
    action: z.string(),
    status: StepStatusSchema,
    summary: z.string().max(500),
    durationMs: z.number().min(0).optional(),
    evidence: z.array(z.string()).default([]),
    error: z.string().max(2000).optional(),
    agentInstanceId: z.string().optional(),
    replayed: z.boolean().optional(),
  })
  .strict();
export type StepResultSummary = z.infer<typeof StepResultSummarySchema>;

export const FindingSchema = z
  .object({
    findingId: z.string(),
    runId: z.string(),
    packetId: z.string(),
    scenarioId: z.string(),
    role: AgentRoleSchema,
    viewportName: z.string(),
    agentInstanceId: z.string(),
    stepIndex: z.number().int().min(0),
    title: z.string().max(300),
    severity: SeveritySchema,
    confidence: z.enum(["high", "medium", "low"]),
    status: z.enum(["candidate", "confirmed", "likely", "unverified", "rejected"]),
    origin: z.enum(["deterministic", "llm-assisted", "verifier"]),
    probabilistic: z.boolean(),
    expected: z.string().max(1000),
    actual: z.string().max(2000),
    reproductionSteps: z.array(z.string()),
    evidence: z.array(EvidenceSchema).min(1, "every finding requires evidence"),
    persistedThroughHandoff: z.boolean(),
    verificationStatus: z.enum(["not_required", "pending", "confirmed", "likely", "unverified", "rejected"]),
    dedupeKey: z.string(),
    createdAt: IsoDateSchema,
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const VerificationResultSchema = z
  .object({
    verificationId: z.string(),
    findingId: z.string(),
    verifierPacketId: z.string(),
    status: z.enum(["confirmed", "likely", "unverified", "rejected"]),
    evidence: z.array(EvidenceSchema),
    notes: z.string().max(2000),
    completedAt: IsoDateSchema,
  })
  .strict();
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const AgentInstanceSchema = z
  .object({
    agentInstanceId: z.string(),
    runId: z.string(),
    workPacketId: z.string(),
    sequence: z.number().int().min(1),
    kind: z.enum(["scripted", "llm"]),
    state: AgentInstanceStateSchema,
    model: ModelRefSchema.nullable(),
    startedAt: IsoDateSchema,
    endedAt: IsoDateSchema.optional(),
    terminationReason: z.string().optional(),
    previousAgentInstanceId: z.string().optional(),
    sourceHandoffId: z.string().optional(),
    actionsExecuted: z.number().int().min(0),
  })
  .strict();
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;

export const CheckpointReasonSchema = z.enum([
  "step_completed",
  "context_warning",
  "context_hard_limit",
  "duration_limit",
  "action_limit",
  "model_error",
  "manual",
  "before_risky_action",
  "graceful_shutdown",
]);
export type CheckpointReason = z.infer<typeof CheckpointReasonSchema>;

export const AgentCheckpointSchema = z
  .object({
    version: z.literal(1),
    checkpointId: z.string(),
    sequence: z.number().int().min(1),
    runId: z.string(),
    workPacketId: z.string(),
    agentInstanceId: z.string(),
    createdAt: IsoDateSchema,
    reason: CheckpointReasonSchema,
    immutableWorkPacketHash: Sha256Schema,
    approvedExecutionPlanHash: Sha256Schema,
    workPacketState: WorkPacketStateSchema,
    completedStepIndexes: z.array(z.number().int().min(0)),
    currentStepIndex: z.number().int().min(0),
    remainingStepIndexes: z.array(z.number().int().min(0)),
    stepResults: z.array(StepResultSummarySchema),
    currentUrl: z.string().optional(),
    pageTitle: z.string().optional(),
    viewport: ViewportSizeSchema,
    browserSession: z.discriminatedUnion("type", [
      z
        .object({ type: z.literal("storage-state"), artifactPath: z.string(), redactionApplied: z.boolean() })
        .strict(),
      z.object({ type: z.literal("none") }).strict(),
    ]),
    contextUsage: ContextUsageSchema,
    agentProgress: AgentProgressSchema.optional(),
    actionLedgerReference: z.string(),
    artifactManifestReference: z.string(),
    findingReferences: z.array(z.string()),
    pendingFindingReferences: z.array(z.string()),
    handoffDocumentReference: z.string(),
    integrityHash: Sha256Schema,
  })
  .strict();
export type AgentCheckpoint = z.infer<typeof AgentCheckpointSchema>;

export const HandoffStepSummarySchema = z
  .object({
    index: z.number().int().min(0),
    action: z.string(),
    status: StepStatusSchema,
    summary: z.string().max(400),
  })
  .strict();
export type HandoffStepSummary = z.infer<typeof HandoffStepSummarySchema>;

export const HandoffActionSummarySchema = z
  .object({
    action: z.string(),
    status: z.enum(["passed", "failed", "skipped", "blocked"]),
    summary: z.string().max(300),
    stepIndex: z.number().int().min(0).optional(),
  })
  .strict();
export type HandoffActionSummary = z.infer<typeof HandoffActionSummarySchema>;

export const HandoffDocumentSchema = z
  .object({
    version: z.literal(1),
    handoffId: z.string(),
    runId: z.string(),
    workPacketId: z.string(),
    previousAgentInstanceId: z.string(),
    replacementAgentInstanceId: z.string().optional(),
    createdAt: IsoDateSchema,
    immutableWorkPacketHash: Sha256Schema,
    approvedExecutionPlanHash: Sha256Schema,
    sourceCheckpointId: z.string(),
    mission: z
      .object({
        scenarioId: z.string(),
        scenarioTitle: z.string(),
        role: AgentRoleSchema,
        objective: z.string(),
        expectedOutcome: z.string().optional(),
        allowedDomains: z.array(z.string()).min(1),
        safetySummary: z.array(z.string()),
      })
      .strict(),
    executionProgress: z
      .object({
        status: z.enum(["in_progress", "completed", "blocked", "failed", "awaiting_verification"]),
        completedSteps: z.array(HandoffStepSummarySchema),
        currentStep: HandoffStepSummarySchema.optional(),
        remainingSteps: z.array(HandoffStepSummarySchema),
        skippedSteps: z.array(HandoffStepSummarySchema),
      })
      .strict(),
    currentBrowserState: z
      .object({
        currentUrl: z.string().optional(),
        pageTitle: z.string().optional(),
        viewport: ViewportSizeSchema,
        sessionRestorationAvailable: z.boolean(),
        storageStateArtifact: z.string().optional(),
        relevantVisibleStateSummary: z.string().max(500).optional(),
      })
      .strict(),
    importantObservations: z
      .object({
        confirmedFacts: z.array(z.string().max(300)),
        relevantElementLocators: z.array(LocatorSchema),
        consoleOrNetworkObservations: z.array(z.string().max(300)),
        accessibilityObservations: z.array(z.string().max(300)),
        unresolvedAmbiguities: z.array(z.string().max(300)),
      })
      .strict(),
    findings: z
      .object({
        confirmedFindingIds: z.array(z.string()),
        candidateFindingIds: z.array(z.string()),
        rejectedFindingIds: z.array(z.string()),
      })
      .strict(),
    actionHistorySummary: z
      .object({
        totalActions: z.number().int().min(0),
        recentActions: z.array(HandoffActionSummarySchema),
        failedActions: z.array(HandoffActionSummarySchema),
        repeatedActionsToAvoid: z.array(z.string().max(300)),
      })
      .strict(),
    llmUsage: z
      .object({
        callsUsed: z.number().int().min(0),
        callsRemaining: z.number().int().min(0),
        contextUsage: ContextUsageSchema,
        fallbackAttemptsRemaining: z.number().int().min(0),
      })
      .strict(),
    agentProgress: AgentProgressSchema.optional(),
    budgetsRemaining: z
      .object({
        workPacketActionsRemaining: z.number().int().min(0),
        workPacketTimeMsRemaining: z.number().int().min(0),
        workPacketLlmCallsRemaining: z.number().int().min(0),
        handoffsRemaining: z.number().int().min(0),
      })
      .strict(),
    continuationInstructions: z
      .object({
        nextRequiredAction: z.string().max(500).optional(),
        resumeFromStepIndex: z.number().int().min(0),
        doNotRepeat: z.array(z.string().max(300)),
        stopConditions: z.array(z.string().max(300)),
        policyReminders: z.array(z.string().max(300)),
      })
      .strict(),
    artifactReferences: z
      .object({
        latestScreenshot: z.string().optional(),
        trace: z.string().optional(),
        actionLedger: z.string(),
        stepResults: z.string(),
        consoleLog: z.string().optional(),
        networkLog: z.string().optional(),
        findings: z.string(),
      })
      .strict(),
    conciseStatusSummary: z.string().max(1000),
    integrityHash: Sha256Schema,
  })
  .strict();
export type HandoffDocument = z.infer<typeof HandoffDocumentSchema>;

export const HandoffSummarySchema = z
  .object({
    handoffId: z.string(),
    workPacketId: z.string(),
    previousAgentInstanceId: z.string(),
    replacementAgentInstanceId: z.string().optional(),
    triggerReason: CheckpointReasonSchema,
    progressAtHandoff: z.object({ completed: z.number().int(), total: z.number().int() }).strict(),
    remainingStepIndexes: z.array(z.number().int()),
    restorationOutcome: z.enum(["not_attempted", "storage_state_restored", "replayed", "failed", "blocked"]),
    integrityValid: z.boolean(),
    path: z.string(),
  })
  .strict();
export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

export const RemainingWorkSchema = z
  .object({
    resumeFromStepIndex: z.number().int().min(0),
    remainingStepIndexes: z.array(z.number().int().min(0)),
    actionsRemaining: z.number().int().min(0),
    timeMsRemaining: z.number().int().min(0),
    llmCallsRemaining: z.number().int().min(0),
    handoffsRemaining: z.number().int().min(0),
  })
  .strict();
export type RemainingWork = z.infer<typeof RemainingWorkSchema>;

export const ArtifactEntrySchema = z
  .object({
    path: z.string(),
    type: z.enum([
      "work-packet",
      "ledger",
      "step-results",
      "findings",
      "screenshot",
      "dom",
      "trace",
      "console",
      "network",
      "checkpoint",
      "handoff",
      "storage-state",
      "instance",
      "report",
      "metadata",
      "discovery",
      "profile",
    ]),
    sha256: z.string().optional(),
    createdAt: IsoDateSchema,
  })
  .strict();

export const ArtifactManifestSchema = z
  .object({
    runId: z.string(),
    packetId: z.string().optional(),
    entries: z.array(ArtifactEntrySchema),
  })
  .strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

export const RunMetadataSchema = z
  .object({
    runId: z.string(),
    state: RunStateSchema,
    stateHistory: z.array(
      z.object({ state: RunStateSchema, at: IsoDateSchema, reason: z.string().optional() }).strict(),
    ),
    planId: z.string(),
    planHash: Sha256Schema,
    executionPlanHash: Sha256Schema,
    approvalId: z.string().optional(),
    phase: RunPhaseSchema.optional(),
    discoveryProfileHash: Sha256Schema.optional(),
    outputDir: z.string(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
    cancellationReason: z.string().optional(),
  })
  .strict();
export type RunMetadata = z.infer<typeof RunMetadataSchema>;
