import { it, expect } from "vitest";
import { TestPlanSchema } from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { checkToolCall, parseSnapshot } from "@browserswarm/policy-engine";
import { GuardedBrowserSession } from "../src/index.js";
import { createRedactor } from "@browserswarm/shared";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const packet = () =>
  generateExecutionPlan(
    TestPlanSchema.parse({
      version: 1,
      id: "g",
      name: "g",
      target: { url: "https://owned.test", allowedDomains: ["owned.test"] },
      scenarios: [
        {
          id: "s",
          title: "s",
          objective: "s",
          roles: ["functional"],
          viewports: ["desktop"],
          expectedOutcome: "Content visible",
          steps: [{ action: "navigate", url: "/" }],
        },
      ],
    }),
  ).workPackets[0]!;
it.each([
  "browser_evaluate",
  "browser_run_code",
  "browser_file_upload",
  "browser_pdf_save",
  "browser_install",
  "unknown",
])("blocks %s by default", (name) => {
  expect(checkToolCall(name, {}, { elements: new Map(), riskApproved: false }, packet()).allowed).toBe(false);
});
it("uses real snapshot text, never the model label, for risky targets", () => {
  const elements = parseSnapshot('- button "Delete account" [ref=e1]');
  expect(
    checkToolCall(
      "browser_click",
      { ref: "e1", element: "safe button" },
      { elements, riskApproved: false },
      packet(),
    ).reason,
  ).toMatch(/deletion/);
  expect(
    checkToolCall("browser_click", { ref: "invented" }, { elements, riskApproved: false }, packet()).allowed,
  ).toBe(false);
});
it("rejects challenge pages and fabricated pass evidence", async () => {
  const g = new GuardedBrowserSession({
    packet: packet(),
    session: {
      tools: [],
      start: async () => {},
      callTool: async () => ({ content: [] }),
      saveStorage: async () => false,
      close: async () => {},
    },
    artifactDir: await mkdtemp(path.join(os.tmpdir(), "bs-gateway-")),
    redactor: createRedactor([]),
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
    riskApproved: false,
  });
  expect(() => g.observe("Page URL: https://owned.test\nPage Title: Just a moment")).toThrow(
    /bot_protection/,
  );
  await expect(
    g.callTool("report_verdict", {
      status: "pass",
      summary: "ok",
      outcomes: [{ expectedOutcome: "Content visible", met: true, evidence: ["invented"] }],
    }),
  ).rejects.toThrow(/unknown verdict evidence/);
  expect(() => g.safePath("../secret")).toThrow(/outside/);
});
