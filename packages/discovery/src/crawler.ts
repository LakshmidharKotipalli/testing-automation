import { McpBrowserSession, type BrowserSession, type SessionFactory } from "@browserswarm/mcp-browser";
import { DiscoveryBrowser, GatewayBlocked } from "@browserswarm/mcp-gateway";
import { ContextLifecycleManager } from "@browserswarm/context-lifecycle";
import {
  computeDiscoveryCheckpointHash,
  computeDiscoveryHandoffHash,
  type BlockedRoute,
  type DiscoveryAuthorizationRecord,
  type DiscoveryCheckpoint,
  type DiscoveryCounters,
  type DiscoveryHandoff,
  type DiscoveryPolicy,
  type DiscoveryWorkPacket,
  type ExternalLinkRecord,
  type FrontierEntry,
  type Locator,
  type RouteEdge,
} from "@browserswarm/core";
import { checkUrl, type DomainScope } from "@browserswarm/policy-engine";
import { newId, padSequence, truncate, type Clock, type Redactor, systemClock } from "@browserswarm/shared";
import { RunLayout, type EventStore, type StorageAdapter } from "@browserswarm/storage";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { classifyControl, isCookieDeclineLabel } from "./control-safety.js";
import type { ExtractedForm, PageExtract } from "./extract.js";
import type { DiscoveryBlockedRequest } from "./guards.js";
import { extractFromSnapshot } from "./snapshot-extract.js";
import { verifyDiscoveryAuthorization, verifyDiscoveryPacket } from "./packet.js";
import type {
  DiscoveredRouteRef,
  DiscoveryRunResult,
  InteractionRecord,
  RestrictedCandidate,
  RouteObservation,
} from "./types.js";

export interface DiscoveryDeps {
  storage: StorageAdapter;
  events: EventStore;
  redactor: Redactor;
  sessionFactory?: SessionFactory;
  /** Optional Chromium executable for the MCP browser. */
  executablePath?: string;
  clock?: Clock;
  signal?: AbortSignal;
}

const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|auth|sso|account\/login|users\/sign_in)(\/|$|\?)/i;
const MAX_QUERY_VARIANTS_PER_PATH = 3;
const MAX_TOGGLES_PER_ROUTE = 6;
const CHECKPOINT_EVERY_ROUTES = 10;

