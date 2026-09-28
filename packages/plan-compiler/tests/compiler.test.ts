import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TestPlanSchema, ValidationError } from "@browserswarm/core";
import { MockLLMClient } from "@browserswarm/opencode-adapter";
import { fixturePlan } from "@browserswarm/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  compilePrompt,
  compilePromptWithLlm,
  loadPlanFile,
  parsePlan,
  parseStepLine,
  serializePlanYaml,
  validatePlan,
} from "../src/index.js";

const PROMPT = `# Login smoke
Allowed domains: staging.example.com

## Test data
- validEmail: qa+{{runId}}@example.test
- invalidPassword (secret): InvalidPassword123!

## Scenario: Invalid password shows an error
Objective: Verify failed login handling without successful login.
Priority: high
Roles: functional, accessibility
Viewports: desktop, mobile
Expected: User remains on /login and sees an invalid-credentials alert.
Steps:
1. Navigate to /login
2. Verify heading "Sign in" is visible
3. Fill "Email" field with {{testData.validEmail}}
4. Fill "Password" field with {{testData.invalidPassword}}
5. Click button "Sign in"
6. Verify URL contains /login
7. Verify alert contains "Invalid email or password"
8. Do a quick exploratory sweep of the admin area
9. Take screenshot invalid-password-error

## Restrictions
- Do not create accounts.
- Allow purchases if needed.
`;

describe("prompt compiler (deterministic)", () => {
  const result = compilePrompt({ promptText: PROMPT, url: "https://staging.example.com" });

  it("preserves scope, steps, expectations and restrictions", () => {
    const sc = result.plan.scenarios;
    expect(sc).toHaveLength(1);
    expect(sc[0]!.title).toBe("Invalid password shows an error");
    expect(sc[0]!.roles).toEqual(["functional", "accessibility"]);
    expect(sc[0]!.viewports).toEqual(["desktop", "mobile"]);
    expect(sc[0]!.expectedOutcome).toMatch(/remains on \/login/);
    expect(sc[0]!.steps.map((s) => s.action)).toEqual([
      "navigate",
      "assert_visible",
      "fill",
      "fill",
      "click",
      "assert_url_contains",
      "assert_text_contains",
      "screenshot",
    ]);
    expect(result.restrictions.join()).toMatch(/Do not create accounts/);
    expect(result.plan.target.allowedDomains).toEqual(["staging.example.com"]);
  });

  it("never invents: unknown steps become ambiguities, risky permissions are not granted", () => {
    expect(result.droppedSteps.join()).toMatch(/exploratory sweep/);
    expect(result.ambiguities.join()).toMatch(/never grants risky permissions/);
    expect(result.plan.safety.allowPurchases).toBe(false);
    expect(result.plan.safety.allowAccountCreation).toBe(false);
    expect(result.plan.compilation?.needsReview).toBe(true);
    expect(
      result.plan.scenarios
        .flatMap((s) => s.steps)
        .some((s) => s.action === "navigate" && s.url.includes("admin")),
    ).toBe(false);
  });

  it("marks secrets and records assumptions", () => {
    const pw = result.plan.testData.invalidPassword;
    expect(typeof pw === "object" && pw.secret).toBe(true);
    const noDomains = compilePrompt({
      promptText: PROMPT.replace(/Allowed domains:.*\n/, ""),
      url: "https://x.example.com",
    });
    expect(noDomains.assumptions.join()).toMatch(/allowedDomains defaulted/);
    expect(noDomains.plan.target.allowedDomains).toEqual(["x.example.com"]);
  });

  it("produces a schema-valid, policy-valid plan that round-trips through YAML", async () => {
    expect(validatePlan(result.plan).valid).toBe(true);
    const dir = await mkdtemp(path.join(tmpdir(), "bs-plan-"));
    const file = path.join(dir, "plan.yaml");
    await writeFile(file, serializePlanYaml(result.plan));
    const loaded = await loadPlanFile(file);
    expect(loaded.plan).toEqual(result.plan);
  });

  it("refuses prompts with no understandable scenarios", () => {
    expect(() =>
      compilePrompt({ promptText: "please test my site thoroughly", url: "https://a.example.com" }),
    ).toThrow(/No scenarios/);
  });

  it("parses the documented step grammar", () => {
    expect(parseStepLine('Click the link "Pricing"')).toEqual({
      action: "click",
      locator: { role: "link", name: "Pricing" },
    });
    expect(parseStepLine('Select "yearly" in "Billing period" dropdown')).toEqual({
      action: "select_option",
      locator: { label: "Billing period" },
      value: "yearly",
    });
    expect(parseStepLine("Verify there are no console errors")).toEqual({
      action: "assert_no_console_errors",
    });
    expect(parseStepLine("Press Enter")).toEqual({ action: "press_key", key: "Enter" });
    expect(parseStepLine("Hack the mainframe")).toBeUndefined();
  });
});

