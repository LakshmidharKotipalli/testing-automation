import {
  applyScopeExclusions,
  AutonomousTestPlanGenerator,
  renderAutonomousReview,
  validatePlanAgainstProfile,
} from "@browserswarm/autonomous-planner";
import { buildApprovedExecutionPlan, recordDecision, verifyApprovedPlan } from "@browserswarm/approval";
import {
  computePlanHash,
  computeProfileHash,
  TestPlanSchema,
  WebsiteUnderstandingProfileSchema,
  type WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import { classifyStep } from "@browserswarm/policy-engine";
import { FakeClock } from "@browserswarm/shared";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWebsiteUnderstandingProfile,
  renderDiscoveryReportMarkdown,
  renderRouteMapMermaid,
  buildDiscoveryReport,
} from "../src/index.js";
import { observation, syntheticProfile, syntheticShop, TARGET } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Website Understanding Profile", () => {
  it("is schema-valid, hash-bound and evidence-backed", async () => {
    const p = await syntheticProfile();
    expect(WebsiteUnderstandingProfileSchema.safeParse(p).success).toBe(true);
    expect(computeProfileHash(p)).toBe(p.profileHash);
    expect(p.applicationClassification.primaryCategory).toBe("ecommerce");
    expect(p.applicationClassification.evidence.length).toBeGreaterThan(0);
    for (const r of p.recommendedTestStrategy.recommendedAgentRoles)
      expect(r.evidence.length).toBeGreaterThan(0);
    for (const s of p.recommendedTestStrategy.recommendedScenarios)
      expect(s.evidence.length).toBeGreaterThan(0);
    expect(p.accessModel.authenticationObserved).toBe(true);
    expect(p.domainModel.domainRulesObserved[0]?.assertion?.value).toBe("2");
    expect(p.domainModel.relationships.some((r) => r.kind === "list-detail" && r.from === "/products")).toBe(
      true,
    );
    expect(p.uiInventory.sideEffectingControls.map((c) => c.label)).toEqual(
      expect.arrayContaining(["Add to cart", "Delete product"]),
    );
    expect(p.uiInventory.uploads).toHaveLength(1);
    expect(p.qualitySurface.console.errorCount).toBe(1);
    // Facts vs. hypotheses: inferences are listed as assumptions.
    expect(p.assumptions.some((a) => /heuristic inference/.test(a))).toBe(true);
  });

  it("rejects recommendations without evidence and scenarios on undiscovered routes", async () => {
    const p = await syntheticProfile();
    const noEvidence = structuredClone(p) as WebsiteUnderstandingProfile;
    noEvidence.recommendedTestStrategy.recommendedAgentRoles[0]!.evidence = [];
    expect(WebsiteUnderstandingProfileSchema.safeParse(noEvidence).success).toBe(false);
    const invented = structuredClone(p) as WebsiteUnderstandingProfile;
    invented.recommendedTestStrategy.recommendedScenarios[0]!.routes = ["/checkout"];
    expect(WebsiteUnderstandingProfileSchema.safeParse(invented).success).toBe(false);
  });

  it("keeps an unclassifiable site as unknown instead of guessing", async () => {
    const r = syntheticShop();
    r.observations = [observation("/", 0, { title: "Welcome", headings: [{ level: 1, text: "Welcome" }] })];
    r.discovered = [
      { path: "/", url: `${TARGET}/`, depth: 0, label: "Welcome", visited: true, authPage: false },
    ];
    r.edges = [];
    r.restricted = [];
    r.externalLinks = [];
    const p = await buildWebsiteUnderstandingProfile(r, { clock: new FakeClock() });
    expect(p.applicationClassification.primaryCategory).toBe("unknown");
    expect(p.applicationClassification.confidence).toBe(0);
    expect(p.assumptions.join(" ")).toMatch(/could not be determined/);
  });

  it("renders the discovery report and Mermaid route map", async () => {
    const p = await syntheticProfile();
    const md = renderDiscoveryReportMarkdown(p, buildDiscoveryReport(p, syntheticShop(), new FakeClock()));
    for (const h of [
      "## 1. What the website appears to be",
      "## 8. State-changing controls",
      "## 14. Limitations",
    ])
      expect(md).toContain(h);
    expect(renderRouteMapMermaid(p)).toMatch(/^flowchart LR/);
  });
});

