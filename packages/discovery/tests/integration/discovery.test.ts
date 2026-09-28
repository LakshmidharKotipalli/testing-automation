import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AutonomousTestPlanGenerator } from "@browserswarm/autonomous-planner";
import { CountingLauncher } from "@browserswarm/browser-tools";
import {
  BrowserConfigSchema,
  computeDiscoveryCheckpointHash,
  computeDiscoveryHandoffHash,
  ContextPolicySchema,
  DiscoveryCheckpointSchema,
  DiscoveryHandoffSchema,
  DiscoveryPolicySchema,
} from "@browserswarm/core";
import { createRedactor } from "@browserswarm/shared";
import { EventStore, FilesystemStorage, RunLayout } from "@browserswarm/storage";
import { startFixtureServer, type FixtureServer } from "@browserswarm/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDiscoveryPacket,
  DiscoveryLeadAgent,
  recordDiscoveryAuthorization,
  runDiscoveryPhase,
} from "../../src/index.js";

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server?.close();
});

function packetFor(policy: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return createDiscoveryPacket(
    {
      targetUrl: server.url,
      allowedDomains: ["127.0.0.1"],
      mode: "autonomous",
      discoveryPolicy: DiscoveryPolicySchema.parse({ maxDurationMs: 120_000, ...policy }),
      browser: BrowserConfigSchema.parse({ trace: false }),
      contextLifecycle: ContextPolicySchema.parse(context),
    },
    "run-it-discovery",
  );
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bs-discovery-"));
  const storage = new FilesystemStorage(dir);
  const events = new EventStore(storage, "run-it-discovery", RunLayout.discovery.events);
  return { dir, storage, events };
}

