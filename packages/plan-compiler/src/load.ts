import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  formatZodIssues,
  TestPlanSchema,
  ValidationError,
  type PlanSource,
  type TestPlan,
} from "@browserswarm/core";
import { sha256 } from "@browserswarm/shared";
import YAML from "yaml";

export interface LoadedPlan {
  plan: TestPlan;
  source: PlanSource;
  rawText: string;
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
export function parsePlan(raw: unknown): TestPlan {
  const parsed = TestPlanSchema.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError("Test plan failed schema validation", formatZodIssues(parsed.error));
  return parsed.data;
}

export async function loadPlanFile(filePath: string): Promise<LoadedPlan> {
  const rawText = await readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  const kind: "yaml" | "json" = ext === ".json" ? "json" : "yaml";
  const plan = parsePlan(parsePlanText(rawText, kind));
  return { plan, rawText, source: { kind, path: filePath, sha256: sha256(rawText) } };
}

/** Serializes a plan to YAML with a stable key order matching the schema. */
export function serializePlanYaml(plan: TestPlan): string {
  const doc = new YAML.Document(plan);
  return `# BrowserSwarm test plan. Edit freely: any change requires a fresh execution plan and approval.\n${doc.toString({ lineWidth: 0 })}`;
}