describe("AutonomousTestPlanGenerator", () => {
  it("plans only safe, evidence-backed scenarios on discovered routes", async () => {
    const profile = await syntheticProfile();
    const { testPlan, executionPlan } = new AutonomousTestPlanGenerator().generate({
      profile,
      runId: "run-plan",
    });
    const known = new Set(profile.routeGraph.routes.map((r) => r.path));
    expect(testPlan.origin).toMatchObject({ mode: "autonomous", profileHash: profile.profileHash });
    expect(executionPlan.origin).toMatchObject({
      profileHash: profile.profileHash,
      testPlanHash: executionPlan.planHash,
    });
    expect(executionPlan.riskFlags).toHaveLength(0);
    expect(executionPlan.requiresExplicitRiskApproval).toBe(false);
    for (const s of testPlan.scenarios) {
      expect(s.safetyClass).toBe("safe-read-only");
      expect(s.evidence?.length).toBeGreaterThan(0);
      for (const r of s.routes ?? []) expect(known.has(r)).toBe(true);
      s.steps.forEach((step, i) =>
        expect(
          classifyStep(step, i, {
            scenarioId: s.id,
            targetUrl: TARGET,
            safety: testPlan.safety,
            allowedDomains: testPlan.target.allowedDomains,
            allowSubdomains: false,
          }),
        ).toHaveLength(0),
      );
      // Never submits, types or checks out.
      expect(
        s.steps.some((x) => x.action === "fill" || x.action === "check" || x.action === "select_option"),
      ).toBe(false);
    }
    expect(validatePlanAgainstProfile(testPlan, profile)).toEqual([]);
    const roles = new Set(testPlan.scenarios.flatMap((s) => s.roles));
    for (const r of [
      "navigation",
      "ecommerce-browse-only",
      "table-data",
      "search-filter",
      "accessibility",
      "responsive",
      "console-network",
      "domain-consistency",
      "functional-ui",
    ])
      expect(roles.has(r as never)).toBe(true);
    // No sign-in or checkout flow is invented (the login page may be visited, never submitted); such areas
    // are deferred or excluded instead.
    expect(testPlan.scenarios.some((s) => /checkout|cart/i.test(s.id))).toBe(false);
    for (const s of testPlan.scenarios.filter((x) => (x.routes ?? []).includes("/login")))
      expect(s.steps.every((x) => x.action !== "fill" && x.action !== "press_key")).toBe(true);
    expect(testPlan.deferredScenarios?.some((d) => d.safetyClass === "requires-credentials")).toBe(true);
    expect(testPlan.deferredScenarios?.some((d) => d.safetyClass === "requires-risk-approval")).toBe(true);
    expect(testPlan.excludedScenarios?.some((e) => /security/i.test(e.title))).toBe(true);
    expect(testPlan.excludedScenarios?.some((e) => /Logged-in/.test(e.title))).toBe(true);
  });

  it("does not schedule a forms agent when no forms were discovered", async () => {
    const r = syntheticShop();
    for (const o of r.observations) if (o.extract) o.extract.forms = [];
    for (const o of r.observations) o.searchExercises = [];
    const profile = await buildWebsiteUnderstandingProfile(r, { clock: new FakeClock() });
    const { testPlan } = new AutonomousTestPlanGenerator().generate({ profile });
    const roles = new Set(testPlan.scenarios.flatMap((s) => s.roles));
    expect(roles.has("forms-read-only")).toBe(false);
    expect(roles.has("search-filter")).toBe(false);
  });

  it("applies user scope: exclusions and only-roles change the plan hash", async () => {
    const profile = await syntheticProfile();
    const gen = new AutonomousTestPlanGenerator();
    const base = gen.generate({ profile, runId: "run-a" });
    const scoped = gen.generate({
      profile,
      runId: "run-a",
      selection: { excludeRoles: ["responsive"], excludeRoutes: ["/products"] },
    });
    expect(scoped.testPlan.scenarios.some((s) => s.roles.includes("responsive"))).toBe(false);
    expect(
      scoped.testPlan.scenarios.some((s) => (s.routes ?? []).some((r) => r.startsWith("/products"))),
    ).toBe(false);
    expect(scoped.executionPlan.planHash).not.toBe(base.executionPlan.planHash);
    expect(scoped.testPlan.excludedScenarios?.some((e) => /excluded by user/.test(e.reason))).toBe(true);
    const only = gen.generate({ profile, selection: { onlyRoles: ["accessibility"] } });
    expect(new Set(only.testPlan.scenarios.flatMap((s) => s.roles))).toEqual(new Set(["accessibility"]));
  });

  it("edits invalidate approval; approval is bound to the discovery profile", async () => {
    const profile = await syntheticProfile();
    const { testPlan, executionPlan } = new AutonomousTestPlanGenerator().generate({
      profile,
      runId: "run-b",
    });
    const record = recordDecision({
      executionPlan,
      plan: testPlan,
      decision: "approve",
      mode: "noninteractive",
      operator: "t",
      discoveryProfileHash: profile.profileHash,
    });
    expect(record.discoveryProfileHash).toBe(profile.profileHash);
    const approved = buildApprovedExecutionPlan(executionPlan, record);
    expect(() => verifyApprovedPlan(approved, { currentPlan: testPlan })).not.toThrow();
    const edited = applyScopeExclusions(testPlan, { excludeScenarios: [testPlan.scenarios[0]!.id] }).plan;
    expect(computePlanHash(edited)).not.toBe(executionPlan.planHash);
    expect(() => verifyApprovedPlan(approved, { currentPlan: edited })).toThrow(/changed after approval/);
    expect(() =>
      recordDecision({
        executionPlan,
        plan: testPlan,
        decision: "approve",
        mode: "noninteractive",
        operator: "t",
        discoveryProfileHash: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow(/not bound to the reviewed discovery profile/);
  });

  it("renders the Autonomous Discovery Review with all integrity hashes and choices", async () => {
    const profile = await syntheticProfile();
    const { testPlan, executionPlan } = new AutonomousTestPlanGenerator().generate({ profile });
    const text = renderAutonomousReview(profile, testPlan, executionPlan);
    for (const s of [
      "BrowserSwarm Autonomous Discovery Review",
      "Primary category: ecommerce",
      "Authentication observed: yes",
      "Restricted or excluded areas:",
      "Proposed scenarios:",
      "Explicitly excluded:",
      `Discovery profile hash: ${profile.profileHash}`,
      `Test plan hash: ${executionPlan.planHash}`,
      `Execution plan hash: ${executionPlan.executionPlanHash}`,
      "approve-safe-plan",
      "export-and-edit",
    ])
      expect(text).toContain(s);
  });

  it("detects a plan that references undiscovered routes", async () => {
    const profile = await syntheticProfile();
    const { testPlan } = new AutonomousTestPlanGenerator().generate({ profile });
    const tampered = TestPlanSchema.parse({
      ...testPlan,
      scenarios: [
        { ...testPlan.scenarios[0]!, routes: ["/admin"], steps: [{ action: "navigate", url: "/admin" }] },
      ],
    });
    expect(validatePlanAgainstProfile(tampered, profile).join(" ")).toMatch(/\/admin/);
  });
});

describe("backward compatibility", () => {
  it("existing approved example plans still verify (plan and packet hashes unchanged)", async () => {
    const raw = JSON.parse(
      await readFile(path.join(repoRoot, "examples/login-validation/approved-execution-plan.json"), "utf8"),
    );
    expect(() => verifyApprovedPlan(raw)).not.toThrow();
  });
});