describe("Discovery Lead Agent against the fixture site", () => {
  it("is read-only, bounded and single-context, and produces every discovery output", async () => {
    const { storage, events } = await setup();
    const packet = packetFor();
    const authorization = recordDiscoveryAuthorization({
      packet,
      operator: "vitest",
      mode: "noninteractive",
    });
    const launcher = new CountingLauncher();
    const before = server.requestLog().length;
    const { result, profile, files } = await runDiscoveryPhase({
      packet,
      authorization,
      storage,
      events,
      redactor: createRedactor(),
      launcher,
    });
    const log = server.requestLog().slice(before);

    // Exactly one browser and one context: only the Discovery Lead Agent ran.
    expect(launcher.launches).toBe(1);
    expect(launcher.contexts).toBe(1);
    // Read-only: no request other than GET/HEAD reached the server, and no restricted endpoint was hit.
    expect(log.filter((r) => r.method !== "GET" && r.method !== "HEAD")).toEqual([]);
    expect(
      log.filter(
        (r) => r.path.startsWith("/api/") || r.path.startsWith("/files/") || r.path.includes("logout"),
      ),
    ).toEqual([]);
    // The page scripts' POSTs were attempted by nothing, but a cookie-accept or fetch would be blocked anyway.
    expect(
      result.blockedRequests.every((b) => b.kind !== "non-read-method" || !b.url.includes("consent-accept")),
    ).toBe(true);

    // Bounded and complete enough to understand the site.
    expect(result.stats.routesVisited).toBeLessThanOrEqual(packet.request.discoveryPolicy.maxRoutesVisited);
    const paths = profile.routeGraph.routes.map((r) => r.path);
    for (const p of ["/", "/catalog", "/catalog/item/1", "/login", "/pricing"]) expect(paths).toContain(p);
    expect(profile.routeGraph.externalLinks.some((l) => l.host === "external.invalid")).toBe(true);
    expect(log.some((r) => r.path.includes("external.invalid"))).toBe(false);
    expect(
      profile.accessModel.authBoundaries.some(
        (b) => b.route === "/account/logout" || b.kind === "login-form" || b.kind === "redirect-to-login",
      ),
    ).toBe(true);

    // Restricted controls recorded, never used.
    const restrictedLabels = result.restricted.map((r) => r.label);
    for (const l of ["Add to cart", "Delete product", "Subscribe", "Log out", "Sign me up", "Upload photo"])
      expect(restrictedLabels).toContain(l);
    expect(profile.uiInventory.uploads.length).toBeGreaterThan(0);
    expect(profile.uiInventory.downloads.length).toBeGreaterThan(0);

    // Safe interactions happened: read-only GET search, a tab, and the cookie banner was declined (never accepted).
    expect(
      profile.uiInventory.searchAndFilters.some((s) => s.exercisedUrl?.startsWith("/catalog/search?q=")),
    ).toBe(true);
    expect(log.some((r) => r.path.startsWith("/catalog/search?q="))).toBe(true);
    expect(profile.uiInventory.tabsAndAccordions.some((t) => t.kind === "tab" && t.exercised)).toBe(true);
    const catalogObs = result.observations.find((o) => o.path === "/catalog");
    expect(catalogObs?.interactions.some((i) => i.kind === "cookie-banner" && /reject/i.test(i.label))).toBe(
      true,
    );

    // Quality surface picked up the seeded problems.
    expect(profile.qualitySurface.console.errorCount).toBeGreaterThan(0);
    expect(profile.qualitySurface.accessibility.routesScanned).toBeGreaterThan(0);
    expect(
      profile.qualitySurface.brokenMedia.length + profile.qualitySurface.network.httpErrorCount,
    ).toBeGreaterThan(0);

    // Every discovery output exists.
    const D = RunLayout.discovery;
    for (const f of [
      D.profileJson,
      D.profileMarkdown,
      D.reportJson,
      D.reportMarkdown,
      D.reportHtml,
      D.routeMap,
      D.routeMapMermaid,
      D.routeInventory,
      D.uiInventory,
      D.domainModel,
      D.journeyInventory,
      D.riskInventory,
      D.qualitySurface,
      D.lead.actions,
      D.lead.console,
      D.lead.network,
      D.lead.manifest,
      D.lead.checkpoint(1),
    ])
      expect(await storage.exists(f)).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(14);
    expect((await readdir(storage.resolve(D.lead.screenshotsDir))).length).toBeGreaterThan(0);

    // The generated plan only uses discovered routes and never plans state changes.
    const { testPlan, executionPlan } = new AutonomousTestPlanGenerator().generate({ profile });
    expect(executionPlan.riskFlags).toHaveLength(0);
    for (const s of testPlan.scenarios) for (const r of s.routes ?? []) expect(paths).toContain(r);
  });

  it("stops at limits and records the limitation", async () => {
    const { storage, events } = await setup();
    const packet = packetFor({ maxRoutesVisited: 3, runAccessibilityScan: false, maxScreenshots: 0 });
    const agent = new DiscoveryLeadAgent(packet, { storage, events, redactor: createRedactor() });
    const result = await agent.run(
      recordDiscoveryAuthorization({ packet, operator: "vitest", mode: "noninteractive" }),
    );
    expect(result.stats.routesVisited).toBe(3);
    expect(result.status).toBe("partial");
    expect(result.stopReason).toMatch(/maxRoutesVisited/);
  });

  it("rotates the agent instance with a verified checkpoint and handoff when the lifecycle limit is reached", async () => {
    const { storage, events } = await setup();
    const packet = packetFor(
      { maxRoutesVisited: 6, runAccessibilityScan: false, maxScreenshots: 0, allowSearchAndFilters: false },
      { maxActionsPerAgentInstance: 3, maxHandoffsPerWorkPacket: 5 },
    );
    const launcher = new CountingLauncher();
    const agent = new DiscoveryLeadAgent(packet, { storage, events, redactor: createRedactor(), launcher });
    const result = await agent.run(
      recordDiscoveryAuthorization({ packet, operator: "vitest", mode: "noninteractive" }),
    );
    expect(result.handoffs.length).toBeGreaterThan(0);
    expect(result.stats.agentInstances).toBe(result.handoffs.length + 1);
    // One context per instance, never more than one at a time.
    expect(launcher.contexts).toBe(result.stats.agentInstances);
    const handoff = DiscoveryHandoffSchema.parse(await storage.readJson(result.handoffs[0] as string));
    expect(computeDiscoveryHandoffHash(handoff)).toBe(handoff.integrityHash);
    const cp = DiscoveryCheckpointSchema.parse(
      await storage.readJson(RunLayout.discovery.lead.checkpoint(1)),
    );
    expect(computeDiscoveryCheckpointHash(cp)).toBe(cp.integrityHash);
    // No route was visited twice across instances.
    const visited = result.observations.map((o) => o.path);
    expect(new Set(visited).size).toBe(visited.length);
  });

  it("refuses to start without an authorization bound to the exact packet", async () => {
    const { storage, events } = await setup();
    const packet = packetFor();
    const other = packetFor({ maxRoutesVisited: 2 });
    const launcher = new CountingLauncher();
    const agent = new DiscoveryLeadAgent(packet, { storage, events, redactor: createRedactor(), launcher });
    await expect(
      agent.run(recordDiscoveryAuthorization({ packet: other, operator: "x", mode: "noninteractive" })),
    ).rejects.toThrow(/authorization/);
    expect(launcher.launches).toBe(0);
  });
});
