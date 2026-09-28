import type { TestData } from "@browserswarm/core";
import { createRedactor, SENSITIVE_KEY_PATTERN, type Redactor, type SecretValue } from "@browserswarm/shared";

export interface ResolvedTestData {
  values: Record<string, string>;
  /** Keys whose values are treated as secrets (declared secret or sensitive-looking key). */
  secretKeys: Set<string>;
}

/** Resolves test data for a run, substituting {{runId}}. Values never enter plans, packets or handoffs. */
export function resolveTestData(
  testData: TestData,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTestData {
  const values: Record<string, string> = {};
  const secretKeys = new Set<string>();
  const missing: string[] = [];
  for (const [key, raw] of Object.entries(testData)) {
    let value: string | undefined;
    if (typeof raw === "string") value = raw;
    else if (raw.fromEnv !== undefined) value = env[raw.fromEnv];
    else value = raw.value;
    if (value === undefined) {
      missing.push(`${key} (env ${typeof raw === "string" ? "" : raw.fromEnv})`);
      continue;
    }
    const declaredSecret = typeof raw === "string" ? false : raw.secret || raw.fromEnv !== undefined;
    values[key] = value.replace(/\{\{\s*runId\s*\}\}/g, runId);
    if (declaredSecret || SENSITIVE_KEY_PATTERN.test(key)) secretKeys.add(key);
  }
  if (missing.length) throw new Error(`test data could not be resolved: ${missing.join(", ")}`);
  return { values, secretKeys };
}

/** Literal (non-env) test data value, used only where a value is known at authoring time. */
export function literalTestDataValue(raw: TestData[string]): string | undefined {
  return typeof raw === "string" ? raw : raw.value;
}

/**
 * Every resolved test-data value is redacted in handoffs, model context, ledgers and reports: secrets as
 * `[REDACTED:testData.key]`, other test data likewise (test data is often personal data such as emails).
 */
export function buildTestDataRedactor(resolved: ResolvedTestData, extra: SecretValue[] = []): Redactor {
  const secrets: SecretValue[] = Object.entries(resolved.values).map(([key, value]) => ({
    label: `testData.${key}`,
    value,
  }));
  return createRedactor([...secrets, ...extra]);
}

/** Replaces {{testData.key}} and {{runId}} templates in a single step value. */
export function resolveTemplate(value: string, resolved: ResolvedTestData, runId: string): string {
  return value
    .replace(/\{\{\s*testData\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (match, key: string) => {
      const v = resolved.values[key];
      if (v === undefined) throw new Error(`unknown test data reference ${match}`);
      return v;
    })
    .replace(/\{\{\s*runId\s*\}\}/g, runId);
}

export function findTemplateReferences(value: string): string[] {
  return [...value.matchAll(/\{\{\s*testData\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1] as string);
}
