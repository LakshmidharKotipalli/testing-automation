import {
  ApprovalError,
  ApprovedExecutionPlanSchema,
  computeApprovalRecordHash,
  computeApprovedPlanHash,
  computeExecutionPlanHash,
  computePlanHash,
  computeRiskPlanHash,
  computeWorkPacketHash,
  ExecutionPlanSchema,
  formatZodIssues,
  IntegrityError,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApprovedExecutionPlan,
  type ExecutionPlan,
  type TestPlan,
} from "@browserswarm/core";
import { renderExecutionPlanReview } from "@browserswarm/execution-planner";
import { newId, systemClock, type Clock } from "@browserswarm/shared";

declare const verifiedBrand: unique symbol;

/**
 * An approved execution plan whose hashes were recomputed and verified in this process. The orchestrator
 * only accepts this type (and re-verifies at run start); it is only produced by verifyApprovedPlan().
 */
export type VerifiedApprovedPlan = ApprovedExecutionPlan & { readonly [verifiedBrand]: true };

export function createApprovalRequest(ep: ExecutionPlan, clock: Clock = systemClock): ApprovalRequest {
  return {
    requestId: newId("apreq"),
    runId: ep.runId,
    planHash: ep.planHash,
    executionPlanHash: ep.executionPlanHash,
    riskPlanHash: ep.riskPlanHash,
    requiresExplicitRiskApproval: ep.requiresExplicitRiskApproval,
    display: renderExecutionPlanReview(ep),
    createdAt: clock.iso(),
  };
}

/** Recomputes every hash inside an execution plan. Throws IntegrityError on any mismatch. */
export function verifyExecutionPlanIntegrity(ep: ExecutionPlan): void {
  const parsed = ExecutionPlanSchema.safeParse(ep);
  if (!parsed.success)
    throw new IntegrityError("execution plan failed schema validation", {
      issues: formatZodIssues(parsed.error),
    });
  const primaryIds = new Set(ep.workPackets.map((p) => p.packetId));
  const verified = new Set<string>();
  for (const v of ep.verifierPackets ?? []) {
    if (v.role !== "verifier" || !v.verifierOf || !primaryIds.has(v.verifierOf))
      throw new IntegrityError(`verifier packet ${v.packetId} does not verify a primary packet`);
    if (verified.has(v.verifierOf))
      throw new IntegrityError(`primary packet ${v.verifierOf} has more than one verifier`);
    verified.add(v.verifierOf);
  }
  if (ep.workPackets.some((p) => p.role === "verifier" || p.verifierOf))
    throw new IntegrityError("verifier packets must be reserved, not primary (no recursive verification)");
  for (const packet of [...ep.workPackets, ...(ep.verifierPackets ?? [])]) {
    if (computeWorkPacketHash(packet) !== packet.workPacketHash) {
      throw new IntegrityError(`work packet ${packet.packetId} was modified (hash mismatch)`);
    }
    if (packet.planHash !== ep.planHash || packet.runId !== ep.runId) {
      throw new IntegrityError(`work packet ${packet.packetId} is bound to a different plan or run`);
    }
  }
  if (computeExecutionPlanHash(ep) !== ep.executionPlanHash) {
    throw new IntegrityError("execution plan was modified after generation (hash mismatch)");
  }
  const expectedRisk = ep.riskFlags.length ? computeRiskPlanHash(ep.riskFlags, ep.executionPlanId) : null;
  if (expectedRisk !== ep.riskPlanHash) throw new IntegrityError("risk plan hash mismatch");
}

export interface DecisionInput {
  executionPlan: ExecutionPlan;
  /** The test plan the user reviewed. Its hash must match the execution plan's planHash. */
  plan: TestPlan;
  decision: ApprovalDecision;
  mode: ApprovalMode;
  operator: string;
  /** Separate, typed risk approval. Must echo the exact riskPlanHash when the plan has risky steps. */
  riskAcceptance?: { accepted: boolean; riskPlanHash?: string };
  reason?: string;
  /** Autonomous mode: the profile the plan was generated from. Must match plan.origin.profileHash. */
  discoveryProfileHash?: string;
  clock?: Clock;
}

/**
 * Records a decision on an exact execution plan. Approval is refused when the plan or execution plan does
 * not match what was generated, or when risky steps lack a matching typed risk approval.
 */
