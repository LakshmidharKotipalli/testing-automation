import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApprovedExecutionPlan, recordDecision } from "@browserswarm/approval";
import { TestPlanSchema } from "@browserswarm/core";
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

const response = (name: string, args: unknown): ChatOutput => ({
  content: "",
  toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }],
  usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70, exact: true },
  cost: 0,
  stopReason: "tool_calls",
});
const refOf = (text: string, label: string) => {
  const line = text.split("\n").find((l) => l.includes(label) && l.includes("[ref="));
  if (!line) throw new Error(`missing ${label}`);
  return line.match(/\[ref=([^\]]+)\]/)![1];
};

/** Logs in with an invalid password. Resumes from the replayed state when the host says a replay completed. */
class LoginClient implements ChatClient {
  calls = 0;
  async chat(input: ChatInput): Promise<ChatOutput> {
    this.calls++;
    const user = JSON.parse(input.messages[1]!.content);
    const tools = input.messages.filter((m) => m.role === "tool");
    const last = tools.at(-1)?.content ?? "";
    const n = input.messages.flatMap((m) => m.toolCalls ?? []).length;
    const verdict = () =>
      response("report_verdict", {
        status: "pass",
        summary: "Invalid login was rejected",
        outcomes: [
          {
            expectedOutcome: user.mission.expectedOutcome,
            met: true,
            evidence: [last.match(/Evidence ID: (\S+)/)![1]],
          },
        ],
      });
    if (user.handoff?.replay?.status === "complete") {
      if (n === 0) return response("browser_snapshot", {});
      return verdict();
    }
    if (n === 0) return response("browser_navigate", { url: "/login" });
    if (n === 1)
      return response("browser_type", {
        ref: refOf(last, '"Email"'),
        element: "Email",
        text: "qa@example.test",
      });
    if (n === 2)
      return response("browser_type", {
        ref: refOf(last, '"Password"'),
        element: "Password",
        text: "invalid",
      });
    if (n === 3)
      return response("browser_click", { ref: refOf(last, 'button "Sign in"'), element: "Sign in" });
    return verdict();
  }
}

function approved(model = "login-v1", replay = true) {
  const original = TestPlanSchema.parse(fixturePlan({ url: server.url }));
  const plan = TestPlanSchema.parse({
    ...original,
    mode: "agentic",
    models: { default: { provider: "mock", model } },
    contextLifecycle: { checkpointAfterEveryStep: false },
    ...(replay ? { replay: { enabled: true } } : {}),
  });
  const ep = generateExecutionPlan(plan);
  return buildApprovedExecutionPlan(
    ep,
    recordDecision({ executionPlan: ep, plan, decision: "approve", mode: "noninteractive", operator: "t" }),
  );
}

const events = async (out: string) =>
  (await readFile(path.join(out, "events", "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });

describe("guarded replay cache", () => {
  it("is off by default: nothing is read or written without an approved opt-in", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "bs-replay-off-"));
    const client = new LoginClient();
    const out = await mkdtemp(path.join(os.tmpdir(), "bs-replay-off-run-"));
    const result = await executeApprovedPlan(approved("login-v1", false), {
      outputDir: out,
      modelClient: client,
      replayCacheDir: cache,
    });
    expect(result.report.packets[0]!.outcome).toBe("passed");
    expect(await readdir(cache)).toEqual([]);
  }, 90000);

  it("stores a successful sequence, replays it through the gateway with fresh evidence, and invalidates on change", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "bs-replay-"));
    const first = new LoginClient();
    const out1 = await mkdtemp(path.join(os.tmpdir(), "bs-replay-run1-"));
    const r1 = await executeApprovedPlan(approved(), {
      outputDir: out1,
      modelClient: first,
      replayCacheDir: cache,
    });
    expect(r1.report.packets[0]!.outcome).toBe("passed");
    expect(first.calls).toBe(5);
    const files = await readdir(cache);
    expect(files).toHaveLength(1);
    const stored = await readFile(path.join(cache, files[0]!), "utf8");
    /* No live refs, secrets or verdicts are cached. */
    expect(stored).not.toMatch(/"ref"/);
    expect(stored).not.toMatch(/verdict|Evidence ID/);
    expect(stored).toContain('"Email"');

    const second = new LoginClient();
    const out2 = await mkdtemp(path.join(os.tmpdir(), "bs-replay-run2-"));
    const r2 = await executeApprovedPlan(approved(), {
      outputDir: out2,
      modelClient: second,
      replayCacheDir: cache,
    });
    expect(r2.report.packets[0]!.outcome).toBe("passed");
    expect(second.calls).toBe(2);
    expect((await events(out2)).map((e) => e.type)).toContain("replay.completed");
    /* Fresh evidence: the verdict cites evidence captured in run 2, and the tool ledger has the replayed calls. */
    const ledger = (
      await readFile(
        path.join(out2, "packets", r2.report.packets[0]!.packetId, "mcp-1", "tools.ndjson"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledger.filter((l: { tool: string }) => l.tool === "browser_type")).toHaveLength(2);
    expect(ledger.some((l: { llmInvolved: boolean }) => l.llmInvolved === false)).toBe(true);
    expect(r2.report.packets[0]!.verdict?.outcomes[0]!.evidence[0]).toBeTruthy();

    /* A semantic change (different model) misses the cache. */
    const third = new LoginClient();
    const r3 = await executeApprovedPlan(approved("login-v2"), {
      outputDir: await mkdtemp(path.join(os.tmpdir(), "bs-replay-run3-")),
      modelClient: third,
      replayCacheDir: cache,
    });
    expect(r3.report.packets[0]!.outcome).toBe("passed");
    expect(third.calls).toBe(5);
    expect(await readdir(cache)).toHaveLength(2);
  }, 240000);

  it("resumes the model on a safe mismatch and ends the packet on a policy violation", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "bs-replay-mm-"));
    await executeApprovedPlan(approved(), {
      outputDir: await mkdtemp(path.join(os.tmpdir(), "bs-replay-seed-")),
      modelClient: new LoginClient(),
      replayCacheDir: cache,
    });
    const file = path.join(cache, (await readdir(cache))[0]!);
    const entry = JSON.parse(await readFile(file, "utf8"));

    /* Safe mismatch: the target no longer exists on the page. */
    const mismatched = structuredClone(entry);
    mismatched.calls.find((c: { target?: { name: string } }) => c.target)!.target!.name = "Gone";
    await writeFile(file, JSON.stringify(mismatched));
    const model = new LoginClient();
    const out = await mkdtemp(path.join(os.tmpdir(), "bs-replay-mm-run-"));
    const r = await executeApprovedPlan(approved(), {
      outputDir: out,
      modelClient: model,
      replayCacheDir: cache,
    });
    expect(r.report.packets[0]!.outcome).toBe("passed");
    expect((await events(out)).map((e) => e.type)).toContain("replay.mismatch");

    /* Policy violation: a cached off-scope navigation is blocked by the gateway and terminates the packet. */
    const hostile = structuredClone(entry);
    hostile.calls[0].args = { url: "https://evil.example.invalid/" };
    await writeFile(file, JSON.stringify(hostile));
    const blockedModel = new LoginClient();
    const blocked = await executeApprovedPlan(approved(), {
      outputDir: await mkdtemp(path.join(os.tmpdir(), "bs-replay-pol-")),
      modelClient: blockedModel,
      replayCacheDir: cache,
    });
    expect(blocked.report.packets[0]!.outcome).toBe("blocked");
    expect(blockedModel.calls).toBe(0);
  }, 300000);
});
