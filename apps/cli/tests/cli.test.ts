import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { verifyApprovedPlan } from "@browserswarm/approval";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { fixturePlan } from "@browserswarm/test-fixtures";
import { cmdApprove, cmdPlan, cmdPreview, cmdRun, cmdValidate, EXIT, type CliIO } from "../src/commands.js";

async function setup(stdinText = "", env: NodeJS.ProcessEnv = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "bs-cli-"));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outText = "";
  let errText = "";
  stdout.on("data", (d) => (outText += d));
  stderr.on("data", (d) => (errText += d));
  const io: CliIO = {
    stdin: Readable.from([stdinText]),
    stdout,
    stderr,
    env: { USER: "tester", ...env },
    cwd,
  };
  return { io, cwd, out: () => outText, err: () => errText };
}

const PROMPT = `# Pricing smoke
## Scenario: Pricing lists plans
Expected: The Pro plan shows $20.
Steps:
1. Navigate to /pricing
2. Verify heading "Pricing" is visible
3. Verify test id "plan-pro" contains "$20"
`;

describe("CLI commands (no browser)", () => {
  it("plan -> validate -> preview -> approve (--yes) produces a verifiable approved plan", async () => {
    const t = await setup();
    await writeFile(path.join(t.cwd, "req.md"), PROMPT);
    expect(
      await cmdPlan(t.io, {
        url: "https://staging.example.com",
        prompt: "req.md",
        output: "plans/plan.yaml",
      }),
    ).toBe(EXIT.OK);
    expect(await cmdValidate(t.io, { plan: "plans/plan.yaml" })).toBe(EXIT.OK);
    expect(
      await cmdPreview(t.io, { plan: "plans/plan.yaml", parallel: 2, write: "plans/execution-plan.json" }),
    ).toBe(EXIT.OK);
    expect(t.out()).toContain("BrowserSwarm Execution Plan Review");
    expect(
      await cmdApprove(t.io, {
        plan: "plans/plan.yaml",
        executionPlan: "plans/execution-plan.json",
        yes: true,
      }),
    ).toBe(EXIT.OK);
    const approved = JSON.parse(
      await readFile(path.join(t.cwd, "plans/approved-execution-plan.json"), "utf8"),
    );
    expect(verifyApprovedPlan(approved).approvalRecord.mode).toBe("noninteractive");
    expect(approved.approvalRecord.operator).toBe("tester");
  });

  it("interactive reject writes a rejection record and returns REJECTED", async () => {
    const t = await setup("reject\n");
    await writeFile(
      path.join(t.cwd, "plan.yaml"),
      YAML.stringify(fixturePlan({ url: "https://staging.example.com" })),
    );
    await cmdPreview(t.io, { plan: "plan.yaml", write: "ep.json" });
    expect(await cmdApprove(t.io, { plan: "plan.yaml", executionPlan: "ep.json" })).toBe(EXIT.REJECTED);
    const rejection = JSON.parse(await readFile(path.join(t.cwd, "approval-rejection.json"), "utf8"));
    expect(rejection.decision).toBe("reject");
  });

  it("editing the plan after preview invalidates approval", async () => {
    const t = await setup();
    const raw = fixturePlan({ url: "https://staging.example.com" });
    await writeFile(path.join(t.cwd, "plan.yaml"), YAML.stringify(raw));
    await cmdPreview(t.io, { plan: "plan.yaml", write: "ep.json" });
    await writeFile(path.join(t.cwd, "plan.yaml"), YAML.stringify({ ...raw, name: "Edited" }));
    await expect(
      cmdApprove(t.io, { plan: "plan.yaml", executionPlan: "ep.json", yes: true }),
    ).rejects.toThrow(/changed after the execution plan/);
  });

  it("interactive run shortcut: reject starts no browser and records CANCELLED", async () => {
    const t = await setup("reject\n");
    await writeFile(
      path.join(t.cwd, "plan.yaml"),
      YAML.stringify(fixturePlan({ url: "http://127.0.0.1:9" })),
    );
    const code = await cmdRun(t.io, { plan: "plan.yaml", output: "run-out" });
    expect(code).toBe(EXIT.REJECTED);
    const run = JSON.parse(await readFile(path.join(t.cwd, "run-out/metadata/run.json"), "utf8"));
    expect(run.stateHistory.map((s: { state: string }) => s.state)).toEqual([
      "DRAFT",
      "COMPILED",
      "VALIDATED",
      "EXECUTION_PLAN_GENERATED",
      "PENDING_APPROVAL",
      "CANCELLED",
    ]);
    await expect(readFile(path.join(t.cwd, "run-out/events/events.ndjson"))).rejects.toThrow();
  });

  it("--yes refuses risky plans without matching risk approval", async () => {
    const t = await setup();
    const raw = fixturePlan({
      url: "https://staging.example.com",
      safety: { destructiveActions: "allow-with-approval" },
    }) as {
      scenarios: { steps: unknown[] }[];
    };
    raw.scenarios[0]!.steps.push({ action: "click", locator: { role: "button", name: "Delete account" } });
    await writeFile(path.join(t.cwd, "plan.yaml"), YAML.stringify(raw));
    await cmdPreview(t.io, { plan: "plan.yaml", write: "ep.json" });
    await expect(
      cmdApprove(t.io, { plan: "plan.yaml", executionPlan: "ep.json", yes: true }),
    ).rejects.toMatchObject({ code: "RISK_APPROVAL_REQUIRED" });
    const ep = JSON.parse(await readFile(path.join(t.cwd, "ep.json"), "utf8"));
    expect(
      await cmdApprove(t.io, {
        plan: "plan.yaml",
        executionPlan: "ep.json",
        yes: true,
        acceptRisk: true,
        riskPlanHash: ep.riskPlanHash,
      }),
    ).toBe(EXIT.OK);
  });

  it("uses BROWSERSWARM_TARGET_URL from .env when --url is omitted", async () => {
    const t = await setup("", { BROWSERSWARM_TARGET_URL: "https://staging.example.com" });
    await writeFile(path.join(t.cwd, "req.md"), PROMPT);
    expect(await cmdPlan(t.io, { prompt: "req.md", output: "plan.yaml" })).toBe(EXIT.OK);
    const plan = YAML.parse(await readFile(path.join(t.cwd, "plan.yaml"), "utf8"));
    expect(plan.target.url).toBe("https://staging.example.com");
    expect(plan.target.allowedDomains).toEqual(["staging.example.com"]);
    expect(t.out()).toContain("from BROWSERSWARM_TARGET_URL in .env");

    const none = await setup();
    await writeFile(path.join(none.cwd, "req.md"), PROMPT);
    await expect(cmdPlan(none.io, { prompt: "req.md", output: "plan.yaml" })).rejects.toThrow(
      /No target website/,
    );
  });

  it("plans without a target follow .env, and an approved plan refuses to run after .env changes", async () => {
    const env = { BROWSERSWARM_TARGET_URL: "http://127.0.0.1:9" };
    const t = await setup("", env);
    const raw = fixturePlan({ url: "http://unused.example.com" }) as Record<string, unknown>;
    delete raw.target;
    await writeFile(path.join(t.cwd, "plan.yaml"), YAML.stringify(raw));
    expect(await cmdPreview(t.io, { plan: "plan.yaml", write: "ep.json" })).toBe(EXIT.OK);
    expect(t.out()).toContain("Target: http://127.0.0.1:9 (from BROWSERSWARM_TARGET_URL in .env)");
    expect(await cmdApprove(t.io, { plan: "plan.yaml", executionPlan: "ep.json", yes: true })).toBe(EXIT.OK);

    t.io.env.BROWSERSWARM_TARGET_URL = "http://127.0.0.1:10";
    await expect(
      cmdRun(t.io, { approvedPlan: "approved-execution-plan.json", output: "run-out" }),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALIDATED" });
    await expect(readFile(path.join(t.cwd, "run-out/metadata/run.json"))).rejects.toThrow();
  });
});
