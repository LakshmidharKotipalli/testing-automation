import { z } from "zod";
import {
  AgentRoleSchema,
  ExtensionsSchema,
  PrioritySchema,
  SeveritySchema,
  SlugIdSchema,
  ViewportSizeSchema,
} from "./common.js";
import { TestStepSchema } from "./steps.js";

export const DomainSchema = z
  .string()
  .min(1)
  .regex(
    /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\d{1,3}(?:\.\d{1,3}){3}$/i,
    "expected a bare hostname (no scheme, port or path)",
  );

export const TargetConfigSchema = z
  .object({
    url: z.string().url(),
    allowedDomains: z.array(DomainSchema).min(1),
    allowSubdomains: z.boolean().default(false),
  })
  .strict();
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export const BrowserEngineSchema = z.enum(["chromium", "firefox", "webkit"]);

export const BrowserConfigSchema = z
  .object({
    engine: BrowserEngineSchema.default("chromium"),
    headless: z.boolean().default(true),
    locale: z.string().default("en-US"),
    timezoneId: z.string().default("UTC"),
    trace: z.boolean().default(true),
    screenshot: z.enum(["off", "only-on-failure", "on"]).default("only-on-failure"),
    navigationTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    actionTimeoutMs: z.number().int().min(250).max(120_000).default(10_000),
  })
  .strict();
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export const ExecutionConfigSchema = z
  .object({
    maxConcurrentAgents: z.number().int().min(1).max(64).default(4),
    agentTimeoutMs: z.number().int().min(1000).default(180_000),
    runTimeoutMs: z.number().int().min(1000).default(900_000),
    maxActionsPerAgent: z.number().int().min(1).max(10_000).default(50),
    failFast: z.boolean().default(false),
  })
  .strict();
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export const ModelRefSchema = z
  .object({
    provider: z.enum(["opencode-cli", "mock"]),
    model: z.string().min(1),
    command: z.string().min(1).optional(),
    argsTemplate: z.array(z.string()).optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    contextWindowTokens: z.number().int().min(1024).optional(),
    outputFormat: z.enum(["json", "text-json-block"]).optional(),
    /**
     * Name of the variable the model runtime reads its key from (e.g. ANTHROPIC_API_KEY). The key VALUE
     * always comes from BROWSERSWARM_LLM_API_KEY in .env and is never part of the plan.
     */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
  })
  .strict();
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const ModelAssignmentSchema = z
  .object({
    default: ModelRefSchema.optional(),
    overrides: z.record(AgentRoleSchema, ModelRefSchema).default({}),
  })
  .strict();
export type ModelAssignment = z.infer<typeof ModelAssignmentSchema>;

export const LlmTriggerSchema = z.enum([
  "locator_not_found",
  "ambiguous_page_state",
  "dynamic_content_mismatch",
  "visual_validation_requested",
  "failure_triage_requested",
  "verifier_reproduction_needed",
]);
export type LlmTrigger = z.infer<typeof LlmTriggerSchema>;

export const LlmPolicySchema = z
  .object({
    strategy: z.enum(["disabled", "fallback-only", "guided"]).default("disabled"),
    maxCallsPerWorkPacket: z.number().int().min(0).max(100).default(0),
    maxTokensPerCall: z.number().int().min(64).max(64_000).default(1500),
    maxRepairAttempts: z.number().int().min(0).max(3).default(1),
    allowedTriggers: z.array(LlmTriggerSchema).default([]),
  })
  .strict();
export type LlmPolicy = z.infer<typeof LlmPolicySchema>;

export const ContextPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    modelContextWindowTokens: z.number().int().min(1024).optional(),
    contextWarningThresholdPercent: z.number().min(1).max(99).default(75),
    contextHardStopThresholdPercent: z.number().min(1).max(100).default(85),
    maxMessagesPerAgentInstance: z.number().int().min(1).optional(),
    maxEstimatedInputTokensPerAgentInstance: z.number().int().min(1).optional(),
    maxEstimatedOutputTokensPerAgentInstance: z.number().int().min(1).optional(),
    maxEstimatedTotalTokensPerAgentInstance: z.number().int().min(1).optional(),
    maxActionsPerAgentInstance: z.number().int().min(1).optional(),
    maxDurationMsPerAgentInstance: z.number().int().min(1000).optional(),
    maxConsecutiveFallbackCalls: z.number().int().min(1).optional(),
    checkpointBeforeRiskyAction: z.boolean().default(true),
    checkpointAfterEveryStep: z.boolean().default(true),
    checkpointOnContextWarning: z.boolean().default(true),
    restoreBrowserSession: z.enum(["none", "storage-state"]).default("storage-state"),
    allowResumeCurrentUrl: z.boolean().default(true),
    maxHandoffsPerWorkPacket: z.number().int().min(0).max(50).default(3),
    includeRecentActionCount: z.number().int().min(0).max(100).default(8),
    includeRecentObservationCount: z.number().int().min(0).max(100).default(8),
    includeCompletedStepDetail: z.enum(["summary", "full"]).default("summary"),
    handoffMaxTokensEstimate: z.number().int().min(256).max(32_000).default(1800),
    includeScreenshotsInHandoff: z.literal(false).default(false),
    includeRawDomInHandoff: z.literal(false).default(false),
  })
  .strict()
  .refine((p) => p.contextHardStopThresholdPercent > p.contextWarningThresholdPercent, {
    message: "contextHardStopThresholdPercent must be greater than contextWarningThresholdPercent",
    path: ["contextHardStopThresholdPercent"],
  });
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;

