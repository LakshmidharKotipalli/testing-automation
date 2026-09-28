import { z } from "zod";
import { Sha256Schema } from "./common.js";
import { WorkPacketSchema } from "./execution.js";
import { ModelRefSchema, SafetyPolicySchema } from "./plan.js";
import { HandoffActionSummarySchema, HandoffDocumentSchema, RemainingWorkSchema } from "./runtime.js";
import { LocatorSchema, TestStepSchema } from "./steps.js";

/**
 * The only context a replacement agent receives: bounded, validated, secret-free. It never contains a
 * prior model transcript or reasoning, raw DOM, raw logs, cookies or credentials.
 */
export const ResumeContextSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    workPacket: WorkPacketSchema,
    approvedExecutionPlanHash: Sha256Schema,
    handoff: HandoffDocumentSchema,
    checkpointSummary: z
      .object({
        checkpointId: z.string(),
        integrityHash: Sha256Schema,
        completedStepIndexes: z.array(z.number().int()),
        currentStepIndex: z.number().int(),
        currentUrl: z.string().optional(),
        reason: z.string(),
      })
      .strict(),
    recentActions: z.array(HandoffActionSummarySchema),
    locatorCandidates: z.array(LocatorSchema),
    nextStep: z.object({ index: z.number().int(), step: TestStepSchema }).strict().optional(),
    remainingWork: RemainingWorkSchema,
    safetyPolicy: SafetyPolicySchema,
    allowedTools: z.array(z.string()),
    model: ModelRefSchema.nullable(),
    compacted: z.boolean(),
    estimatedTokens: z.number().int().min(0),
  })
  .strict();
export type ResumeContext = z.infer<typeof ResumeContextSchema>;
