import { describe, expect, it } from "vitest";
import { resolveRunMode, resolveScope } from "../src/index.js";

describe("resolveRunMode", () => {
  it("URL only or a broad request -> autonomous", () => {
    expect(resolveRunMode({}).mode).toBe("autonomous");
    expect(resolveRunMode({ promptText: "Test this website." }).mode).toBe("autonomous");
    expect(resolveRunMode({ promptText: "Figure out this website and test it." }).mode).toBe("autonomous");
    expect(resolveRunMode({ promptText: "Explore and test https://example.com" }).mode).toBe("autonomous");
    expect(resolveRunMode({ promptText: "Perform safe QA on this application." }).mode).toBe("autonomous");
  });

  it("explicit scenarios, steps, routes or 'only test' -> instruction-led", () => {
    expect(resolveRunMode({ planProvided: true }).mode).toBe("instruction-led");
    expect(resolveRunMode({ promptText: "## Scenario: login\nSteps:\n1. Navigate to /login" }).mode).toBe(
      "instruction-led",
    );
    expect(resolveRunMode({ promptText: "Only test login." }).mode).toBe("instruction-led");
    expect(resolveRunMode({ promptText: "Check /pricing and /about" }).mode).toBe("instruction-led");
    expect(resolveRunMode({ promptText: "Verify that the cart total updates" }).mode).toBe("instruction-led");
  });

  it("--mode always wins", () => {
    expect(resolveRunMode({ explicitMode: "autonomous", promptText: "Only test login" }).mode).toBe(
      "autonomous",
    );
    expect(resolveRunMode({ explicitMode: "instruction-led" }).mode).toBe("instruction-led");
  });

  it("an unrecognized, non-broad prompt stays instruction-led (never silently broadened)", () => {
    const r = resolveRunMode({ promptText: "Look at the pricing page please" });
    expect(r.mode).toBe("instruction-led");
  });
});

describe("resolveScope (ScopeResolutionPolicy)", () => {
  const auto = { mode: "autonomous" as const, reasons: ["test"] };

  it("extracts exclusions, only-roles and concurrency preferences", () => {
    const s = resolveScope({
      mode: auto,
      promptText:
        "Test this website. Skip /blog and accessibility. Only test responsive layouts. Use 2 agents.",
    });
    expect(s.selection.excludeRoutes).toContain("/blog");
    expect(s.selection.excludeRoles).toContain("accessibility");
    expect(s.selection.onlyRoles).toContain("responsive");
    expect(s.selection.maxConcurrency).toBe(2);
    expect(s.record.reasons.join(" ")).toMatch(/safety restrictions > user scenarios/);
  });

  it("safety wins: requested state-changing actions become conflicts, never scope", () => {
    const s = resolveScope({
      mode: auto,
      promptText: "Test the whole website and complete a checkout, then log in.",
    });
    expect(s.riskRequests).toEqual(
      expect.arrayContaining(["purchase/payment", "authentication (requires credentials)"]),
    );
    expect(s.record.conflicts.some((c) => /requires-risk-approval/.test(c))).toBe(true);
    expect(s.record.conflicts.some((c) => /requires-credentials/.test(c))).toBe(true);
  });

  it("records explicit safety restrictions", () => {
    const s = resolveScope({ mode: auto, promptText: "Explore the site. Do not submit any forms." });
    expect(s.record.safetyRestrictions[0]).toMatch(/Do not submit/);
    expect(s.riskRequests).toHaveLength(0);
  });

  it("CLI selections are merged", () => {
    const s = resolveScope({
      mode: auto,
      cli: { excludeRoles: ["responsive"], excludeCategories: ["forms"] },
    });
    expect(s.selection.excludeRoles).toEqual(["responsive"]);
    expect(s.record.exclusions).toEqual(expect.arrayContaining(["role responsive", "category forms"]));
  });
});