export function recordDecision(input: DecisionInput): ApprovalRecord {
  const { executionPlan: ep, plan } = input;
  verifyExecutionPlanIntegrity(ep);
  if (computePlanHash(plan) !== ep.planHash) {
    throw new ApprovalError(
      "APPROVAL_INVALIDATED",
      "the test plan changed after the execution plan was generated; generate a fresh execution plan and approve again",
    );
  }
  if (input.discoveryProfileHash !== undefined && plan.origin?.profileHash !== input.discoveryProfileHash) {
    throw new ApprovalError(
      "APPROVAL_INVALIDATED",
      "the test plan is not bound to the reviewed discovery profile; regenerate the plan from the profile",
    );
  }
  let riskAccepted = false;
  if (input.decision === "approve" && ep.requiresExplicitRiskApproval) {
    const ra = input.riskAcceptance;
    if (!ra?.accepted) {
      throw new ApprovalError(
        "RISK_APPROVAL_REQUIRED",
        `plan contains ${ep.riskFlags.length} risky step(s); separate risk approval is required (risk plan hash ${ep.riskPlanHash})`,
        { riskPlanHash: ep.riskPlanHash },
      );
    }
    if (ra.riskPlanHash !== ep.riskPlanHash) {
      throw new ApprovalError(
        "RISK_APPROVAL_REQUIRED",
        "risk approval hash does not match this plan's risk plan hash",
        {
          expected: ep.riskPlanHash,
        },
      );
    }
    riskAccepted = true;
  }
  const base: Omit<ApprovalRecord, "recordHash"> = {
    version: 1,
    approvalId: newId("approval"),
    runId: ep.runId,
    decision: input.decision,
    mode: input.mode,
    operator: input.operator,
    planHash: ep.planHash,
    executionPlanHash: ep.executionPlanHash,
    riskPlanHash: ep.riskPlanHash,
    riskAccepted,
    decidedAt: (input.clock ?? systemClock).iso(),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.discoveryProfileHash
      ? { discoveryProfileHash: input.discoveryProfileHash as `sha256:${string}` }
      : {}),
  };
  return { ...base, recordHash: computeApprovalRecordHash(base) };
}

export function buildApprovedExecutionPlan(ep: ExecutionPlan, record: ApprovalRecord): ApprovedExecutionPlan {
  if (record.decision !== "approve")
    throw new ApprovalError("APPROVAL_REQUIRED", `decision is ${record.decision}, not approve`);
  if (record.executionPlanHash !== ep.executionPlanHash)
    throw new IntegrityError("approval record is for a different execution plan");
  return {
    version: 1,
    executionPlan: ep,
    approvalRecord: record,
    approvedPlanHash: computeApprovedPlanHash(ep.executionPlanHash, record.recordHash),
  };
}

/**
 * Full verification of an approved plan before any browser starts: schema, every packet hash, the
 * execution plan hash, the approval record hash and binding, risk approval, and (when supplied) that the
 * current test plan still matches. Any mismatch invalidates the approval.
 */
export function verifyApprovedPlan(
  raw: unknown,
  options: { currentPlan?: TestPlan } = {},
): VerifiedApprovedPlan {
  const parsed = ApprovedExecutionPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrityError("approved execution plan failed schema validation", {
      issues: formatZodIssues(parsed.error),
    });
  }
  const approved = parsed.data;
  const { executionPlan: ep, approvalRecord: record } = approved;
  verifyExecutionPlanIntegrity(ep);
  if (computeApprovalRecordHash(record) !== record.recordHash)
    throw new IntegrityError("approval record was modified");
  if (record.decision !== "approve")
    throw new ApprovalError("APPROVAL_REQUIRED", `approval decision is ${record.decision}`);
  if (
    record.executionPlanHash !== ep.executionPlanHash ||
    record.planHash !== ep.planHash ||
    record.runId !== ep.runId
  ) {
    throw new ApprovalError("APPROVAL_INVALIDATED", "approval record does not match the execution plan");
  }
  if (computeApprovedPlanHash(ep.executionPlanHash, record.recordHash) !== approved.approvedPlanHash) {
    throw new IntegrityError("approved plan hash mismatch");
  }
  if (ep.requiresExplicitRiskApproval && (!record.riskAccepted || record.riskPlanHash !== ep.riskPlanHash)) {
    throw new ApprovalError(
      "RISK_APPROVAL_REQUIRED",
      "risky plan was approved without matching risk approval",
    );
  }
  if (options.currentPlan && computePlanHash(options.currentPlan) !== ep.planHash) {
    throw new ApprovalError(
      "APPROVAL_INVALIDATED",
      "the test plan changed after approval; a fresh execution plan and approval are required",
    );
  }
  return approved as VerifiedApprovedPlan;
}
