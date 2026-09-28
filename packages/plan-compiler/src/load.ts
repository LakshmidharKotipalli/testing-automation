import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  formatZodIssues,
  TestPlanSchema,
  ValidationError,
  type PlanSource,
  type TestPlan,
} from "@browserswarm/core";
import { ENV, sha256, targetFromEnv } from "@browserswarm/shared";
import YAML from "yaml";

export interface LoadedPlan {
  plan: TestPlan;
  source: PlanSource;
  rawText: string;
  /** Where target.url came from: the plan file itself, or the central BROWSERSWARM_TARGET_URL setting. */
  targetSource: TargetSource;
}

export type TargetSource = "plan" | "env";

export interface PlanLoadOptions {
  /** Environment used to resolve the central target website. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Fills the target website from the central env setting when the plan does not name one:
 * - `target` / `target.url` omitted -> BROWSERSWARM_TARGET_URL;
 * - `target.allowedDomains` omitted -> BROWSERSWARM_ALLOWED_DOMAINS, else the target host.
 * An explicit `target.url` in the plan always wins. Resolution happens before validation and hashing, so
 * the approved plan is bound to the concrete URL and changing .env requires a fresh approval.
 */
export function applyEnvTarget(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { raw: unknown; targetSource: TargetSource } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { raw, targetSource: "plan" };
  const plan = raw as Record<string, unknown>;
  const target = (plan.target ?? {}) as Record<string, unknown>;
  if (typeof target !== "object" || Array.isArray(target)) return { raw, targetSource: "plan" };
  if (target.url !== undefined) return { raw, targetSource: "plan" };
  const fromEnv = targetFromEnv(env);
  if (!fromEnv) {
    throw new ValidationError("No target website configured", [
      `set ${ENV.TARGET_URL} in .env (see .env.example), or add target.url to the plan`,
    ]);
  }
  return {
    raw: {
      ...plan,
      target: {
        ...target,
        url: fromEnv.url,
        allowedDomains: target.allowedDomains ?? fromEnv.allowedDomains,
      },
    },
    targetSource: "env",
  };
}

export function parsePlanText(text: string, kind: "yaml" | "json"): unknown {
  if (kind === "json") return JSON.parse(text);
  const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length)
    throw new ValidationError(
      "YAML parse error",
      doc.errors.map((e) => e.message),
    );
  return doc.toJS();
}

/** Parses and validates plan content. Throws ValidationError listing every schema issue. */
export function parsePlan(raw: unknown, options: PlanLoadOptions = {}): TestPlan {
  const parsed = TestPlanSchema.safeParse(applyEnvTarget(raw, options.env).raw);
  if (!parsed.success)
    throw new ValidationError("Test plan failed schema validation", formatZodIssues(parsed.error));
  return parsed.data;
}

export async function loadPlanFile(filePath: string, options: PlanLoadOptions = {}): Promise<LoadedPlan> {
  const rawText = await readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  const kind: "yaml" | "json" = ext === ".json" ? "json" : "yaml";
  const resolved = applyEnvTarget(parsePlanText(rawText, kind), options.env);
  const plan = parsePlan(resolved.raw, options);
  return {
    plan,
    rawText,
    targetSource: resolved.targetSource,
    source: { kind, path: filePath, sha256: sha256(rawText) },
  };
}

/** Serializes a plan to YAML with a stable key order matching the schema. */
export function serializePlanYaml(plan: TestPlan): string {
  const doc = new YAML.Document(plan);
  return `# BrowserSwarm test plan. Edit freely: any change requires a fresh execution plan and approval.\n${doc.toString({ lineWidth: 0 })}`;
}