describe("LLM-assisted compiler (mock)", () => {
  it("validates model output, never passes test-data values to the model, and forces review", async () => {
    const client = new MockLLMClient({
      responses: [
        { kind: "malformed" },
        {
          kind: "json",
          value: {
            name: "Login smoke",
            scenarios: [
              {
                id: "login",
                title: "Login error",
                objective: "Verify failed login",
                roles: ["functional"],
                viewports: ["desktop"],
                expectedOutcome: "Alert shown",
                steps: [{ action: "navigate", url: "/login" }],
              },
            ],
            testDataKeys: ["validEmail", "ghost"],
            ambiguities: [],
          },
        },
      ],
    });
    const res = await compilePromptWithLlm({
      promptText: PROMPT,
      url: "https://staging.example.com",
      client,
    });
    expect(client.callCount).toBe(2);
    expect(client.calls.map((c) => c.prompt).join()).not.toMatch(/InvalidPassword123!/);
    expect(res.plan.compilation?.compiler).toBe("llm");
    expect(res.plan.compilation?.needsReview).toBe(true);
    expect(res.plan.safety.allowPurchases).toBe(false);
    expect(res.ambiguities.join()).toMatch(/ghost/);
  });
});

describe("plan loading and validation", () => {
  it("reports every schema issue", () => {
    expect(() => parsePlan({ version: 1 })).toThrow(ValidationError);
  });

  it("detects unknown viewports, template references and budget overruns", () => {
    const raw = fixturePlan({ url: "https://staging.example.com", viewports: ["tablet"] }) as Record<
      string,
      unknown
    >;
    const scen = (raw.scenarios as { steps: Record<string, unknown>[] }[])[0]!;
    scen.steps.push({ action: "fill", locator: { label: "X" }, value: "{{testData.missing}}" });
    const report = validatePlan(TestPlanSchema.parse({ ...raw, execution: { maxActionsPerAgent: 3 } }));
    expect(report.valid).toBe(false);
    expect(report.errors.join("\n")).toMatch(/unknown viewport "tablet"/);
    expect(report.errors.join("\n")).toMatch(/testData\.missing/);
    expect(report.errors.join("\n")).toMatch(/exceed execution.maxActionsPerAgent/);
  });
});

describe("central target website from .env", () => {
  const withoutTarget = () => {
    const raw = fixturePlan({ url: "https://ignored.example.com" }) as Record<string, unknown>;
    delete raw.target;
    return raw;
  };

  it("fills target.url and allowedDomains from BROWSERSWARM_TARGET_URL when the plan omits them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bs-envplan-"));
    const file = path.join(dir, "plan.json");
    await writeFile(file, JSON.stringify(withoutTarget()));
    const loaded = await loadPlanFile(file, {
      env: { BROWSERSWARM_TARGET_URL: "https://staging.example.com" },
    });
    expect(loaded.targetSource).toBe("env");
    expect(loaded.plan.target).toEqual({
      url: "https://staging.example.com",
      allowedDomains: ["staging.example.com"],
      allowSubdomains: false,
    });
  });

  it("uses BROWSERSWARM_ALLOWED_DOMAINS when set", () => {
    const plan = parsePlan(withoutTarget(), {
      env: {
        BROWSERSWARM_TARGET_URL: "https://app.example.com",
        BROWSERSWARM_ALLOWED_DOMAINS: "app.example.com,cdn.example.com",
      },
    });
    expect(plan.target.allowedDomains).toEqual(["app.example.com", "cdn.example.com"]);
  });

  it("an explicit target.url in the plan wins over .env", async () => {
    const loaded = parsePlan(fixturePlan({ url: "https://explicit.example.com" }), {
      env: { BROWSERSWARM_TARGET_URL: "https://staging.example.com" },
    });
    expect(loaded.target.url).toBe("https://explicit.example.com");
  });

  it("fails clearly when neither the plan nor .env names a website", () => {
    expect(() => parsePlan(withoutTarget(), { env: {} })).toThrow(/No target website configured/);
  });

  it("changing the .env URL changes the plan hash, so prior approvals are invalidated", () => {
    const a = parsePlan(withoutTarget(), { env: { BROWSERSWARM_TARGET_URL: "https://a.example.com" } });
    const b = parsePlan(withoutTarget(), { env: { BROWSERSWARM_TARGET_URL: "https://b.example.com" } });
    expect(validatePlan(a).planHash).not.toBe(validatePlan(b).planHash);
  });
});
