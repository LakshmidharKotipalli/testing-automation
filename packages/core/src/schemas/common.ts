import { z } from "zod";

export const Sha256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "expected sha256:<64 hex chars>") as z.ZodType<`sha256:${string}`>;

export const IsoDateSchema = z.string().datetime({ offset: true });

export const SlugIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9-_.]*$/i, "ids may contain letters, digits, '-', '_' and '.'");

/**
 * Documented extension mechanism: schemas that accept `extensions` only allow keys prefixed with `x-`.
 * All other unknown keys are rejected everywhere (`.strict()`).
 */
export const ExtensionsSchema = z
  .record(z.string().regex(/^x-[a-z0-9-]+$/, "extension keys must start with 'x-'"), z.unknown())
  .optional();

export const AgentRoleSchema = z.enum([
  "functional",
  "forms",
  "accessibility",
  "responsive",
  "visual",
  "performance-smoke",
  "security-smoke",
  "verifier",
  // Roles selected by the autonomous planner from discovery evidence (additive; existing plans unchanged).
  "navigation",
  "functional-ui",
  "forms-read-only",
  "search-filter",
  "content",
  "table-data",
  "dashboard",
  "ecommerce-browse-only",
  "booking-browse-only",
  "console-network",
  "domain-consistency",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** Work phases of a run. Discovery and planning happen before approval; execution only after. */
export const RunPhaseSchema = z.enum([
  "discovery",
  "planning",
  "approval",
  "execution",
  "verification",
  "reporting",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

/** Where a scenario came from. User instructions always outrank discovery-derived scenarios. */
export const ScenarioSourceSchema = z.enum([
  "user-instruction",
  "discovery-route",
  "discovery-journey",
  "discovery-quality-signal",
  "discovery-domain-rule",
]);
export type ScenarioSource = z.infer<typeof ScenarioSourceSchema>;

/** Safety class of a scenario. Only safe-read-only scenarios run without extra data, credentials or risk approval. */
export const ScenarioSafetyClassSchema = z.enum([
  "safe-read-only",
  "requires-test-data",
  "requires-credentials",
  "requires-risk-approval",
  "excluded",
]);
export type ScenarioSafetyClass = z.infer<typeof ScenarioSafetyClassSchema>;

/**
 * Pointer to an observation that backs a claim. Excerpts are short, redacted, and never contain form values,
 * cookies, tokens or raw model output.
 */
export const EvidenceReferenceSchema = z
  .object({
    evidenceId: z.string().min(1).max(96),
    kind: z.enum([
      "route-observation",
      "dom-extract",
      "screenshot",
      "accessibility",
      "console",
      "network",
      "navigation-graph",
      "heuristic",
      "llm-classification",
    ]),
    route: z.string().max(2000).optional(),
    artifactPath: z.string().max(500).optional(),
    excerpt: z.string().max(300),
  })
  .strict();
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const PrioritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const ViewportSizeSchema = z
  .object({
    width: z.number().int().min(200).max(7680),
    height: z.number().int().min(200).max(4320),
  })
  .strict();
export type ViewportSize = z.infer<typeof ViewportSizeSchema>;
