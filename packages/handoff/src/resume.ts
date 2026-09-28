import {
  BrowserSwarmError,
  computeHandoffHash,
  computeWorkPacketHash,
  IntegrityError,
  ResumeContextSchema,
  STEP_ACTIONS,
  type AgentCheckpoint,
  type AgentInstance,
  type HandoffDocument,
  type ResumeContext,
  type WorkPacket,
} from "@browserswarm/core";
import { estimateTokens } from "@browserswarm/opencode-adapter";
import { checkResumeContext } from "@browserswarm/policy-engine";
import { canonicalize, type Redactor } from "@browserswarm/shared";
import { verifyCheckpoint } from "./checkpoint.js";
import { verifyHandoff } from "./persist.js";

export interface ReplacementPreflightInput {
  packet: WorkPacket;
  approvedExecutionPlanHash: string;
  checkpoint: unknown;
  handoff: unknown;
  handoffsUsed: number;
  packetTerminal: boolean;
  redactor: Redactor;
}

export type PreflightResult =
  | { ok: true; checkpoint: AgentCheckpoint; handoff: HandoffDocument }
  | {
      ok: false;
      code: "HANDOFF_LIMIT_EXCEEDED" | "INTEGRITY_MISMATCH" | "POLICY_VIOLATION" | "PACKET_TERMINAL";
      reason: string;
    };

/**
 * Every check that must pass before a replacement agent may be created (section 16, step 1). Any failure
 * means the packet is BLOCKED; a replacement is never started on unverified state.
 */
export function replacementPreflight(input: ReplacementPreflightInput): PreflightResult {
  const { packet } = input;
  if (input.packetTerminal)
    return { ok: false, code: "PACKET_TERMINAL", reason: "work packet is already terminal" };
  if (input.handoffsUsed >= packet.contextPolicy.maxHandoffsPerWorkPacket) {
    return {
      ok: false,
      code: "HANDOFF_LIMIT_EXCEEDED",
      reason: `handoff_limit_exceeded: ${input.handoffsUsed} of max ${packet.contextPolicy.maxHandoffsPerWorkPacket}`,
    };
  }
  if (computeWorkPacketHash(packet) !== packet.workPacketHash) {
    return { ok: false, code: "INTEGRITY_MISMATCH", reason: "work packet hash mismatch" };
  }
  let checkpoint: AgentCheckpoint;
  let handoff: HandoffDocument;
  try {
    checkpoint = verifyCheckpoint(input.checkpoint);
    handoff = verifyHandoff(input.handoff);
  } catch (e) {
    return { ok: false, code: "INTEGRITY_MISMATCH", reason: (e as Error).message };
  }
  if (
    checkpoint.immutableWorkPacketHash !== packet.workPacketHash ||
    checkpoint.approvedExecutionPlanHash !== input.approvedExecutionPlanHash
  ) {
    return {
      ok: false,
      code: "INTEGRITY_MISMATCH",
      reason: "checkpoint is bound to a different packet or execution plan",
    };
  }
  if (handoff.sourceCheckpointId !== checkpoint.checkpointId) {
    return {
      ok: false,
      code: "INTEGRITY_MISMATCH",
      reason: "handoff does not reference the latest checkpoint",
    };
  }
  if (handoff.continuationInstructions.resumeFromStepIndex !== checkpoint.currentStepIndex) {
    return {
      ok: false,
      code: "INTEGRITY_MISMATCH",
      reason: "handoff resume index disagrees with checkpoint",
    };
  }
  return { ok: true, checkpoint, handoff };
}

export interface BuildResumeContextInput {
  packet: WorkPacket;
  approvedExecutionPlanHash: string;
  checkpoint: AgentCheckpoint;
  handoff: HandoffDocument;
  replacementAgentInstanceId: string;
  handoffsUsed: number;
  elapsedMsInPacket: number;
  actionsUsedInPacket: number;
  llmCallsUsedInPacket: number;
  redactor: Redactor;
  /** Token budget for the whole resume context; defaults to 3x the handoff budget. */
  maxTokens?: number;
}

/**
 * Builds the bounded resume context for a replacement agent. When it exceeds its budget it is compacted
 * deterministically (mission, current step, remaining steps, last actions, locators, artifact paths).
 */