/** Normalized same-origin route key: path without trailing slash + sorted query, no fragment. */
export function routeKey(raw: string, base: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `${path}${query}`;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * The Discovery Lead Agent: one bounded, read-only work packet in one isolated browser context at a time.
 * It inventories the site breadth-first and never performs a restricted action. When the context
 * lifecycle requires rotation, it checkpoints, writes a handoff, and a replacement instance continues from
 * the persisted frontier in a fresh context.
 */
export class DiscoveryLeadAgent {
  private readonly clock: Clock;
  private readonly scope: DomainScope;
  private readonly base: string;
  private readonly origin: string;
  private readonly policy: DiscoveryPolicy;
  private readonly frontier: FrontierEntry[] = [];
  private readonly discovered = new Map<string, DiscoveredRouteRef>();
  private readonly queryVariants = new Map<string, number>();
  private readonly observations: RouteObservation[] = [];
  private readonly edges: RouteEdge[] = [];
  private readonly edgeKeys = new Set<string>();
  private readonly external: ExternalLinkRecord[] = [];
  private readonly externalKeys = new Set<string>();
  private readonly blockedRequests: DiscoveryBlockedRequest[] = [];
  private readonly blockedRoutes: BlockedRoute[] = [];
  private readonly restricted: RestrictedCandidate[] = [];
  private readonly restrictedKeys = new Set<string>();
  private readonly formSignatures = new Set<string>();
  private readonly checkpoints: string[] = [];
  private readonly handoffs: string[] = [];
  private readonly artifacts = new Set<string>();
  private readonly limitations: string[] = [];
  private counters: DiscoveryCounters = {
    navigations: 0,
    safeInteractions: 0,
    screenshots: 0,
    routesVisited: 0,
    routesDiscovered: 0,
    llmCalls: 0,
  };
  private actionNumber = 0;
  private checkpointSeq = 0;
  private handoffSeq = 0;
  private instanceSeq = 0;
  private instanceId = "";
  private routesWithoutNew = 0;
  private cookieBannerHandled = false;
  private maxDepthReached = 0;
  private startMs = 0;
  private session?: BrowserSession;
  private browser?: DiscoveryBrowser;
  private sessionDir = "";
  private consoleSeen = 0;
  private routeNetwork: Awaited<ReturnType<DiscoveryBrowser["network"]>> = [];
  private challenge = false;
  private lifecycle?: ContextLifecycleManager;

  constructor(
    private readonly packet: DiscoveryWorkPacket,
    private readonly deps: DiscoveryDeps,
  ) {
    verifyDiscoveryPacket(packet);
    this.clock = deps.clock ?? systemClock;
    const r = packet.request;
    this.scope = { allowedDomains: r.allowedDomains, allowSubdomains: r.allowSubdomains };
    this.base = r.targetUrl;
    this.origin = originOf(r.targetUrl);
    this.policy = r.discoveryPolicy;
  }

  private emit(type: Parameters<EventStore["emit"]>[0]["type"], data: Record<string, unknown> = {}): void {
    this.deps.events.emit({ type, packetId: this.packet.packetId, agentInstanceId: this.instanceId, data });
  }

  private r(s: string, max = 300): string {
    return truncate(this.deps.redactor.redactString(s), max);
  }

  private elapsed(): number {
    return this.clock.now() - this.startMs;
  }

  private async ledger(entry: Record<string, unknown>): Promise<void> {
    this.actionNumber++;
    this.lifecycle?.recordBrowserAction();
    await this.deps.storage.appendLine(
      RunLayout.discovery.lead.actions,
      JSON.stringify(
        this.deps.redactor.redactValue({
          actionNumber: this.actionNumber,
          agentInstanceId: this.instanceId,
          timestamp: this.clock.iso(),
          ...entry,
        }),
      ),
    );
  }

  /** Stop conditions checked between routes. Returns the reason, or undefined to continue. */
  private stopReason(): { reason: string; partial: boolean } | undefined {
    const p = this.policy;
    if (this.challenge)
      return {
        reason:
          "BLOCKED: bot_protection_challenge (a challenge page was detected; ask the site owner to allowlist test traffic)",
        partial: true,
      };
    if (this.deps.signal?.aborted) return { reason: "cancelled by user", partial: true };
    if (this.elapsed() >= p.maxDurationMs)
      return { reason: `maxDurationMs (${p.maxDurationMs}) reached`, partial: true };
    if (this.counters.navigations >= p.maxNavigations)
      return { reason: `maxNavigations (${p.maxNavigations}) reached`, partial: true };
    if (this.counters.routesVisited >= p.maxRoutesVisited)
      return { reason: `maxRoutesVisited (${p.maxRoutesVisited}) reached`, partial: true };
    if (this.routesWithoutNew >= p.stopWhenNoNewRoutesAfter && this.counters.routesVisited > 0)
      return {
        reason: `converged: no new routes after ${p.stopWhenNoNewRoutesAfter} consecutive visits`,
        partial: this.frontier.length > 0,
      };
    if (this.frontier.length === 0)
      return { reason: "all reachable safe routes within limits visited", partial: false };
    return undefined;
  }

  async run(authorization: DiscoveryAuthorizationRecord): Promise<DiscoveryRunResult> {
    // Refuse to touch the browser without an authorization bound to this exact packet.
    verifyDiscoveryAuthorization(authorization, this.packet);
    this.startMs = this.clock.now();
    const storage = this.deps.storage;
    await storage.writeJson(RunLayout.discovery.packet, this.packet);
    await storage.writeJson(RunLayout.discovery.authorization, authorization);

    const start = routeKey(this.base, this.base) ?? "/";
    this.addDiscovered(start, this.base, 0, undefined, "entry", false);
    this.frontier.push({ url: new URL(start, this.origin).toString(), depth: 0 });

    let status: DiscoveryRunResult["status"] = "completed";
    let stop = "";
    this.emit("discovery.started", { target: this.base, allowedDomains: this.packet.request.allowedDomains });
    try {
      await this.startInstance();
      let sinceCheckpoint = 0;
      for (;;) {
        const s = this.stopReason();
        if (s) {
          stop = s.reason;
          if (s.partial) status = "partial";
          if (this.challenge) status = "blocked";
          break;
        }
        const decision = this.lifecycle?.evaluate();
        if (decision?.kind === "warn")
          this.emit("discovery.checkpoint.created", { warning: decision.warning.message });
        if (decision?.kind === "rotate") {
          const handoffsUsed = this.handoffSeq;
          if (handoffsUsed >= this.packet.request.contextLifecycle.maxHandoffsPerWorkPacket) {
            stop = `context lifecycle limit (${decision.trigger}) reached and handoff budget exhausted`;
            status = "partial";
            break;
          }
          await this.rotate(decision.reason);
        }
        const entry = this.frontier.shift() as FrontierEntry;
        const before = this.discovered.size;
        await this.visit(entry);
        this.routesWithoutNew = this.discovered.size > before ? 0 : this.routesWithoutNew + 1;
        if (++sinceCheckpoint >= CHECKPOINT_EVERY_ROUTES) {
          sinceCheckpoint = 0;
          await this.writeCheckpoint("route_completed");
        }
        // The entry route failing to load means the target is unreachable.
        if (this.counters.routesVisited === 0 && this.observations.length === 1) {
          const first = this.observations[0] as RouteObservation;
          if (first.status !== "visited") {
            stop = `target unreachable: ${first.error ?? first.status}`;
            status = first.status === "blocked" ? "blocked" : "failed";
            break;
          }
        }
      }
      await this.writeCheckpoint(
        status === "completed" ? "completed" : this.deps.signal?.aborted ? "cancelled" : "limit_reached",
      );
    } catch (error) {
      status =
        error instanceof GatewayBlocked && error.message === "bot_protection_challenge"
          ? "blocked"
          : "failed";
      stop = `unrecoverable error: ${this.r((error as Error).message ?? String(error), 300)}`;
      this.emit("discovery.failed", { error: stop });
    } finally {
      await this.stopInstance().catch(() => undefined);
    }
    if (status !== "completed") this.limitations.push(`Discovery ${status}: ${stop}`);
    if (this.frontier.length)
      this.limitations.push(
        `${this.frontier.length} discovered route(s) were not visited (limits or convergence).`,
      );

    await storage.writeJson(RunLayout.discovery.lead.observations, this.observations);
    await storage.writeJson(RunLayout.discovery.lead.blockedRequests, this.blockedRequests);
    await storage.writeJson(
      RunLayout.discovery.lead.console,
      this.observations.flatMap((o) => o.console.map((c) => ({ route: o.path, ...c }))),
    );
    await storage.writeJson(
      RunLayout.discovery.lead.network,
      this.observations.flatMap((o) => o.network.map((n) => ({ route: o.path, ...n }))),
    );
    for (const p of [
      RunLayout.discovery.packet,
      RunLayout.discovery.authorization,
      RunLayout.discovery.lead.actions,
      RunLayout.discovery.lead.observations,
      RunLayout.discovery.lead.blockedRequests,
      RunLayout.discovery.lead.console,
      RunLayout.discovery.lead.network,
    ])
      this.artifacts.add(p);
    await storage.writeJson(RunLayout.discovery.lead.manifest, {
      runId: this.packet.runId,
      packetId: this.packet.packetId,
      entries: [...this.artifacts].sort().map((path) => ({ path })),
    });
    this.artifacts.add(RunLayout.discovery.lead.manifest);

    const discovered = [...this.discovered.values()];
    this.emit("discovery.completed", {
      status,
      stopReason: stop,
      routesVisited: this.counters.routesVisited,
    });
    return {
      packet: this.packet,
      status,
      stopReason: stop,
      observations: this.observations,
      discovered,
      edges: this.edges,
      externalLinks: this.external,
      blockedRequests: this.blockedRequests,
      blockedRoutes: this.blockedRoutes,
      restricted: this.restricted,
      stats: {
        routesDiscovered: this.discovered.size,
        routesVisited: this.counters.routesVisited,
        maxDepthReached: this.maxDepthReached,
        navigations: this.counters.navigations,
        safeInteractions: this.counters.safeInteractions,
        screenshots: this.counters.screenshots,
        durationMs: Math.max(0, Math.round(this.elapsed())),
        agentInstances: Math.max(1, this.instanceSeq),
        handoffs: this.handoffSeq,
        llmCalls: this.counters.llmCalls,
        stopReason: stop,
      },
      limitations: this.limitations,
      checkpoints: this.checkpoints,
      handoffs: this.handoffs,
      artifacts: [...this.artifacts].sort(),
      maxDepthReached: this.maxDepthReached,
    };
  }

  // ---------------------------------------------------------------------------------------------------
  // Agent instances and browser contexts
  // ---------------------------------------------------------------------------------------------------

  private async startInstance(previous?: string, handoffId?: string): Promise<void> {
    this.instanceSeq++;
    this.instanceId = `discovery-lead-i${padSequence(this.instanceSeq, 2)}`;
    this.lifecycle = new ContextLifecycleManager(this.packet.request.contextLifecycle, {
      agentInstanceId: this.instanceId,
      model: this.packet.request.model,
      clock: this.clock,
    });
    const primary = Object.values(this.policy.viewports)[0] ?? { width: 1440, height: 900 };
    const r = this.packet.request;
    const onBlocked = (x: DiscoveryBlockedRequest) => {
      const item = { ...x, url: this.r(x.url, 500) };
      if (this.blockedRequests.length < 500) this.blockedRequests.push(item);
      this.emit("discovery.request.blocked", { url: item.url, method: item.method, kind: item.kind });
    };
    /* Each instance owns one MCP server, one private directory and independent browser state. */
    this.sessionDir = this.deps.storage.resolve(`${RunLayout.discovery.lead.dir}/mcp/${this.instanceId}`);
    const factory: SessionFactory = this.deps.sessionFactory ?? ((o) => new McpBrowserSession(o));
    const signal = this.deps.signal ?? new AbortController().signal;
    this.session = factory({
      packet: {
        browser: r.browser,
        viewport: primary,
        targetUrl: r.targetUrl,
        allowedDomains: r.allowedDomains,
        allowSubdomains: r.allowSubdomains,
        timeoutMs: Math.max(1000, this.policy.maxDurationMs),
        workPacketHash: this.packet.packetHash,
      },
      artifactDir: this.sessionDir,
      signal,
      readOnly: true,
      ...(this.deps.executablePath ? { executablePath: this.deps.executablePath } : {}),
    });
    await this.session.start();
    this.consoleSeen = 0;
    this.browser = new DiscoveryBrowser({
      session: this.session,
      scope: this.scope,
      base: this.base,
      artifactDir: this.sessionDir,
      redactor: this.deps.redactor,
      signal,
      onBlocked: (b) => onBlocked({ ...b }),
    });
    await this.deps.storage.writeJson(RunLayout.discovery.lead.agentInstance(this.instanceId), {
      agentInstanceId: this.instanceId,
      runId: this.packet.runId,
      workPacketId: this.packet.packetId,
      sequence: this.instanceSeq,
      kind: "scripted",
      model: this.packet.request.model,
      startedAt: this.clock.iso(),
      ...(previous ? { previousAgentInstanceId: previous } : {}),
      ...(handoffId ? { sourceHandoffId: handoffId } : {}),
    });
    this.artifacts.add(RunLayout.discovery.lead.agentInstance(this.instanceId));
  }

  private async stopInstance(): Promise<void> {
    if (!this.session) return;
    await this.browser?.newBlocks().catch(() => undefined);
    await this.session.close().catch(() => undefined);
    /* MCP writes traces (*.trace) and other evidence under the private directory; record them. */
    const dir = path.join(this.deps.storage.resolve(RunLayout.discovery.lead.dir), "mcp", this.instanceId);
    for (const f of await readdir(dir, { recursive: true }).catch(() => [] as string[]))
      if (/\.(trace|network|png)$/.test(String(f)))
        this.artifacts.add(`${RunLayout.discovery.lead.dir}/mcp/${this.instanceId}/${String(f)}`);
    this.session = undefined;
    this.browser = undefined;
  }

  private async rotate(reason: string): Promise<void> {
    const cp = await this.writeCheckpoint("rotation");
    const previous = this.instanceId;
    this.handoffSeq++;
    const p = this.policy;
    const base: Omit<DiscoveryHandoff, "integrityHash"> = {
      version: 1,
      handoffId: newId("dhandoff"),
      runId: this.packet.runId,
      packetId: this.packet.packetId,
      previousAgentInstanceId: previous,
      createdAt: this.clock.iso(),
      packetHash: this.packet.packetHash,
      sourceCheckpointId: cp.checkpointId,
      trigger: truncate(reason, 200),
      mission:
        "Continue bounded, read-only discovery of the allowed domains from the persisted frontier. Inventory only; never perform restricted actions.",
      progress: {
        routesVisited: this.counters.routesVisited,
        routesDiscovered: this.discovered.size,
        frontierSize: this.frontier.length,
      },
      remainingBudgets: {
        navigations: Math.max(0, p.maxNavigations - this.counters.navigations),
        safeInteractions: Math.max(0, p.maxSafeInteractions - this.counters.safeInteractions),
        screenshots: Math.max(0, p.maxScreenshots - this.counters.screenshots),
        durationMs: Math.max(0, Math.round(p.maxDurationMs - this.elapsed())),
      },
      doNotRepeat: [
        `Do not revisit the ${this.observations.length} route(s) already observed (see checkpoint visited list).`,
      ],
      policyReminders: this.packet.guarantees.slice(1, 6).map((g) => truncate(g, 300)),
      conciseStatusSummary: truncate(
        `Visited ${this.counters.routesVisited} route(s), discovered ${this.discovered.size}, ${this.frontier.length} queued. Restricted candidates recorded: ${this.restricted.length}.`,
        1000,
      ),
    };
    await this.stopInstance();
    await settle();
    await this.startInstance(previous, base.handoffId);
    const doc: DiscoveryHandoff = {
      ...base,
      replacementAgentInstanceId: this.instanceId,
      integrityHash: computeDiscoveryHandoffHash({ ...base, replacementAgentInstanceId: this.instanceId }),
    };
    const L = RunLayout.discovery.lead;
    await this.deps.storage.writeJson(L.handoff(this.handoffSeq), doc);
    await this.deps.storage.writeText(L.handoffHash(this.handoffSeq), `${doc.integrityHash}\n`);
    await this.deps.storage.writeText(L.handoffMarkdown(this.handoffSeq), renderHandoffMarkdown(doc));
    for (const x of [
      L.handoff(this.handoffSeq),
      L.handoffHash(this.handoffSeq),
      L.handoffMarkdown(this.handoffSeq),
    ])
      this.artifacts.add(x);
    this.handoffs.push(L.handoff(this.handoffSeq));
    this.emit("discovery.handoff.created", {
      handoffId: doc.handoffId,
      previous,
      replacement: this.instanceId,
      reason,
    });
  }

  private async writeCheckpoint(reason: DiscoveryCheckpoint["reason"]): Promise<DiscoveryCheckpoint> {
    this.checkpointSeq++;
    const base: Omit<DiscoveryCheckpoint, "integrityHash"> = {
      version: 1,
      checkpointId: newId("dcp"),
      sequence: this.checkpointSeq,
      runId: this.packet.runId,
      packetId: this.packet.packetId,
      agentInstanceId: this.instanceId || "discovery-lead-i01",
      createdAt: this.clock.iso(),
      reason,
      packetHash: this.packet.packetHash,
      frontier: this.frontier.map((f) => ({ ...f })),
      visited: this.observations.map((o) => o.path),
      counters: { ...this.counters, routesDiscovered: this.discovered.size },
      elapsedMs: Math.max(0, Math.round(this.elapsed())),
    };
    const cp: DiscoveryCheckpoint = { ...base, integrityHash: computeDiscoveryCheckpointHash(base) };
    const L = RunLayout.discovery.lead;
    await this.deps.storage.writeJson(L.checkpoint(cp.sequence), cp);
    await this.deps.storage.writeText(L.checkpointHash(cp.sequence), `${cp.integrityHash}\n`);
    this.artifacts.add(L.checkpoint(cp.sequence));
    this.artifacts.add(L.checkpointHash(cp.sequence));
    this.checkpoints.push(L.checkpoint(cp.sequence));
    this.emit("discovery.checkpoint.created", {
      checkpointId: cp.checkpointId,
      sequence: cp.sequence,
      reason,
    });
    return cp;
  }

  // ---------------------------------------------------------------------------------------------------
  // Route visiting
  // ---------------------------------------------------------------------------------------------------

  private addDiscovered(
    key: string,
    url: string,
    depth: number,
    from: string | undefined,
    label: string,
    authPage: boolean,
  ): boolean {
    if (this.discovered.has(key)) return false;
    if (this.discovered.size >= this.policy.maxRoutesDiscovered) return false;
    const pathOnly = key.split("?")[0] as string;
    if (key.includes("?")) {
      const n = this.queryVariants.get(pathOnly) ?? 0;
      if (n >= MAX_QUERY_VARIANTS_PER_PATH) return false;
      this.queryVariants.set(pathOnly, n + 1);
    }
    this.discovered.set(key, {
      path: key,
      url,
      depth,
      from,
      label: this.r(label, 200),
      visited: false,
      authPage,
    });
    this.counters.routesDiscovered = this.discovered.size;
    return true;
  }

  private addEdge(edge: RouteEdge): void {
    const k = `${edge.from}->${edge.to}:${edge.kind}`;
    if (this.edgeKeys.has(k) || this.edges.length >= 2000) return;
    this.edgeKeys.add(k);
    this.edges.push({ ...edge, label: this.r(edge.label, 200) });
  }

  private addRestricted(c: RestrictedCandidate): void {
    const k = `${c.route}|${c.kind}|${c.label}|${c.category}`;
    if (this.restrictedKeys.has(k) || this.restricted.length >= 1000) return;
    this.restrictedKeys.add(k);
    this.restricted.push({ ...c, label: this.r(c.label, 200), reason: this.r(c.reason, 500) });
    this.emit("discovery.control.restricted", {
      route: c.route,
      label: this.r(c.label, 100),
      category: c.category,
    });
  }

  private async visit(entry: FrontierEntry): Promise<void> {
    const browser = this.browser as DiscoveryBrowser;
    const key = routeKey(entry.url, this.base) ?? entry.url;
    const ref = this.discovered.get(key);
    const obs: RouteObservation = {
      evidenceId: `ev-route-${padSequence(this.observations.length + 1, 3)}`,
      path: key,
      url: this.r(entry.url, 500),
      depth: entry.depth,
      ...(entry.from ? { from: entry.from } : {}),
      status: "visited",
      requiresAuth: false,
      overflow: [],
      console: [],
      network: [],
      interactions: [],
      searchExercises: [],
    };
    this.observations.push(obs);
    if (ref) ref.visited = true;
    this.maxDepthReached = Math.max(this.maxDepthReached, entry.depth);

    const check = checkUrl(entry.url, this.base, this.scope);
    if (!check.allowed || !check.url) {
      obs.status = "blocked";
      obs.error = check.reason ?? "outside allowed domains";
      this.blockedRoutes.push({ path: key, reason: obs.error, category: "external_navigation" });
      return;
    }

    const started = this.clock.now();
    this.counters.navigations++;
    let response: { status?: number; url: string };
    try {
      response = await browser.goto(check.url);
    } catch (error) {
      if (error instanceof GatewayBlocked && error.message === "bot_protection_challenge") {
        this.challenge = true;
        obs.status = "blocked";
        obs.error = "BLOCKED: bot_protection_challenge";
        this.blockedRoutes.push({ path: key, reason: obs.error, category: "external_navigation" });
        return;
      }
      obs.status = error instanceof GatewayBlocked ? "blocked" : "error";
      obs.error = this.r(((error as Error).message ?? String(error)).split("\n")[0] ?? "navigation failed");
      this.blockedRoutes.push({ path: key, reason: obs.error });
      await this.ledger({
        kind: "navigate",
        route: key,
        status: "failed",
        error: obs.error,
        durationMs: this.clock.now() - started,
      });
      return;
    }
    this.counters.routesVisited++;
    obs.httpStatus = response.status;
    const finalKey = routeKey(browser.url, this.base) ?? key;
    if (finalKey !== key) {
      obs.redirectedTo = finalKey;
      this.addEdge({ from: key, to: finalKey, label: "redirect", kind: "redirect" });
      if (LOGIN_PATH.test(finalKey) && !LOGIN_PATH.test(key)) {
        obs.requiresAuth = true;
        obs.authSignal = "redirect-to-login";
      }
      this.addDiscovered(
        finalKey,
        browser.url,
        entry.depth,
        key,
        "redirect target",
        LOGIN_PATH.test(finalKey),
      );
      const t = this.discovered.get(finalKey);
      if (t) t.visited = true;
    }
    if (obs.httpStatus === 401 || obs.httpStatus === 403) {
      obs.requiresAuth = true;
      obs.authSignal = obs.httpStatus === 401 ? "http-401" : "http-403";
    }
    await this.ledger({
      kind: "navigate",
      route: key,
      status: "passed",
      httpStatus: obs.httpStatus,
      durationMs: this.clock.now() - started,
    });
    this.emit("discovery.route.visited", { route: key, depth: entry.depth, httpStatus: obs.httpStatus });

    await this.maybeDismissCookieBanner(obs);

    let extract: PageExtract | undefined;
    try {
      extract = this.deps.redactor.redactValue(this.extractCurrent());
    } catch (error) {
      obs.error = this.r(`extraction failed: ${(error as Error).message}`);
    }
    if (extract) {
      obs.extract = extract;
      if (!obs.requiresAuth && extract.loginSignals.passwordField) obs.authSignal = "login-form";
      if (extract.truncated)
        this.limitations.push(
          `Route ${key}: interactive elements capped at ${this.policy.maxUniqueInteractiveElementsPerRoute}.`,
        );
      this.collectLinks(obs, extract, entry.depth);
      this.collectControls(obs, extract);
      this.collectForms(obs, extract);
    }

    await this.capture(obs, key);
    if (extract && !obs.requiresAuth) {
      await this.safeToggles(obs, extract, key);
      await this.searchAndFilters(obs, extract, entry.depth);
    }
    await this.collectDiagnostics(obs);
    this.lifecycle?.recordObservation(
      `${key} ${extract?.title ?? ""} ${(extract?.headings ?? []).map((h) => h.text).join(" ")} links:${extract?.links.length ?? 0}`,
    );
  }

  private collectLinks(obs: RouteObservation, extract: PageExtract, depth: number): void {
    for (const link of extract.links) {
      const safety = classifyControl({
        tag: "a",
        label: link.text,
        href: link.href,
        download: link.download,
        inPagination: link.region === "pagination",
      });
      const target = routeKey(link.href, this.base);
      const check = link.href ? checkUrl(link.href, this.base, this.scope) : { allowed: false };
      if (safety.kind === "restricted") {
        this.addRestricted({
          route: obs.path,
          kind: "link",
          label: link.text || link.href,
          category: safety.category,
          reason: safety.reason,
          ...(link.text ? { locator: { role: "link", name: link.text } } : {}),
        });
        continue;
      }
      if (!check.allowed || !target) {
        if (/^https?:/i.test(link.href) && this.external.length < this.policy.maxExternalLinksRecorded) {
          let host = "";
          try {
            host = new URL(link.href).hostname;
          } catch {
            /* ignore */
          }
          const k = link.href;
          if (!this.externalKeys.has(k)) {
            this.externalKeys.add(k);
            this.external.push({
              url: this.r(link.href, 500),
              host,
              fromRoute: obs.path,
              label: this.r(link.text, 200),
            });
          }
        }
        continue;
      }
      if (target === obs.path) continue;
      const kind = safety.kind === "safe-pagination" ? "pagination" : "link";
      if (safety.kind === "safe-pagination" && !this.policy.allowReadOnlyPagination) continue;
      this.addEdge({ from: obs.path, to: target, label: link.text || target, kind });
      const nextDepth = depth + 1;
      const authPage = safety.kind === "safe-navigation" && safety.authPage;
      if (this.addDiscovered(target, check.url ?? link.href, nextDepth, obs.path, link.text, authPage)) {
        if (nextDepth <= this.policy.maxNavigationDepth)
          this.frontier.push({ url: check.url ?? link.href, depth: nextDepth, from: obs.path });
      }
    }
  }

  private collectControls(obs: RouteObservation, extract: PageExtract): void {
    for (const c of extract.controls) {
      if (c.inCookieBanner) continue;
      const safety = classifyControl({
        tag: c.tag,
        role: c.role,
        type: c.type,
        label: c.label,
        inForm: c.inForm,
        ariaExpanded: c.ariaExpanded,
        ariaControls: c.ariaControls,
        ariaHasPopup: c.ariaHasPopup,
        inPagination: c.inPagination,
      });
      if (safety.kind !== "restricted") continue;
      const kind = c.tag === "input" ? (c.type === "file" ? "input" : "button") : "button";
      this.addRestricted({
        route: obs.path,
        kind,
        label: c.label || c.testId || c.tag,
        category: safety.category,
        reason: safety.reason,
        ...(c.label
          ? { locator: { role: "button", name: c.label } }
          : c.testId
            ? { locator: { testId: c.testId } }
            : {}),
      });
    }
  }

  private collectForms(obs: RouteObservation, extract: PageExtract): void {
    for (const f of extract.forms) {
      const sig = `${f.method}|${routeKey(f.action, this.base) ?? f.action}|${f.fields.map((x) => x.name).join(",")}`;
      if (this.formSignatures.has(sig)) continue;
      if (this.formSignatures.size >= this.policy.maxUniqueFormsInventoried) {
        this.limitations.push(
          `Form inventory capped at ${this.policy.maxUniqueFormsInventoried} unique forms.`,
        );
        break;
      }
      this.formSignatures.add(sig);
      if (isReadOnlyQueryForm(f, this.base, this.scope)) continue;
      this.addRestricted({
        route: obs.path,
        kind: "form",
        label: f.name || f.submitLabel || `form ${f.index + 1}`,
        category: f.hasPassword ? "authentication" : f.hasFile ? "file_upload" : "form_submission",
        reason: `${f.method.toUpperCase()} form "${f.submitLabel || f.name || "unnamed"}" may persist data; never submitted during discovery`,
      });
    }
  }

  private extractCurrent(max = this.policy.maxUniqueInteractiveElementsPerRoute): PageExtract {
    const browser = this.browser as DiscoveryBrowser;
    return extractFromSnapshot(browser.snapshotText, {
      url: browser.url,
      title: browser.title,
      maxInteractive: max,
    });
  }

  /** Console and failed-request evidence read through the gateway (redacted, bounded). */
  private async collectDiagnostics(obs: RouteObservation): Promise<void> {
    const browser = this.browser as DiscoveryBrowser;
    const at = this.clock.iso();
    try {
      const all = await browser.console();
      const fresh = all.slice(this.consoleSeen);
      this.consoleSeen = all.length;
      obs.console = fresh
        .slice(0, 50)
        .map((c) => ({ type: c.type, text: this.r(c.text, 300), url: obs.url, at }));
    } catch {
      /* diagnostics are best effort */
    }
    const net = this.routeNetwork;
    obs.network = net
      .filter((n) => n.status === undefined || n.status >= 400)
      .slice(0, 50)
      .map((n) => ({
        url: this.r(n.url, 500),
        method: n.method,
        ...(n.status !== undefined ? { status: n.status } : { failure: "request failed" }),
        resourceType: "unknown",
        at,
      }));
  }

  private async capture(obs: RouteObservation, key: string): Promise<void> {
    const browser = this.browser as DiscoveryBrowser;
    const tag = padSequence(this.observations.length, 3);
    try {
      this.routeNetwork = await browser.network();
    } catch {
      this.routeNetwork = [];
    }
    if (
      this.counters.screenshots < this.policy.maxScreenshots &&
      this.packet.request.browser.screenshot !== "off"
    ) {
      try {
        const file = await browser.screenshot(`route-${tag}.png`);
        const rel = path.relative(this.deps.storage.root, file).split(path.sep).join("/");
        this.counters.screenshots++;
        obs.screenshot = rel;
        this.artifacts.add(rel);
        await this.ledger({ kind: "screenshot", route: key, status: "passed", evidence: rel });
      } catch (error) {
        if (error instanceof GatewayBlocked && error.message === "bot_protection_challenge") throw error;
      }
    }
    /* The MCP toolset exposes neither an axe engine nor viewport resizing to discovery, so these two
       measurements are explicitly unavailable rather than reported as clean. */
  }

  private budgetLeft(): boolean {
    return this.counters.safeInteractions < this.policy.maxSafeInteractions;
  }

  private async maybeDismissCookieBanner(obs: RouteObservation): Promise<void> {
    if (this.cookieBannerHandled || !this.policy.allowCookieBannerDismissal) return;
    const browser = this.browser as DiscoveryBrowser;
    let extract: PageExtract;
    try {
      extract = this.extractCurrent();
    } catch {
      return;
    }
    if (!extract.cookieBanner.present) return;
    this.cookieBannerHandled = true;
    const decline = extract.controls.find(
      (c) => c.inCookieBanner && c.visible && isCookieDeclineLabel(c.label),
    );
    if (!decline || !this.budgetLeft()) {
      this.limitations.push(
        "A cookie/consent banner was present without a reject/necessary-only control; it was left untouched (content behind it may be partially hidden).",
      );
      return;
    }
    try {
      if (!decline.ref) throw new Error("no ref");
      await browser.click(decline.ref, decline.label);
      this.counters.safeInteractions++;
      obs.interactions.push({ kind: "cookie-banner", label: this.r(decline.label, 200), outcome: "ok" });
      await this.ledger({
        kind: "cookie-banner-decline",
        route: obs.path,
        label: decline.label,
        status: "passed",
      });
      this.emit("discovery.interaction", {
        route: obs.path,
        kind: "cookie-banner",
        label: this.r(decline.label, 100),
      });
    } catch (error) {
      if (error instanceof GatewayBlocked && error.message === "bot_protection_challenge") throw error;
      obs.interactions.push({ kind: "cookie-banner", label: this.r(decline.label, 200), outcome: "error" });
    }
  }

  private async safeToggles(obs: RouteObservation, extract: PageExtract, key: string): Promise<void> {
    if (!this.policy.allowNonPersistentTabsAndAccordions && !this.policy.allowReadOnlyPagination) return;
    const browser = this.browser as DiscoveryBrowser;
    let done = 0;
    /* Candidates are identified by role and label; the ref is re-resolved from a fresh snapshot for
       every click so a stale ref can never be reused. */
    const candidates = extract.controls.filter((c) => c.visible && !c.inCookieBanner && c.label);
    for (const cand of candidates) {
      if (done >= MAX_TOGGLES_PER_ROUTE || !this.budgetLeft()) break;
      const safetyOf = (c: PageExtract["controls"][number]) =>
        classifyControl({
          tag: c.tag,
          role: c.role,
          type: c.type,
          label: c.label,
          inForm: c.inForm,
          ariaExpanded: c.ariaExpanded,
          ariaControls: c.ariaControls,
          ariaHasPopup: c.ariaHasPopup,
          inPagination: c.inPagination,
        });
      const safety = safetyOf(cand);
      let kind: InteractionRecord["kind"];
      let locator: Locator | undefined;
      if (safety.kind === "safe-toggle" && this.policy.allowNonPersistentTabsAndAccordions) {
        if (cand.role === "tab") {
          kind = "tab";
          locator = { role: "tab", name: cand.label };
        } else if (cand.ariaHasPopup && cand.ariaHasPopup !== "false") {
          kind = "menu";
          locator = { role: "button", name: cand.label };
        } else {
          kind = "accordion";
          locator = { role: "button", name: cand.label };
        }
      } else if (safety.kind === "safe-pagination" && this.policy.allowReadOnlyPagination) {
        kind = "pagination";
        locator = { role: "button", name: cand.label };
      } else continue;
      const started = this.clock.now();
      try {
        await browser.snapshot();
        const fresh = this.extractCurrent().controls.find(
          (c) => c.role === cand.role && c.label === cand.label && c.ref,
        );
        if (!fresh?.ref) continue;
        /* Re-classify against the fresh snapshot before acting on it. */
        if (safetyOf(fresh).kind === "restricted") continue;
        await browser.click(fresh.ref, cand.label);
        this.counters.safeInteractions++;
        done++;
        let outcome: InteractionRecord["outcome"] = "ok";
        const now = routeKey(browser.url, this.base);
        if (now !== key) {
          /* A "toggle" navigated: record the edge and return to the route (read-only GET). */
          if (now)
            this.addEdge({
              from: key,
              to: now,
              label: cand.label,
              kind: kind === "pagination" ? "pagination" : "link",
            });
          this.counters.navigations++;
          await browser.goto(new URL(key, this.origin).toString()).catch(() => undefined);
          outcome = "navigated-back";
        }
        obs.interactions.push({
          kind,
          label: this.r(cand.label, 200),
          outcome,
          ...(locator ? { locator } : {}),
        });
        await this.ledger({
          kind: `toggle:${kind}`,
          route: key,
          label: cand.label,
          status: "passed",
          durationMs: this.clock.now() - started,
        });
        this.emit("discovery.interaction", { route: key, kind, label: this.r(cand.label, 100) });
      } catch (error) {
        if (error instanceof GatewayBlocked && error.message === "bot_protection_challenge") throw error;
        obs.interactions.push({
          kind,
          label: this.r(cand.label, 200),
          outcome: "error",
          ...(locator ? { locator } : {}),
        });
      }
    }
  }

  /**
   * Read-only search: a search landmark is exercised by typing a word already visible on the page and
   * submitting it. The in-server request guard permits only GET/HEAD, so a form that would write is
   * blocked and recorded instead of sent. Snapshots do not expose form actions or field names, so the
   * query parameter is inferred from the resulting URL.
   */
  private async searchAndFilters(obs: RouteObservation, extract: PageExtract, depth: number): Promise<void> {
    if (!this.policy.allowSearchAndFilters) return;
    const browser = this.browser as DiscoveryBrowser;
    let moved = false;
    for (const f of extract.forms) {
      if (!this.budgetLeft() || this.counters.navigations >= this.policy.maxNavigations) break;
      if (!isReadOnlyQueryForm(f, this.base, this.scope) || !f.inputRef) continue;
      const term = pickSearchTerm(extract);
      if (!term) continue;
      const started = this.clock.now();
      try {
        await browser.snapshot();
        const input = this.extractCurrent().forms.find((x) => x.inSearchLandmark && x.index === f.index);
        if (!input?.inputRef) continue;
        this.counters.navigations++;
        this.counters.safeInteractions++;
        const beforeBlocked = this.blockedRequests.length;
        await browser.typeAndSubmit(input.inputRef, f.fields[0]?.label || "search", term);
        await browser.newBlocks();
        if (this.blockedRequests.length > beforeBlocked) {
          this.limitations.push(`Search on ${obs.path} attempted a blocked request; recorded, not sent.`);
          continue;
        }
        const target = new URL(browser.url);
        const key = routeKey(target.toString(), this.base);
        if (!key || key === obs.path) continue;
        moved = true;
        const paramName = [...target.searchParams.entries()].find(([, v]) => v === term)?.[0] ?? "";
        const after = this.extractCurrent(50);
        const resultsObserved =
          after.links.length > 0 || after.tables.some((t) => t.rowCount > 0) || after.cards.length > 0;
        obs.searchExercises.push({
          kind: "search",
          formIndex: f.index,
          paramName,
          term: this.r(term, 80),
          path: key,
          resultsObserved,
        });
        this.addEdge({ from: obs.path, to: key, label: `search: ${term}`, kind: "search" });
        this.addDiscovered(key, target.toString(), depth + 1, obs.path, "search results", false);
        const ref = this.discovered.get(key);
        if (ref) ref.visited = true;
        await this.ledger({
          kind: "read-only-search",
          route: obs.path,
          target: key,
          status: "passed",
          durationMs: this.clock.now() - started,
        });
        this.emit("discovery.interaction", { route: obs.path, kind: "search", target: key });
        this.counters.navigations++;
        await browser.goto(new URL(obs.path, this.origin).toString()).catch(() => undefined);
        moved = false;
      } catch (error) {
        if (error instanceof GatewayBlocked && error.message === "bot_protection_challenge") throw error;
        this.limitations.push(
          `Read-only search on ${obs.path} failed: ${this.r((error as Error).message, 120)}`,
        );
      }
    }
    if (moved) {
      this.counters.navigations++;
      await browser.goto(new URL(obs.path, this.origin).toString()).catch(() => undefined);
    }
  }
}

/** A GET form on an allowed domain with only query-style fields (no password/email/file/textarea). */
export function isReadOnlyQueryForm(f: ExtractedForm, base: string, scope: DomainScope): boolean {
  if (f.method !== "get") return false;
  if (f.hasPassword || f.hasFile) return false;
  if (!f.fields.length) return false;
  const allowedTypes = new Set(["search", "text", "select", "checkbox", "radio", "number", "range", "date"]);
  if (!f.fields.every((x) => allowedTypes.has(x.type))) return false;
  const looksLikeQuery =
    f.inSearchLandmark ||
    f.role === "search" ||
    f.fields.some(
      (x) =>
        x.type === "search" ||
        /^(q|query|search|s|term|keyword|keywords|filter|sort|category|type)$/i.test(x.name),
    ) ||
    /search|filter|find/i.test(`${f.name} ${f.submitLabel}`);
  if (!looksLikeQuery) return false;
  return checkUrl(f.action, base, scope).allowed;
}

/** A search term taken from the page's own headings/text: never invented data. */
function pickSearchTerm(extract: PageExtract): string {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "your",
    "from",
    "this",
    "that",
    "home",
    "search",
    "page",
    "menu",
  ]);
  const words = [...extract.headings.map((h) => h.text), ...extract.cards.map((c) => c.heading)]
    .join(" ")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 4 && !stop.has(w.toLowerCase()) && !/^\d+$/.test(w));
  return words[0] ?? "";
}

