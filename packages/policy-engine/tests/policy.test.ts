import { computeWorkPacketHash, TestPlanSchema, type TestStep, type WorkPacket } from "@browserswarm/core";
import { fixturePlan } from "@browserswarm/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  buildTestDataRedactor,
  checkAction,
  checkLlmProposal,
  checkUrl,
  classifyStep,
  evaluatePlanPolicy,
  resolveTemplate,
  resolveTestData,
} from "../src/index.js";

const plan = () => TestPlanSchema.parse(fixturePlan({ url: "https://staging.example.com" }));

function packetFrom(steps: TestStep[], overrides: Partial<WorkPacket> = {}): WorkPacket {
  const p = plan();
  const packet: Omit<WorkPacket, "workPacketHash"> = {
    version: 1,
    packetId: "p1",
    runId: "run-1",
    planId: p.id,
    scenarioId: "s1",
    scenarioTitle: "S1",
    objective: "o",
    priority: "high",
    role: "functional",
    viewportName: "desktop",
    viewport: { width: 1280, height: 800 },
    browser: p.browser,
    targetUrl: p.target.url,
    allowedDomains: p.target.allowedDomains,
    allowSubdomains: false,
    steps,
    expectedOutcome: "e",
    mode: "deterministic",
    model: null,
    llmPolicy: p.llm,
    contextPolicy: p.contextLifecycle,
    safety: p.safety,
    timeoutMs: 60_000,
    actionBudget: 40,
    llmCallBudget: 0,
    artifactDir: "packets/p1",
    planHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    riskFlags: [],
    requiresExplicitRiskApproval: false,
    ...overrides,
  };
  return { ...packet, workPacketHash: computeWorkPacketHash(packet) };
}

describe("domain enforcement", () => {
  const scope = { allowedDomains: ["staging.example.com"], allowSubdomains: false };
  it("allows the target and relative URLs, blocks others", () => {
    expect(checkUrl("/login", "https://staging.example.com", scope).allowed).toBe(true);
    expect(checkUrl("https://staging.example.com:8443/x", "https://staging.example.com", scope).allowed).toBe(
      true,
    );
    expect(checkUrl("https://evil.example.org/", "https://staging.example.com", scope).allowed).toBe(false);
    expect(checkUrl("https://api.staging.example.com/", "https://staging.example.com", scope).allowed).toBe(
      false,
    );
    expect(
      checkUrl("https://staging.example.com.evil.org/", "https://staging.example.com", scope).allowed,
    ).toBe(false);
    expect(checkUrl("javascript:alert(1)", "https://staging.example.com", scope).allowed).toBe(false);
    expect(checkUrl("file:///etc/passwd", "https://staging.example.com", scope).allowed).toBe(false);
    expect(
      checkUrl("https://user:pw@staging.example.com/", "https://staging.example.com", scope).allowed,
    ).toBe(false);
  });
  it("subdomains only when explicitly allowed", () => {
    expect(
      checkUrl("https://api.staging.example.com/", "https://staging.example.com", {
        ...scope,
        allowSubdomains: true,
      }).allowed,
    ).toBe(true);
  });
});

describe("risk classification and plan policy", () => {
  it("blocks destructive and risky steps by default", () => {
    const ctx = {
      allowedDomains: ["staging.example.com"],
      allowSubdomains: false,
      scenarioId: "s",
      targetUrl: "https://staging.example.com",
      safety: plan().safety,
    };
    const cases: [TestStep, string][] = [
      [{ action: "click", locator: { role: "button", name: "Delete account" } }, "deletion"],
      [{ action: "click", locator: { role: "button", name: "Place order" } }, "purchase"],
      [{ action: "click", locator: { role: "button", name: "Pay now" } }, "payment"],
      [{ action: "click", locator: { role: "button", name: "Create account" } }, "account_creation"],
      [{ action: "click", locator: { testId: "upload-avatar" } }, "file_upload"],
      [{ action: "click", locator: { role: "button", name: "Send invitation" } }, "invitation"],
      [{ action: "click", locator: { role: "button", name: "Change password" } }, "password_change"],
      [{ action: "navigate", url: "https://other.example.org" }, "external_navigation"],
    ];
    for (const [step, category] of cases) {
      const flags = classifyStep(step, 0, ctx);
      expect(flags.map((f) => f.category)).toContain(category);
      expect(flags.every((f) => !f.allowedByPolicy)).toBe(true);
    }
    expect(
      classifyStep({ action: "click", locator: { role: "button", name: "Sign in" } }, 0, ctx),
    ).toHaveLength(0);
  });

  it("a risky step makes the plan invalid unless policy explicitly allows it", () => {
    const raw = fixturePlan({ url: "https://staging.example.com" }) as { scenarios: { steps: unknown[] }[] };
    raw.scenarios[0]!.steps.push({ action: "click", locator: { role: "button", name: "Delete account" } });
    expect(evaluatePlanPolicy(TestPlanSchema.parse(raw)).errors.join()).toMatch(/deletion/);

    const allowed = TestPlanSchema.parse({ ...raw, safety: { destructiveActions: "allow-with-approval" } });
    const res = evaluatePlanPolicy(allowed);
    expect(res.errors).toHaveLength(0);
    expect(res.riskFlags.some((f) => f.category === "deletion" && f.allowedByPolicy)).toBe(true);
  });

  it("allowExternalNavigation cannot be enabled", () => {
    const p = TestPlanSchema.parse({
      ...fixturePlan({ url: "https://staging.example.com" }),
      safety: { allowExternalNavigation: true },
    });
    expect(evaluatePlanPolicy(p).errors.join()).toMatch(/allowExternalNavigation/);
  });
});

