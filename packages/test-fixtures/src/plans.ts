/**
 * Plan builders for tests. They return plain objects (TestPlan input shape) so this package has no
 * runtime dependency on the schemas; tests parse them with TestPlanSchema.
 */
export interface FixturePlanOptions {
  url: string;
  roles?: string[];
  viewports?: string[];
  maxConcurrentAgents?: number;
  contextLifecycle?: Record<string, unknown>;
  extraScenarios?: Record<string, unknown>[];
  safety?: Record<string, unknown>;
}

export function loginScenario(
  roles: string[] = ["functional"],
  viewports: string[] = ["desktop"],
): Record<string, unknown> {
  return {
    id: "login-invalid-password",
    title: "Invalid password shows an accessible error",
    objective: "Verify failed login handling without successful login.",
    priority: "high",
    roles,
    viewports,
    expectedOutcome: "User remains on /login and receives an accessible invalid-credentials error.",
    steps: [
      { action: "navigate", url: "/login" },
      { action: "assert_visible", locator: { role: "heading", name: "Sign in" } },
      { action: "fill", locator: { label: "Email" }, value: "{{testData.validEmail}}" },
      { action: "fill", locator: { label: "Password" }, value: "{{testData.invalidPassword}}" },
      { action: "click", locator: { role: "button", name: "Sign in" } },
      { action: "assert_url_contains", value: "/login" },
      { action: "assert_visible", locator: { role: "alert" } },
      { action: "assert_text_contains", locator: { role: "alert" }, text: "Invalid email or password" },
      { action: "screenshot", name: "invalid-password-error" },
    ],
  };
}

export function pricingScenario(): Record<string, unknown> {
  return {
    id: "pricing-plans-visible",
    title: "Pricing page lists three plans",
    objective: "Verify the pricing page renders every plan.",
    priority: "medium",
    roles: ["functional"],
    viewports: ["desktop"],
    expectedOutcome: "Three plans are visible.",
    steps: [
      { action: "navigate", url: "/pricing" },
      { action: "assert_visible", locator: { role: "heading", name: "Pricing" } },
      { action: "assert_count", locator: { css: "article" }, count: 3 },
      { action: "assert_text_contains", locator: { testId: "plan-pro" }, text: "$20" },
      { action: "select_option", locator: { label: "Billing period" }, value: "yearly" },
    ],
  };
}

export function flowScenario(steps = 6): Record<string, unknown> {
  const s: Record<string, unknown>[] = [{ action: "navigate", url: "/flow/1" }];
  for (let i = 1; i < steps; i++) {
    s.push({ action: "fill", locator: { label: `Note ${i}` }, value: "{{testData.note}}" });
    s.push({ action: "click", locator: { role: "link", name: "Next step" } });
  }
  s.push({ action: "assert_visible", locator: { testId: "done" } });
  return {
    id: "long-flow",
    title: "Multi-step flow completes",
    objective: "Walk the multi-step flow to completion.",
    priority: "medium",
    roles: ["functional"],
    viewports: ["desktop"],
    expectedOutcome: "The final step shows Flow complete.",
    steps: s,
  };
}

export function fixturePlan(o: FixturePlanOptions): Record<string, unknown> {
  const host = new URL(o.url).hostname;
  return {
    version: 1,
    id: "fixture-smoke",
    name: "Fixture Smoke Suite",
    mode: "scripted",
    target: { url: o.url, allowedDomains: [host], allowSubdomains: false },
    browser: {
      engine: "chromium",
      headless: true,
      trace: false,
      screenshot: "only-on-failure",
      actionTimeoutMs: 3000,
    },
    execution: {
      maxConcurrentAgents: o.maxConcurrentAgents ?? 4,
      agentTimeoutMs: 60_000,
      runTimeoutMs: 300_000,
      maxActionsPerAgent: 40,
    },
    llm: { strategy: "disabled" },
    contextLifecycle: {
      enabled: true,
      checkpointAfterEveryStep: true,
      maxActionsPerAgentInstance: 30,
      ...(o.contextLifecycle ?? {}),
    },
    safety: { ...(o.safety ?? {}) },
    testData: {
      validEmail: "qa+{{runId}}@example.test",
      invalidPassword: { value: "InvalidPassword123!", secret: true },
      note: "fixture note value",
    },
    viewports: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } },
    scenarios: [loginScenario(o.roles, o.viewports), ...(o.extraScenarios ?? [])],
    reporting: { formats: ["json", "markdown"], verifySeverityAtOrAbove: "high" },
  };
}
