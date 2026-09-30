import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApprovedExecutionPlan, recordDecision, verifyApprovedPlan } from "@browserswarm/approval";
import { McpBrowserSession, type SessionFactory } from "@browserswarm/mcp-browser";
import { TestPlanSchema, type TestPlan } from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import type { ChatClient, ChatInput, ChatOutput } from "@browserswarm/opencode-adapter";
import { fixturePlan, startFixtureServer, type FixtureServer } from "@browserswarm/test-fixtures";
import { executeApprovedPlan } from "../../src/index.js";

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server?.close();
});

function approve(plan: TestPlan) {
  const ep = generateExecutionPlan(plan);
  return buildApprovedExecutionPlan(
    ep,
    recordDecision({ executionPlan: ep, plan, decision: "approve", mode: "noninteractive", operator: "t" }),
  );
}
const scenario = (id: string, steps: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  objective: `objective ${id}`,
  priority: "high",
  roles: ["functional"],
  viewports: ["desktop"],
  expectedOutcome: `expected ${id}`,
  steps,
  ...extra,
});
const wrongText = [
  { action: "navigate", url: "/" },
  {
    action: "assert_text_contains",
    locator: { role: "heading", name: "Fixture Shop" },
    text: "Welcome back, admin",
    timeoutMs: 500,
  },
];

describe("conditional verifier packets", () => {
  it("reserves one verifier per primary at preview and binds it into the approval", () => {
    const plan = TestPlanSchema.parse({
      ...fixturePlan({ url: server.url }),
      verification: { enabled: true },
      scenarios: [scenario("a", wrongText), scenario("b", [{ action: "navigate", url: "/" }])],
    });
    const approved = approve(plan);
    const ep = approved.executionPlan;
    expect(ep.verifierPackets?.map((v) => v.verifierOf)).toEqual(ep.workPackets.map((p) => p.packetId));
    expect(ep.verifierPackets?.every((v) => v.role === "verifier")).toBe(true);
    expect(ep.summary.verifierPacketCount).toBe(2);

    /* Tampering with a reserved verifier, or making a verifier verify a verifier, is rejected. */
    const tampered = structuredClone(approved);
    tampered.executionPlan.verifierPackets![0]!.actionBudget += 1;
    expect(() => verifyApprovedPlan(tampered)).toThrow();
    const recursive = structuredClone(approved);
    recursive.executionPlan.verifierPackets![1]!.verifierOf =
      recursive.executionPlan.verifierPackets![0]!.packetId;
    expect(() => verifyApprovedPlan(recursive)).toThrow();
  });

  it("runs a deterministic verifier only for eligible findings, in a fresh session, and confirms", async () => {
    const plan = TestPlanSchema.parse({
      ...fixturePlan({ url: server.url }),
      verification: { enabled: true },
      scenarios: [
        scenario("wrong-text", wrongText),
        scenario("fine", [{ action: "navigate", url: "/" }]),
        scenario(
          "low-console",
          [{ action: "navigate", url: "/console-error" }, { action: "assert_no_console_errors" }],
          {
            priority: "low",
          },
        ),
      ],
    });
    const sessionFactory = vi.fn<SessionFactory>((o) => new McpBrowserSession(o));
    const out = await mkdtemp(path.join(os.tmpdir(), "bs-verify-"));
    const result = await executeApprovedPlan(approve(plan), { outputDir: out, sessionFactory });

    /* 3 primary sessions + exactly one verifier session (wrong-text only). */
    expect(sessionFactory).toHaveBeenCalledTimes(4);
    expect(result.report.verification).toMatchObject({ reserved: 3, run: 1, skipped: 2 });
    expect(result.report.packets).toHaveLength(3);
    expect(result.report.verification!.packets.map((p) => p.packetId)).toEqual([
      "wrong-text-functional-desktop-verifier",
    ]);
    const finding = result.report.findings.find((f) => f.scenarioId === "wrong-text")!;
    expect(finding.verificationStatus).toBe("confirmed");
    expect(result.report.verification!.results[0]).toMatchObject({
      findingId: finding.findingId,
      status: "confirmed",
    });
    expect(result.report.findings.find((f) => f.scenarioId === "low-console")!.verificationStatus).toBe(
      "not_required",
    );
    /* The verifier has its own packet directory and never spawned another verifier. */
    const packets = await readdir(path.join(out, "packets"));
    expect(packets).toContain("wrong-text-functional-desktop-verifier");
    expect(packets.filter((p) => p.endsWith("-verifier-verifier"))).toEqual([]);
  }, 120000);

  it("marks a non-reproducing failure unverified", async () => {
    const plan = TestPlanSchema.parse({
      ...fixturePlan({ url: server.url }),
      verification: { enabled: true },
      scenarios: [
        scenario("flaky", [
          { action: "navigate", url: "/" },
          { action: "assert_visible", locator: { role: "heading", name: "Fixture Shop" } },
        ]),
      ],
    });
    /* Make the primary fail by asserting a missing element only on the first session. */
    let n = 0;
    const sessionFactory: SessionFactory = (o) => {
      const s = new McpBrowserSession(o);
      if (++n === 1) {
        const call = s.callTool.bind(s);
        s.callTool = async (name, args) =>
          name === "browser_snapshot"
            ? { ...(await call(name, args)), isError: false }
            : call(name, name === "browser_navigate" ? { url: `${server.url}/does-not-exist` } : args);
      }
      return s;
    };
    const out = await mkdtemp(path.join(os.tmpdir(), "bs-verify-flaky-"));
    const result = await executeApprovedPlan(approve(plan), { outputDir: out, sessionFactory });
    expect(result.report.verification!.run).toBe(1);
    expect(result.report.findings[0]!.verificationStatus).toBe("unverified");
  }, 120000);
});

