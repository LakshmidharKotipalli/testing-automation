import { readFile } from "node:fs/promises";
import path from "node:path";
import { TestPlanSchema, type TestPlan, type ModelRef } from "@browserswarm/core";
import { parsePlanText } from "@browserswarm/plan-compiler";
export interface ModelOptions {
  provider?: string;
  model?: string;
  headed?: boolean;
  persistentProfile?: boolean;
  modelProfile?: string;
}
export async function applyModelOptions(
  plan: TestPlan,
  opts: ModelOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<TestPlan> {
  let preset: Partial<TestPlan> = {};
  if (opts.modelProfile) {
    const config = parsePlanText(
      await readFile(path.join(cwd, "browserswarm.config.yaml"), "utf8"),
      "yaml",
    ) as { profiles?: Record<string, Partial<TestPlan>> };
    preset =
      config.profiles?.[opts.modelProfile] ??
      (() => {
        throw new Error(`Unknown model profile: ${opts.modelProfile}`);
      })();
  }
  const provider = opts.provider ?? env.BROWSERSWARM_LLM_PROVIDER;
  if (provider && !["openrouter", "opencode"].includes(provider))
    throw new Error("--provider must be openrouter or opencode");
  const existing = preset.models?.default ?? plan.models.default;
  const modelName = opts.model ?? existing?.model ?? env.BROWSERSWARM_LLM_MODEL;
  const selectedProvider = provider
    ? provider === "opencode"
      ? "opencode-agent"
      : "openrouter"
    : existing?.provider;
  const model: ModelRef | undefined =
    modelName && selectedProvider
      ? {
          ...existing,
          provider: selectedProvider,
          model: modelName,
          ...(env.BROWSERSWARM_LLM_BASE_URL ? { baseUrl: env.BROWSERSWARM_LLM_BASE_URL } : {}),
        }
      : existing;
  if ((provider || opts.model) && !model)
    throw new Error("A provider and model are required for agentic execution");
  return TestPlanSchema.parse({
    ...plan,
    ...preset,
    ...(model && (provider || opts.model || opts.modelProfile || plan.mode === "agentic")
      ? {
          mode: "agentic",
          models: { ...plan.models, ...preset.models, default: model },
          llm: { ...plan.llm, ...preset.llm, strategy: "guided" },
        }
      : {}),
    browser: {
      ...plan.browser,
      ...preset.browser,
      ...(env.BROWSERSWARM_BROWSER_CHANNEL ? { channel: env.BROWSERSWARM_BROWSER_CHANNEL } : {}),
      ...(opts.headed ? { headless: false } : {}),
      ...(opts.persistentProfile ? { persistentProfile: true } : {}),
    },
  });
}