describe("runtime action checks", () => {
  const steps: TestStep[] = [
    { action: "navigate", url: "/login" },
    { action: "click", locator: { role: "button", name: "Delete account" } },
  ];

  it("allows approved safe steps and blocks unapproved/modified ones", () => {
    const packet = packetFrom(steps);
    expect(checkAction(steps[0]!, 0, { packet, currentUrl: undefined, riskApproved: false }).allowed).toBe(
      true,
    );
    expect(
      checkAction({ action: "navigate", url: "/admin" }, 0, {
        packet,
        currentUrl: undefined,
        riskApproved: false,
      }).allowed,
    ).toBe(false);
    expect(checkAction(steps[0]!, 5, { packet, currentUrl: undefined, riskApproved: false }).allowed).toBe(
      false,
    );
  });

  it("blocks when the current page is out of scope", () => {
    const packet = packetFrom(steps);
    const d = checkAction(steps[0]!, 0, {
      packet,
      currentUrl: "https://evil.example.org/",
      riskApproved: false,
    });
    expect(d.allowed).toBe(false);
  });

  it("risky steps need policy permission AND approved risk flags AND risk approval", () => {
    const denied = packetFrom(steps);
    expect(
      checkAction(steps[1]!, 1, { packet: denied, currentUrl: undefined, riskApproved: true }).allowed,
    ).toBe(false);

    const safety = { ...plan().safety, destructiveActions: "allow-with-approval" as const };
    const flag = {
      scenarioId: "s1",
      stepIndex: 1,
      action: "click",
      category: "deletion" as const,
      reason: "r",
      allowedByPolicy: true,
    };
    const permitted = packetFrom(steps, { safety, riskFlags: [flag], requiresExplicitRiskApproval: true });
    expect(
      checkAction(steps[1]!, 1, { packet: permitted, currentUrl: undefined, riskApproved: false }).allowed,
    ).toBe(false);
    expect(
      checkAction(steps[1]!, 1, { packet: permitted, currentUrl: undefined, riskApproved: true }).allowed,
    ).toBe(true);
  });

  it("LLM proposals may only change the locator of the approved step", () => {
    const s: TestStep[] = [{ action: "fill", locator: { label: "Email" }, value: "{{testData.validEmail}}" }];
    const packet = packetFrom(s);
    const ctx = { packet, currentUrl: undefined, riskApproved: false };
    expect(
      checkLlmProposal(
        { action: "fill", locator: { placeholder: "you@example.com" }, value: "{{testData.validEmail}}" },
        0,
        ctx,
      ).allowed,
    ).toBe(true);
    expect(
      checkLlmProposal({ action: "fill", locator: { label: "Email" }, value: "other" }, 0, ctx).allowed,
    ).toBe(false);
    expect(checkLlmProposal({ action: "click", locator: { label: "Email" } }, 0, ctx).allowed).toBe(false);
    const nav: TestStep[] = [{ action: "click", locator: { role: "button", name: "Continue" } }];
    const navPacket = packetFrom(nav);
    expect(
      checkLlmProposal({ action: "click", locator: { role: "button", name: "Delete account" } }, 0, {
        ...ctx,
        packet: navPacket,
      }).allowed,
    ).toBe(false);
  });
});

describe("test data resolution and redaction", () => {
  it("resolves templates, env references and redacts every value", () => {
    const resolved = resolveTestData(
      {
        email: "qa+{{runId}}@example.test",
        password: { value: "Pw123456!", secret: true },
        token: { fromEnv: "QA_TOKEN", secret: true },
      },
      "run-9",
      { QA_TOKEN: "tok-abcdef" },
    );
    expect(resolved.values.email).toBe("qa+run-9@example.test");
    expect([...resolved.secretKeys].sort()).toEqual(["password", "token"]);
    expect(resolveTemplate("{{testData.password}}", resolved, "run-9")).toBe("Pw123456!");
    const r = buildTestDataRedactor(resolved);
    expect(r.redactString("qa+run-9@example.test Pw123456! tok-abcdef")).not.toMatch(
      /example\.test|Pw123456|tok-abcdef/,
    );
  });

  it("fails loudly on missing env or unknown templates", () => {
    expect(() => resolveTestData({ t: { fromEnv: "MISSING_VAR" } }, "r", {})).toThrow(/MISSING_VAR/);
    expect(() => resolveTemplate("{{testData.nope}}", { values: {}, secretKeys: new Set() }, "r")).toThrow();
  });
});