export function buildResumeContext(input: BuildResumeContextInput): {
  context: ResumeContext;
  compacted: boolean;
} {
  const { packet, checkpoint, redactor } = input;
  const handoffBase = { ...input.handoff, replacementAgentInstanceId: input.replacementAgentInstanceId };
  const handoff: HandoffDocument = { ...handoffBase, integrityHash: computeHandoffHash(handoffBase) };
  const nextIndex = checkpoint.currentStepIndex;
  const nextStep = packet.steps[nextIndex];
  const maxTokens =
    input.maxTokens ??
    packet.contextPolicy.handoffMaxTokensEstimate * 3 + estimateTokens(canonicalize(packet)).tokens;

  let context: ResumeContext = {
    version: 1,
    runId: packet.runId,
    workPacket: packet,
    approvedExecutionPlanHash: input.approvedExecutionPlanHash as ResumeContext["approvedExecutionPlanHash"],
    handoff,
    checkpointSummary: {
      checkpointId: checkpoint.checkpointId,
      integrityHash: checkpoint.integrityHash,
      completedStepIndexes: checkpoint.completedStepIndexes,
      currentStepIndex: checkpoint.currentStepIndex,
      ...(checkpoint.currentUrl ? { currentUrl: redactor.redactString(checkpoint.currentUrl) } : {}),
      reason: checkpoint.reason,
    },
    recentActions: handoff.actionHistorySummary.recentActions,
    locatorCandidates: handoff.importantObservations.relevantElementLocators,
    ...(nextStep && checkpoint.remainingStepIndexes.length
      ? { nextStep: { index: nextIndex, step: nextStep } }
      : {}),
    remainingWork: {
      resumeFromStepIndex: nextIndex,
      remainingStepIndexes: checkpoint.remainingStepIndexes,
      actionsRemaining: Math.max(0, packet.actionBudget - input.actionsUsedInPacket),
      timeMsRemaining: Math.max(0, Math.round(packet.timeoutMs - input.elapsedMsInPacket)),
      llmCallsRemaining: Math.max(0, packet.llmCallBudget - input.llmCallsUsedInPacket),
      handoffsRemaining: Math.max(0, packet.contextPolicy.maxHandoffsPerWorkPacket - input.handoffsUsed),
    },
    safetyPolicy: packet.safety,
    allowedTools: [...STEP_ACTIONS],
    model: packet.model,
    compacted: false,
    estimatedTokens: 0,
  };
  let compacted = false;
  const size = () => estimateTokens(canonicalize(context)).tokens;
  if (size() > maxTokens) {
    compacted = true;
    const h = context.handoff;
    const compactBase = {
      ...h,
      executionProgress: {
        ...h.executionProgress,
        completedSteps: h.executionProgress.completedSteps.slice(-2),
      },
      importantObservations: {
        ...h.importantObservations,
        confirmedFacts: h.importantObservations.confirmedFacts.slice(-2),
        consoleOrNetworkObservations: [],
        accessibilityObservations: [],
      },
      actionHistorySummary: {
        ...h.actionHistorySummary,
        recentActions: h.actionHistorySummary.recentActions.slice(-3),
        failedActions: h.actionHistorySummary.failedActions.slice(-2),
      },
    };
    const { integrityHash: _drop, ...withoutHash } = compactBase;
    context = {
      ...context,
      handoff: { ...withoutHash, integrityHash: computeHandoffHash(withoutHash) },
      recentActions: context.recentActions.slice(-3),
      locatorCandidates: context.locatorCandidates.slice(0, 6),
      allowedTools: nextStep
        ? [
            nextStep.action,
            ...new Set(
              checkpoint.remainingStepIndexes
                .map((i) => packet.steps[i]?.action)
                .filter((a): a is NonNullable<typeof a> => !!a),
            ),
          ]
        : [],
    };
  }
  context = { ...context, compacted, estimatedTokens: size() };
  const parsed = ResumeContextSchema.parse(context);
  const decision = checkResumeContext(parsed, packet, redactor);
  if (!decision.allowed)
    throw new BrowserSwarmError("POLICY_VIOLATION", `resume context rejected: ${decision.reason}`);
  return { context: parsed, compacted };
}

/**
 * Creates replacement agent instances. Implemented by the orchestrator (Milestone 3 wires automatic
 * rotation); the contract is fixed here so checkpoints, handoffs and resume contexts are stable now.
 */
export interface ReplacementAgentFactory {
  createReplacement(input: {
    packet: WorkPacket;
    previous: AgentInstance;
    checkpoint: AgentCheckpoint;
    handoff: HandoffDocument;
    resumeContext: ResumeContext;
  }): Promise<AgentInstance>;
}

export function assertHandoffMatchesPacket(handoff: HandoffDocument, packet: WorkPacket): void {
  if (handoff.immutableWorkPacketHash !== packet.workPacketHash)
    throw new IntegrityError("handoff/work packet hash mismatch");
}
