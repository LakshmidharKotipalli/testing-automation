import type { ApprovalRecord, ApprovedExecutionPlan, ExecutionPlan } from "@browserswarm/core";
import { RunLayout, type StorageAdapter } from "@browserswarm/storage";

/** Writes the execution plan and its hash file (atomic). */
export async function persistExecutionPlan(storage: StorageAdapter, ep: ExecutionPlan): Promise<void> {
  await storage.writeJson(RunLayout.metadata.executionPlan, ep);
  await storage.writeText(RunLayout.metadata.executionPlanHash, `${ep.executionPlanHash}\n`);
}

/** Writes the approval record and, for approvals, the immutable approved execution plan (atomic). */
export async function persistApproval(
  storage: StorageAdapter,
  record: ApprovalRecord,
  approved?: ApprovedExecutionPlan,
): Promise<void> {
  await storage.writeJson(RunLayout.metadata.approvalRecord, record);
  if (approved) await storage.writeJson(RunLayout.metadata.approvedExecutionPlan, approved);
}