async function settle(): Promise<void> {
  // Yield once so pending route/close handlers of the retired context settle before the replacement starts.
  await new Promise((r) => setTimeout(r, 0));
}

function renderHandoffMarkdown(doc: DiscoveryHandoff): string {
  return [
    `# Discovery handoff ${doc.handoffId}`,
    "",
    `- Previous instance: ${doc.previousAgentInstanceId}`,
    `- Replacement instance: ${doc.replacementAgentInstanceId ?? "(pending)"}`,
    `- Trigger: ${doc.trigger}`,
    `- Source checkpoint: ${doc.sourceCheckpointId}`,
    `- Progress: ${doc.progress.routesVisited} visited, ${doc.progress.routesDiscovered} discovered, ${doc.progress.frontierSize} queued`,
    `- Remaining budgets: ${doc.remainingBudgets.navigations} navigations, ${doc.remainingBudgets.safeInteractions} safe interactions, ${doc.remainingBudgets.screenshots} screenshots, ${Math.round(doc.remainingBudgets.durationMs / 1000)}s`,
    "",
    "## Mission",
    doc.mission,
    "",
    "## Policy reminders",
    ...doc.policyReminders.map((p) => `- ${p}`),
    "",
    `Integrity: ${doc.integrityHash}`,
    "",
  ].join("\n");
}