export const SafetyPolicySchema = z
  .object({
    destructiveActions: z.enum(["deny", "allow-with-approval"]).default("deny"),
    allowAuthentication: z.boolean().default(false),
    allowExternalNavigation: z.boolean().default(false),
    allowFileDownloads: z.boolean().default(false),
    allowUploads: z.boolean().default(false),
    allowAccountCreation: z.boolean().default(false),
    allowPurchases: z.boolean().default(false),
    allowEmailSending: z.boolean().default(false),
    allowPasswordChanges: z.boolean().default(false),
    allowInvitations: z.boolean().default(false),
    allowSocialPosting: z.boolean().default(false),
    allowSecuritySmoke: z.boolean().default(false),
    redactSensitiveData: z.boolean().default(true),
    requireEvidenceForFindings: z.literal(true).default(true),
  })
  .strict();
export type SafetyPolicy = z.infer<typeof SafetyPolicySchema>;

/**
 * Test data value: a literal string, or an object that may pull the value from an environment variable
 * at run time (`fromEnv`) so secrets never have to live in plan or approval files.
 */
export const TestDataValueSchema = z.union([
  z.string(),
  z
    .object({
      value: z.string().optional(),
      fromEnv: z
        .string()
        .regex(/^[A-Z_][A-Z0-9_]*$/)
        .optional(),
      secret: z.boolean().default(false),
      category: z.string().max(64).optional(),
    })
    .strict()
    .refine((v) => (v.value === undefined) !== (v.fromEnv === undefined), {
      message: "test data object requires exactly one of value or fromEnv",
    }),
]);
export type TestDataValue = z.infer<typeof TestDataValueSchema>;
export const TestDataSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), TestDataValueSchema);
export type TestData = z.infer<typeof TestDataSchema>;

export const ViewportProfileSchema = ViewportSizeSchema;
export type ViewportProfile = z.infer<typeof ViewportProfileSchema>;

export const ScenarioSchema = z
  .object({
    id: SlugIdSchema,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(1000),
    priority: PrioritySchema.default("medium"),
    roles: z.array(AgentRoleSchema).min(1),
    viewports: z.array(z.string().min(1)).min(1),
    expectedOutcome: z.string().min(1).max(1000),
    tags: z.array(z.string()).optional(),
    steps: z.array(TestStepSchema).min(1),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ReportingConfigSchema = z
  .object({
    outputDir: z.string().default("./artifacts"),
    formats: z.array(z.enum(["json", "markdown", "html", "junit"])).default(["json", "markdown"]),
    verifySeverityAtOrAbove: SeveritySchema.default("high"),
  })
  .strict();
export type ReportingConfig = z.infer<typeof ReportingConfigSchema>;

export const CompilationInfoSchema = z
  .object({
    compiledFrom: z.enum(["natural-language", "structured"]),
    compiler: z.enum(["heuristic", "llm"]),
    promptSha256: z.string().optional(),
    assumptions: z.array(z.string()).default([]),
    ambiguities: z.array(z.string()).default([]),
    restrictions: z.array(z.string()).default([]),
    needsReview: z.boolean().default(false),
  })
  .strict();
export type CompilationInfo = z.infer<typeof CompilationInfoSchema>;

export const TestPlanSchema = z
  .object({
    version: z.literal(1),
    id: SlugIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    mode: z.enum(["scripted", "llm-assisted"]).default("scripted"),
    target: TargetConfigSchema,
    browser: BrowserConfigSchema.default({}),
    execution: ExecutionConfigSchema.default({}),
    models: ModelAssignmentSchema.default({}),
    llm: LlmPolicySchema.default({}),
    contextLifecycle: ContextPolicySchema.default({}),
    safety: SafetyPolicySchema.default({}),
    testData: TestDataSchema.default({}),
    viewports: z
      .record(z.string().min(1), ViewportProfileSchema)
      .default({ desktop: { width: 1440, height: 900 } }),
    scenarios: z.array(ScenarioSchema).min(1),
    reporting: ReportingConfigSchema.default({}),
    compilation: CompilationInfoSchema.optional(),
    extensions: ExtensionsSchema,
  })
  .strict();
export type TestPlan = z.infer<typeof TestPlanSchema>;
export type TestPlanInput = z.input<typeof TestPlanSchema>;

export const PlanSourceSchema = z
  .object({
    kind: z.enum(["yaml", "json", "prompt"]),
    path: z.string().optional(),
    sha256: z.string(),
  })
  .strict();
export type PlanSource = z.infer<typeof PlanSourceSchema>;
