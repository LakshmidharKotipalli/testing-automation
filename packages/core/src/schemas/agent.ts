import { z } from "zod";

export const ToolClassSchema = z.enum([
  "read",
  "interact",
  "navigate",
  "evaluate",
  "upload",
  "download",
  "admin",
]);
export type ToolClass = z.infer<typeof ToolClassSchema>;
export const AgentPolicySchema = z
  .object({
    allowedTools: z.array(ToolClassSchema).min(1).default(["read", "interact", "navigate"]),
    maxToolCalls: z.number().int().positive().max(10000).default(50),
    maxLlmCalls: z.number().int().positive().max(1000).default(20),
    maxTokens: z.number().int().positive().default(50000),
    loopGuard: z
      .object({
        repetitions: z.number().int().min(2).default(3),
        window: z.number().int().min(2).default(10),
      })
      .strict()
      .default({}),
  })
  .strict();
export type AgentPolicy = z.infer<typeof AgentPolicySchema>;
export const VerdictSchema = z
  .object({
    status: z.enum(["pass", "fail", "blocked", "inconclusive"]),
    summary: z.string().min(1).max(2000),
    outcomes: z
      .array(
        z
          .object({
            expectedOutcome: z.string().min(1),
            met: z.boolean(),
            evidence: z.array(z.string().min(1)),
          })
          .strict(),
      )
      .min(1),
    failedStep: z.number().int().nonnegative().nullable().optional(),
    observed: z.string().max(2000).optional(),
    expected: z.string().max(2000).optional(),
  })
  .strict();
export type Verdict = z.infer<typeof VerdictSchema>;
export const AgentTelemetrySchema = z
  .object({
    llmCalls: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    usageExact: z.boolean(),
    cost: z.number().nonnegative().nullable(),
    toolCalls: z.number().int().nonnegative(),
    loopGuardTrips: z.number().int().nonnegative(),
  })
  .strict();
export type AgentTelemetry = z.infer<typeof AgentTelemetrySchema>;
