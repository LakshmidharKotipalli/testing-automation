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
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

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
