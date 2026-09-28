import { z } from "zod";
import { IsoDateSchema, Sha256Schema } from "./common.js";
import { ExecutionPlanSchema } from "./execution.js";

export const ApprovalDecisionSchema = z.enum(["approve", "reject", "export", "edit"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalModeSchema = z.enum(["interactive", "noninteractive"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const ApprovalRequestSchema = z
  .object({
    requestId: z.string(),
    runId: z.string(),
    planHash: Sha256Schema,
    executionPlanHash: Sha256Schema,
    riskPlanHash: Sha256Schema.nullable(),
    requiresExplicitRiskApproval: z.boolean(),
    display: z.string(),
    createdAt: IsoDateSchema,
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalRecordSchema = z
  .object({
    version: z.literal(1),
    approvalId: z.string(),
    runId: z.string(),
    decision: ApprovalDecisionSchema,
    mode: ApprovalModeSchema,
    operator: z.string().min(1),
    planHash: Sha256Schema,
    executionPlanHash: Sha256Schema,
    riskPlanHash: Sha256Schema.nullable(),
    riskAccepted: z.boolean(),
    decidedAt: IsoDateSchema,
    reason: z.string().max(2000).optional(),
    recordHash: Sha256Schema,
  })
  .strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const ApprovedExecutionPlanSchema = z
  .object({
    version: z.literal(1),
    executionPlan: ExecutionPlanSchema,
    approvalRecord: ApprovalRecordSchema,
    approvedPlanHash: Sha256Schema,
  })
  .strict();
export type ApprovedExecutionPlan = z.infer<typeof ApprovedExecutionPlanSchema>;
