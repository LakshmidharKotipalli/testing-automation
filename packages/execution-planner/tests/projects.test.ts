import { computeExecutionPlanHash, TestPlanSchema } from "@browserswarm/core";
import { fixturePlan } from "@browserswarm/test-fixtures";
import { describe, expect, it } from "vitest";
import { generateExecutionPlan } from "../src/index.js";

const url = "https://staging.example.com";
const base = () => fixturePlan({ url, roles: ["functional"], viewports: ["desktop", "mobile"] });

describe("browser project matrix", () => {
  it("keeps historical packet ids for a plan without projects", () => {
    const ep = generateExecutionPlan(TestPlanSchema.parse(base()));
    expect(ep.workPackets.map((p) => p.packetId)).toEqual([
      "login-invalid-password-functional-desktop",
      "login-invalid-password-functional-mobile",
    ]);
    expect(ep.workPackets.every((p) => p.projectName === undefined)).toBe(true);
    expect(ep.browserProjects).toBeUndefined();
  });

  it("expands scenario x role x viewport x project with distinct ids, dirs and hashes", () => {
    const plan = TestPlanSchema.parse({
      ...base(),
      browserProjects: [
        { name: "chromium", channel: "chromium" },
        { name: "chrome", channel: "chrome" },
      ],
    });
    const ep = generateExecutionPlan(plan);
    expect(ep.workPackets).toHaveLength(4);
    expect(new Set(ep.workPackets.map((p) => p.packetId)).size).toBe(4);
    expect(new Set(ep.workPackets.map((p) => p.artifactDir)).size).toBe(4);
    expect(new Set(ep.workPackets.map((p) => p.workPacketHash)).size).toBe(4);
    const chrome = ep.workPackets.find((p) => p.projectName === "chrome")!;
    expect(chrome.browser.channel).toBe("chrome");
    expect(chrome.packetId).toMatch(/-chrome$/);
    expect(ep.summary.browserMatrix.filter((m) => m.project === "chrome")).toHaveLength(2);
  });

  it("binds the project list into the execution plan hash", () => {
    const a = generateExecutionPlan(
      TestPlanSchema.parse({ ...base(), browserProjects: [{ name: "one", channel: "chromium" }] }),
      { runId: "r" },
    );
    const b = { ...a, browserProjects: [{ name: "one", channel: "chrome" as const }] };
    expect(computeExecutionPlanHash(b)).not.toBe(a.executionPlanHash);
  });

  it("cannot express Firefox or WebKit projects and rejects duplicate names", () => {
    expect(() =>
      TestPlanSchema.parse({
        ...base(),
        browserProjects: [{ name: "ff", channel: "chromium", engine: "firefox" }],
      }),
    ).toThrow();
    expect(() =>
      TestPlanSchema.parse({ ...base(), browserProjects: [{ name: "ff", channel: "firefox" }] }),
    ).toThrow();
    expect(() =>
      generateExecutionPlan(
        TestPlanSchema.parse({
          ...base(),
          browserProjects: [
            { name: "a", channel: "chromium" },
            { name: "a", channel: "chrome" },
          ],
        }),
      ),
    ).toThrow(/duplicate browser project/);
  });
});
