import { z } from "zod";
import {
  AgentRoleSchema,
  IsoDateSchema,
  PrioritySchema,
  Sha256Schema,
  ViewportSizeSchema,
} from "./common.js";
import {
  BrowserConfigSchema,
  BrowserProjectSchema,
  ContextPolicySchema,
  LlmPolicySchema,
  ModelRefSchema,
  ReportingConfigSchema,
  SafetyPolicySchema,
  TestDataSchema,
} from "./plan.js";
import { AgentPolicySchema } from "./agent.js";
import { TestStepSchema } from "./steps.js";

export const RiskCategorySchema = z.enum([
  "account_creation",
  "email_sms_sending",
  "purchase",
  "payment",
  "file_upload",
  "file_download",
  "deletion",
  "password_change",
  "invitation",
  "social_posting",
  "data_modification",
  "external_navigation",
  "authentication",
  "tool_evaluate",
  "tool_admin",
  "irreversible",
]);
export type RiskCategory = z.infer<typeof RiskCategorySchema>;

export const RiskFlagSchema = z
  .object({
    scenarioId: z.string(),
    stepIndex: z.number().int().min(0),
    action: z.string(),
    category: RiskCategorySchema,
    reason: z.string(),
    allowedByPolicy: z.boolean(),
  })
  .strict();
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

export const PacketModeSchema = z.enum(["deterministic", "llm-capable", "agentic"]);

export const WorkPacketSchema = z
  .object({
    version: z.literal(1),
    packetId: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    scenarioId: z.string().min(1),
    scenarioTitle: z.string(),
    objective: z.string(),
    priority: PrioritySchema,
    role: AgentRoleSchema,
    viewportName: z.string(),
    viewport: ViewportSizeSchema,
    browser: BrowserConfigSchema,
    /** Present only when the plan declares browser projects. */
    projectName: z.string().optional(),
    /** Set only on reserved verifier packets: the primary packet this one may verify. */
    verifierOf: z.string().optional(),
    targetUrl: z.string().url(),
    allowedDomains: z.array(z.string()).min(1),
    allowSubdomains: z.boolean(),
    /** Ordered steps exactly as approved. Test-data templates stay unresolved so packets never hold secrets. */
    steps: z.array(TestStepSchema),
    instructions: z.array(z.string()).optional(),
    agent: AgentPolicySchema.optional(),
    runtimeVersion: z.literal("mcp-v1").optional(),
    expectedOutcome: z.string(),
    mode: PacketModeSchema,
    model: ModelRefSchema.nullable(),
    llmPolicy: LlmPolicySchema,
    contextPolicy: ContextPolicySchema,
    safety: SafetyPolicySchema,
    timeoutMs: z.number().int().min(1000),
    actionBudget: z.number().int().min(1),
    llmCallBudget: z.number().int().min(0),
    artifactDir: z.string(),
    planHash: Sha256Schema,
    riskFlags: z.array(RiskFlagSchema),
    requiresExplicitRiskApproval: z.boolean(),
    /** Why the planner created this packet (autonomous mode). Optional; absent for instruction-led plans. */
    rationale: z.string().max(1000).optional(),
    workPacketHash: Sha256Schema,
  })
  .strict();
export type WorkPacket = z.infer<typeof WorkPacketSchema>;

export const ExecutionPlanSummarySchema = z
  .object({
    scenarioCount: z.number().int(),
    workPacketCount: z.number().int(),
    verifierPacketCount: z.number().int().optional(),
    deterministicPackets: z.number().int(),
    llmCapablePackets: z.number().int(),
    maxConcurrentWorkPackets: z.number().int(),
    maxConcurrentBrowserContexts: z.number().int(),
    maxBrowserActions: z.number().int(),
    maxLlmCalls: z.number().int(),
    estimatedMaxTokens: z.number().int(),
    estimatedMaxAgentInstances: z.number().int(),
    estimatedContextHandoffs: z.number().int(),
    estimatedCheckpoints: z.number().int(),
    estimatedRuntimeMs: z.object({ min: z.number().int(), max: z.number().int() }).strict(),
    testDataCategories: z.array(z.string()),
    browserMatrix: z.array(
      z
        .object({
          engine: z.string(),
          project: z.string().optional(),
          viewportName: z.string(),
          viewport: ViewportSizeSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type ExecutionPlanSummary = z.infer<typeof ExecutionPlanSummarySchema>;

export const ExecutionPlanSchema = z
  .object({
    version: z.literal(1),
    executionPlanId: z.string().min(1),
    runId: z.string().min(1),
    createdAt: IsoDateSchema,
    planId: z.string(),
    planName: z.string(),
    planHash: Sha256Schema,
    mode: z.enum(["scripted", "llm-assisted", "agentic"]),
    target: z
      .object({
        url: z.string().url(),
        allowedDomains: z.array(z.string()).min(1),
        allowSubdomains: z.boolean(),
      })
      .strict(),
    concurrency: z
      .object({
        maxConcurrentWorkPackets: z.number().int().min(1),
        maxConcurrentBrowserContexts: z.number().int().min(1),
        failFast: z.boolean(),
        runTimeoutMs: z.number().int(),
      })
      .strict(),
    models: z.record(z.string(), ModelRefSchema.nullable()),
    llm: LlmPolicySchema,
    contextLifecycle: ContextPolicySchema,
    safety: SafetyPolicySchema,
    browser: BrowserConfigSchema,
    browserProjects: z.array(BrowserProjectSchema).optional(),
    reporting: ReportingConfigSchema,
    /** Hash-bound test data (literals or env references). Values are resolved only at run time. */
    testData: TestDataSchema,
    workPackets: z.array(WorkPacketSchema).min(1),
    /** Reserved conditional verifier packets (at most one per primary packet). Absent when verification is off. */
    verifierPackets: z.array(WorkPacketSchema).optional(),
    summary: ExecutionPlanSummarySchema,
    riskFlags: z.array(RiskFlagSchema),
    riskPlanHash: Sha256Schema.nullable(),
    requiresExplicitRiskApproval: z.boolean(),
    limitations: z.array(z.string()),
    /** Autonomous mode: binds the execution plan to the discovery profile it was generated from. */
    origin: z
      .object({
        mode: z.enum(["instruction-led", "autonomous"]),
        profileId: z.string().optional(),
        profileHash: Sha256Schema.optional(),
        testPlanHash: Sha256Schema,
      })
      .strict()
      .optional(),
    executionPlanHash: Sha256Schema,
  })
  .strict();
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
