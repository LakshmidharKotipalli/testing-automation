import { computePlanHash, type RiskFlag, type TestPlan } from "@browserswarm/core";
import { evaluatePlanPolicy, findTemplateReferences } from "@browserswarm/policy-engine";

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  riskFlags: RiskFlag[];
  planHash: string;
}

/**
 * Semantic validation beyond the schema: cross references, budgets, template references and the
 * plan-time safety policy. A plan with any error cannot produce an execution plan.
 */
export function validatePlan(plan: TestPlan): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (plan.browser.engine !== "chromium")
    errors.push("MCP execution supports Chrome and Chromium only; Firefox and WebKit are not supported");
  if (plan.browserProjects) {
    const names = new Set<string>();
    for (const p of plan.browserProjects) {
      if (names.has(p.name)) errors.push(`duplicate browser project: ${p.name}`);
      names.add(p.name);
    }
  }
  if (plan.verification?.enabled && plan.mode === "agentic") {
    const model = plan.models.overrides.verifier ?? plan.models.default;
    if (!model || !["openrouter", "opencode-agent", "mock"].includes(model.provider))
      errors.push(
        "verification in agentic mode requires an openrouter, opencode-agent or mock verifier model",
      );
  }
  if (plan.scenarios.some((s) => s.roles.includes("verifier")))
    errors.push(
      'the "verifier" role is reserved for reserved verifier packets and cannot be a scenario role',
    );
  if (plan.mode === "agentic" && plan.llm.strategy === "fallback-only")
    errors.push("agentic mode requires guided LLM policy");
  const ids = new Set<string>();
  for (const scenario of plan.scenarios) {
    if (ids.has(scenario.id)) errors.push(`duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (plan.mode !== "agentic" && scenario.steps.length === 0)
      errors.push(`scenario ${scenario.id}: scripted mode requires steps`);
    if (plan.mode === "agentic") {
      for (const role of scenario.roles) {
        const model = plan.models.overrides[role] ?? plan.models.default;
        if (!model || !["openrouter", "opencode-agent", "mock"].includes(model.provider))
          errors.push(
            `scenario ${scenario.id}: agentic execution requires openrouter, opencode-agent or mock model for ${role}`,
          );
      }
    }
    for (const vp of scenario.viewports) {
      if (!plan.viewports[vp]) errors.push(`scenario ${scenario.id}: unknown viewport "${vp}"`);
    }
    if (new Set(scenario.roles).size !== scenario.roles.length)
      errors.push(`scenario ${scenario.id}: duplicate roles`);
    if (new Set(scenario.viewports).size !== scenario.viewports.length) {
      errors.push(`scenario ${scenario.id}: duplicate viewports`);
    }
    if (scenario.steps.length > plan.execution.maxActionsPerAgent) {
      errors.push(
        `scenario ${scenario.id}: ${scenario.steps.length} steps exceed execution.maxActionsPerAgent (${plan.execution.maxActionsPerAgent})`,
      );
    }
    scenario.steps.forEach((step, i) => {
      for (const value of Object.values(step)) {
        if (typeof value !== "string") continue;
        for (const ref of findTemplateReferences(value)) {
          if (!(ref in plan.testData))
            errors.push(`scenario ${scenario.id} step ${i}: unknown test data {{testData.${ref}}}`);
        }
      }
      if (
        step.action === "fill" &&
        !step.value.includes("{{") &&
        /password|token|secret/i.test(JSON.stringify(step.locator))
      ) {
        warnings.push(
          `scenario ${scenario.id} step ${i}: literal value in a sensitive field; use {{testData.*}} so it is redacted`,
        );
      }
    });
    if (!scenario.steps.some((s) => s.action.startsWith("assert_"))) {
      warnings.push(
        `scenario ${scenario.id}: no assertions; the expected outcome cannot be verified deterministically`,
      );
    }
  }

  if (plan.llm.strategy !== "disabled") {
    const anyModel = plan.models.default || Object.keys(plan.models.overrides).length > 0;
    if (!anyModel) errors.push("llm.strategy is enabled but no models are configured");
    if (plan.llm.allowedTriggers.length === 0)
      warnings.push("llm.strategy is enabled but llm.allowedTriggers is empty");
  }
  if (plan.contextLifecycle.enabled && plan.contextLifecycle.maxActionsPerAgentInstance === undefined) {
    warnings.push(
      "contextLifecycle.maxActionsPerAgentInstance is unset: planned rotation relies on token usage only",
    );
  }

  const policy = evaluatePlanPolicy(plan);
  errors.push(...policy.errors);
  warnings.push(...policy.warnings);
  if (plan.compilation?.needsReview) {
    warnings.push(
      "plan was compiled from natural language and is marked needsReview; review ambiguities before approval",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    riskFlags: policy.riskFlags,
    planHash: computePlanHash(plan),
  };
}
