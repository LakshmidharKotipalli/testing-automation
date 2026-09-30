import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { CountingLauncher } from "@browserswarm/browser-tools";
import { McpBrowserSession, type SessionFactory } from "@browserswarm/mcp-browser";
import { RunLayout } from "@browserswarm/storage";
import { startFixtureServer, type FixtureServer } from "@browserswarm/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cmdApprove,
  cmdAutonomousPlan,
  cmdDiscover,
  cmdPreview,
  cmdRun,
  EXIT,
  type CliIO,
} from "../../src/commands.js";

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server?.close();
});

async function setup(stdinText = "") {
  const cwd = await mkdtemp(path.join(tmpdir(), "bs-cli-auto-"));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outText = "";
  stdout.on("data", (d) => (outText += d));
  stderr.on("data", () => undefined);
  const io: CliIO = { stdin: Readable.from([stdinText]), stdout, stderr, env: { USER: "tester" }, cwd };
  await writeFile(
    path.join(cwd, "discovery.yaml"),
    "discovery:\n  maxRoutesVisited: 8\n  maxScreenshots: 4\n  runAccessibilityScan: false\nbrowser:\n  trace: false\n",
  );
  return { io, cwd, out: () => outText };
}

function countingSessions() {
  let n = 0;
  const factory: SessionFactory = (options) => {
    n++;
    return new McpBrowserSession(options);
  };
  return { factory, count: () => n };
}

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("browserswarm run (autonomous mode)", () => {
  it("URL only selects autonomous mode; declining authorization starts no browser", async () => {
    const t = await setup("no\n");
    const launcher = new CountingLauncher();
    const sessions = countingSessions();
    const code = await cmdRun(t.io, {
      url: server.url,
      output: "out",
      discoveryLauncher: launcher,
      runSessionFactory: sessions.factory,
    });
    expect(code).toBe(EXIT.REJECTED);
    expect(launcher.launches).toBe(0);
    expect(sessions.count()).toBe(0);
    expect(t.out()).toContain("BrowserSwarm Autonomous Discovery: Preflight");
    const run = await readJson(path.join(t.cwd, "out", RunLayout.metadata.run));
    expect(run.state).toBe("CANCELLED");
  });

  it("discovers, shows the review, and on reject runs no test subagent", async () => {
    const t = await setup("yes\nreject\n");
    const discovery = new CountingLauncher();
    const execution = countingSessions();
    const code = await cmdRun(t.io, {
      url: server.url,
      promptText: "Test this website.",
      discoveryConfig: "discovery.yaml",
      output: "out",
      discoveryLauncher: discovery,
      runSessionFactory: execution.factory,
    });
    expect(code).toBe(EXIT.REJECTED);
    expect(discovery.contexts).toBe(1);
    expect(execution.count()).toBe(0);
    expect(t.out()).toContain("BrowserSwarm Autonomous Discovery Review");
    const dir = path.join(t.cwd, "out");
    const run = await readJson(path.join(dir, RunLayout.metadata.run));
    expect(run.state).toBe("CANCELLED");
    expect(run.stateHistory.map((h: { state: string }) => h.state)).toEqual([
      "DRAFT",
      "DISCOVERY_PLANNED",
      "DISCOVERY_RUNNING",
      "DISCOVERY_COMPLETED",
      "WEBSITE_PROFILE_GENERATED",
      "TEST_PLAN_GENERATED",
      "EXECUTION_PLAN_GENERATED",
      "PENDING_APPROVAL",
      "CANCELLED",
    ]);
    expect(await readdir(dir)).not.toContain("packets");
    expect((await readJson(path.join(dir, "metadata/approval-rejection.json"))).decision).toBe("reject");
    expect(await readFile(path.join(dir, RunLayout.discovery.reportHtml), "utf8")).toContain(
      "<h1>Discovery Report</h1>",
    );
  });

  it("approve-safe-plan runs exactly the approved packets", async () => {
    const t = await setup("yes\napprove-safe-plan\n");
    const execution = countingSessions();
    const code = await cmdRun(t.io, {
      url: server.url,
      mode: "autonomous",
      discoveryConfig: "discovery.yaml",
      onlyRole: ["navigation"],
      output: "out",
      runSessionFactory: execution.factory,
    });
    expect([EXIT.OK, EXIT.TEST_FAILURES]).toContain(code);
    const dir = path.join(t.cwd, "out");
    const approved = await readJson(path.join(dir, RunLayout.metadata.approvedExecutionPlan));
    expect(approved.approvalRecord.discoveryProfileHash).toMatch(/^sha256:/);
    const packets = await readdir(path.join(dir, "packets"));
    expect(packets.sort()).toEqual(
      approved.executionPlan.workPackets.map((p: { packetId: string }) => p.packetId).sort(),
    );
    expect(approved.executionPlan.workPackets.every((p: { role: string }) => p.role === "navigation")).toBe(
      true,
    );
    expect(execution.count()).toBe(packets.length);
    const run = await readJson(path.join(dir, RunLayout.metadata.run));
    expect(run.stateHistory.map((h: { state: string }) => h.state)).toContain("RUNNING");
  });

  it("discover -> autonomous-plan (edit) -> preview/approve --profile requires a fresh approval", async () => {
    const t = await setup();
    expect(
      await cmdDiscover(t.io, {
        url: server.url,
        discoveryConfig: "discovery.yaml",
        output: "d",
        confirmAuthorized: true,
      }),
    ).toBe(EXIT.OK);
    expect(t.out()).toContain("Nothing was executed");
    const profile = path.join("d", RunLayout.discovery.profileJson);
    expect(
      await cmdAutonomousPlan(t.io, {
        profile,
        output: "plan.yaml",
        write: "ep.json",
        excludeRole: ["responsive"],
      }),
    ).toBe(EXIT.OK);
    const yaml = await readFile(path.join(t.cwd, "plan.yaml"), "utf8");
    expect(yaml).toContain("mode: autonomous");
    expect(yaml).not.toMatch(/roles:\n\s+- responsive/);
    expect(await cmdPreview(t.io, { plan: "plan.yaml", profile, write: "ep.json" })).toBe(EXIT.OK);
    expect(await cmdApprove(t.io, { plan: "plan.yaml", profile, executionPlan: "ep.json", yes: true })).toBe(
      EXIT.OK,
    );
    const record = await readJson(path.join(t.cwd, "approval-record.json"));
    expect(record.discoveryProfileHash).toMatch(/^sha256:/);
    // An added, undiscovered route is rejected against the profile.
    await writeFile(path.join(t.cwd, "plan.yaml"), yaml.replace(/url: \/[^\s]*/, "url: /admin-secret"));
    await expect(cmdPreview(t.io, { plan: "plan.yaml", profile })).rejects.toThrow(
      /does not match the discovery profile/,
    );
  });
});