const response = (name: string, args: unknown): ChatOutput => ({
  content: "",
  toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }],
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, exact: true },
  cost: 0,
  stopReason: "tool_calls",
});

/** Always navigates once, then reports a failing verdict (also when acting as verifier). */
class AlwaysFails implements ChatClient {
  sawClaims = false;
  async chat(input: ChatInput): Promise<ChatOutput> {
    const user = JSON.parse(input.messages[1]!.content);
    if (user.handoff?.untrustedFindingClaims) this.sawClaims = true;
    const tools = input.messages.filter((m) => m.role === "tool");
    if (!tools.length) return response("browser_navigate", { url: "/" });
    const id = tools.at(-1)!.content.match(/Evidence ID: (\S+)/)![1];
    return response("report_verdict", {
      status: "fail",
      summary: "Checkout is broken",
      outcomes: [{ expectedOutcome: user.mission.expectedOutcome, met: false, evidence: [id] }],
    });
  }
}

describe("agentic verification", () => {
  it("labels model-only confirmation as likely and gives the verifier the claims as data", async () => {
    const plan = TestPlanSchema.parse({
      ...fixturePlan({ url: server.url }),
      mode: "agentic",
      models: { default: { provider: "mock", model: "always-fails" } },
      verification: { enabled: true },
      contextLifecycle: { checkpointAfterEveryStep: false },
      scenarios: [scenario("agentic-fail", [])],
    });
    const client = new AlwaysFails();
    const out = await mkdtemp(path.join(os.tmpdir(), "bs-verify-agentic-"));
    const result = await executeApprovedPlan(approve(plan), { outputDir: out, modelClient: client });
    expect(result.report.verification).toMatchObject({ reserved: 1, run: 1 });
    const finding = result.report.findings[0]!;
    expect(finding.probabilistic).toBe(true);
    expect(finding.verificationStatus).toBe("likely");
    expect(client.sawClaims).toBe(true);
    expect(result.report.verification!.results[0]!.notes).toMatch(/probabilistic/);
  }, 120000);
});
