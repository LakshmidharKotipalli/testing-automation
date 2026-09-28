import { hashExcluding, hashObject, type Sha256 } from "@browserswarm/shared";
import type { ApprovalRecord } from "./schemas/approval.js";
import type { ExecutionPlan, RiskFlag, WorkPacket } from "./schemas/execution.js";
import type { TestPlan } from "./schemas/plan.js";
import type { AgentCheckpoint, HandoffDocument } from "./schemas/runtime.js";
import type { z } from "zod";

/**
 * Identity hashes. Every hash is SHA-256 over canonical JSON (sorted keys). A document's own hash field
 * is excluded from its hash input.
 *
 * planHash binds the fully-defaulted TestPlan (so a changed default is also a changed plan).
 */
export function computePlanHash(plan: TestPlan): Sha256 {
  return hashObject(plan);
}

export function computeWorkPacketHash(packet: Omit<WorkPacket, "workPacketHash"> | WorkPacket): Sha256 {
  return hashExcluding(packet as WorkPacket, "workPacketHash");
}

export function computeExecutionPlanHash(
  plan: Omit<ExecutionPlan, "executionPlanHash"> | ExecutionPlan,
): Sha256 {
  return hashExcluding(plan as ExecutionPlan, "executionPlanHash");
}

export function computeRiskPlanHash(riskFlags: RiskFlag[], executionPlanId: string): Sha256 {
  return hashObject({ executionPlanId, riskFlags });
}

export function computeApprovalRecordHash(
  record: Omit<ApprovalRecord, "recordHash"> | ApprovalRecord,
): Sha256 {
  return hashExcluding(record as ApprovalRecord, "recordHash");
}

export function computeApprovedPlanHash(executionPlanHash: string, recordHash: string): Sha256 {
  return hashObject({ executionPlanHash, recordHash });
}

export function computeCheckpointHash(cp: Omit<AgentCheckpoint, "integrityHash"> | AgentCheckpoint): Sha256 {
  return hashExcluding(cp as AgentCheckpoint, "integrityHash");
}

export function computeHandoffHash(doc: Omit<HandoffDocument, "integrityHash"> | HandoffDocument): Sha256 {
  return hashExcluding(doc as HandoffDocument, "integrityHash");
}

/** Formats Zod issues as `path: message` lines. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join(".") : "(root)";
    const extra =
      issue.code === "unrecognized_keys" ? ` (${(issue as { keys: string[] }).keys.join(", ")})` : "";
    return `${where}: ${issue.message}${extra}`;
  });
}
