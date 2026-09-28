import {
  AgentInstanceHandle,
  ScriptedAgent,
  type AgentHost,
  type AgentRunResult,
  type StepStatusResult,
} from "@browserswarm/agent-runtime";
import {
  captureFailureEvidence,
  executeStep,
  installDomainGuard,
  PageObservers,
  type BlockedRequest,
  type BrowserHandle,
  type StepExecutionContext,
} from "@browserswarm/browser-tools";
import {
  BrowserSwarmError,
  describeStep,
  handoffStateMachine,
  TrackedState,
  workPacketStateMachine,
  type AgentCheckpoint,
  type AgentEventType,
  type AgentInstance,
  type ArtifactManifest,
  type BrowserActionResult,
  type CheckpointReason,
  type Evidence,
  type Finding,
  type HandoffState,
  type HandoffSummary,
  type PacketOutcome,
  type PacketReport,
  type Severity,
  type StepResultSummary,
  type TestStep,
  type WorkPacket,
  type WorkPacketState,
} from "@browserswarm/core";
import {
  createCheckpoint,
  DeterministicHandoffWriter,
  persistCheckpoint,
  persistHandoff,
  replacementPreflight,
  type ReplacementAgentFactory,
} from "@browserswarm/handoff";
import {
  checkAction,
  checkHandoff,
  checkUrl,
  classifyStep,
  resolveTemplate,
  type ResolvedTestData,
} from "@browserswarm/policy-engine";
import { canonicalize, newId, truncate, type Clock, type Redactor } from "@browserswarm/shared";
import { packetRelative, RunLayout, type EventStore, type StorageAdapter } from "@browserswarm/storage";
import type { BrowserContext, Page } from "playwright";

export interface PacketRunnerDeps {
  storage: StorageAdapter;
  events: EventStore;
  browser: BrowserHandle;
  clock: Clock;
  approvedExecutionPlanHash: string;
  riskApproved: boolean;
  testData: ResolvedTestData;
  redactor: Redactor;
  signal: AbortSignal;
  verifySeverityAtOrAbove: Severity;
  /** Milestone 3 plugs in automatic replacement. Without it a rotation blocks the packet after the handoff. */
  replacementFactory?: ReplacementAgentFactory;
}

export interface PacketRunResult {
  report: PacketReport;
  findings: Finding[];
  contextWarnings: number;
  checkpoints: number;
  blockedByHandoffLimit: boolean;
  blockedByCheckpointFailure: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Runs one immutable work packet in its own BrowserContext with its own ledger, evidence, checkpoint chain
 * and handoff chain. The packet state machine is enforced and every transition is persisted and emitted.
 */
export class PacketRunner {
  private readonly layout;
  private readonly state: TrackedState<WorkPacketState>;
  private readonly stepResults = new Map<number, StepResultSummary>();
  private readonly ledger: BrowserActionResult[] = [];
  private readonly findings: Finding[] = [];
  private readonly instances: AgentInstanceHandle[] = [];
  private readonly handoffs: HandoffSummary[] = [];
  private readonly rotationReasons: string[] = [];
  private readonly manifest: ArtifactManifest;
  private readonly blockedRequests: BlockedRequest[] = [];
  private readonly confirmedFacts: string[] = [];
  private context?: BrowserContext;
  private page?: Page;
  private observers?: PageObservers;
  private agent?: ScriptedAgent;
  private actionCount = 0;
  private checkpointSeq = 0;
  private handoffSeq = 0;
  private contextWarnings = 0;
  private lastCheckpoint?: AgentCheckpoint;
  private latestScreenshot?: string;
  private startMs = 0;
  private outcome: PacketOutcome = "error";
  private outcomeReason?: string;
  private resumeOutcome = "not_required";
  private blockedByHandoffLimit = false;
  private blockedByCheckpointFailure = false;

  constructor(
    private readonly packet: WorkPacket,
    private readonly deps: PacketRunnerDeps,
    initialState: WorkPacketState = "PENDING",
  ) {
    this.layout = RunLayout.packet(packet.packetId);
    this.manifest = { runId: packet.runId, packetId: packet.packetId, entries: [] };
    this.state = new TrackedState(workPacketStateMachine, initialState, undefined, () => deps.clock.iso());
  }

  get currentState(): WorkPacketState {
    return this.state.state;
  }

  private emit(type: AgentEventType, data: Record<string, unknown> = {}, agentInstanceId?: string): void {
    this.deps.events.emit({
      type,
      packetId: this.packet.packetId,
      ...(agentInstanceId ? { agentInstanceId } : {}),
      data,
    });
  }

  private async transition(to: WorkPacketState, reason?: string): Promise<void> {
    const from = this.state.state;
    this.state.to(to, reason);
    this.emit("packet.state.changed", { from, to, ...(reason ? { reason } : {}) });
    await this.deps.storage.writeJson(this.layout.state, {
      packetId: this.packet.packetId,
      state: to,
      history: this.state.transitions,
    });
  }

  private track(path: string, type: ArtifactManifest["entries"][number]["type"]): void {
    this.manifest.entries.push({
      path: packetRelative(path, this.packet.packetId),
      type,
      createdAt: this.deps.clock.iso(),
    });
  }

  /** PENDING -> QUEUED: the packet has a place in the concurrency queue. */
  async queue(): Promise<void> {
    await this.transition("QUEUED");
    this.emit("packet.queued", { role: this.packet.role, viewport: this.packet.viewportName });
  }

  private resolveValue = (value: string): string =>
    resolveTemplate(value, this.deps.testData, this.packet.runId);

  async run(): Promise<PacketRunResult> {
    const { storage } = this.deps;
    this.startMs = this.deps.clock.now();
    await storage.writeJson(this.layout.workPacket, this.packet);
    this.track(this.layout.workPacket, "work-packet");

    let result: AgentRunResult | undefined;
    try {
      if (this.deps.signal.aborted) {
        await this.transition("CANCELLED", "run cancelled before packet start");
        this.outcome = "cancelled";
        return await this.finish();
      }
      await this.transition("RUNNING");
      this.emit("packet.started", { role: this.packet.role, viewport: this.packet.viewportName });
      await this.openContext();
      const instance = this.newInstance();
      this.agent = new ScriptedAgent(instance, this.packet, this.deps.clock);
      result = await this.agent.run(this.host(), 0);
      await this.handleResult(result);
    } catch (error) {
      await this.handleCrash(error);
    } finally {
      await this.closeContext();
    }
    return this.finish();
  }

  private newInstance(previous?: AgentInstanceHandle, handoffId?: string): AgentInstanceHandle {
    const handle = new AgentInstanceHandle({
      runId: this.packet.runId,
      workPacketId: this.packet.packetId,
      sequence: this.instances.length + 1,
      kind: "scripted",
      model: this.packet.model,
      clock: this.deps.clock,
      ...(previous ? { previousAgentInstanceId: previous.id } : {}),
      ...(handoffId ? { sourceHandoffId: handoffId } : {}),
      onTransition: (rec, from, to, reason) =>
        this.emit("agent.state.changed", { from, to, ...(reason ? { reason } : {}) }, rec.agentInstanceId),
    });
    this.instances.push(handle);
    return handle;
  }

  private async openContext(): Promise<void> {
    const { browser } = this.packet;
    this.context = await this.deps.browser.newContext({
      viewport: this.packet.viewport,
      locale: browser.locale,
      timezoneId: browser.timezoneId,
      acceptDownloads: this.packet.safety.allowFileDownloads,
      serviceWorkers: "block",
    });
    this.context.setDefaultTimeout(browser.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(browser.navigationTimeoutMs);
    await installDomainGuard(this.context, this.packet, this.packet.targetUrl, (b) => {
      this.blockedRequests.push({ ...b, url: this.deps.redactor.redactString(b.url) });
    });
    if (browser.trace) await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.page = await this.context.newPage();
    this.observers = new PageObservers(this.deps.redactor);
    this.observers.attach(this.page);
    // File choosers are never satisfied: uploads are not an allowlisted action.
    this.page.on("filechooser", () => undefined);
  }

  private async closeContext(): Promise<void> {
    if (!this.context) return;
    try {
      if (this.packet.browser.trace) {
        await this.context.tracing.stop({ path: this.deps.storage.resolve(this.layout.trace) });
        this.track(this.layout.trace, "trace");
      }
    } catch {
      /* trace is best-effort evidence */
    }
    await this.context.close().catch(() => undefined);
    this.context = undefined;
  }

  private host(): AgentHost {
    const deadline = this.startMs + this.packet.timeoutMs;
    return {
      packet: this.packet,
      signal: this.deps.signal,
      actionsUsed: () => this.actionCount,
      deadlineReached: () => this.deps.clock.now() >= deadline,
      isStepRisky: (i) => {
        const step = this.packet.steps[i];
        return step
          ? classifyStep(step, i, {
              ...this.packet,
              scenarioId: this.packet.scenarioId,
              targetUrl: this.packet.targetUrl,
            }).length > 0
          : false;
      },
      executeStep: (i, agent) => this.executeOne(i, agent),
      checkpoint: async (reason, agent, nextIndex) => {
        await this.writeCheckpoint(reason, agent, nextIndex);
      },
      emit: (type, agent, data) => {
        if (type === "agent.context.warning") this.contextWarnings++;
        this.emit(type, data, agent.id);
      },
    };
  }

  private async executeOne(index: number, agent: AgentInstanceHandle): Promise<StepStatusResult> {
    const step = this.packet.steps[index] as TestStep;
    const page = this.page as Page;
    const started = this.deps.clock.now();
    const intent = describeStep(step);
    this.emit("packet.step.started", { stepIndex: index, action: step.action, intent }, agent.id);
    this.actionCount++;
    const blockedBefore = this.blockedRequests.length;
    const currentUrl = page.url() === "about:blank" ? undefined : page.url();

    const decision = checkAction(step, index, {
      packet: this.packet,
      currentUrl,
      riskApproved: this.deps.riskApproved,
    });
    if (!decision.allowed) {
      this.emit(
        "policy.blocked",
        { stepIndex: index, action: step.action, reason: decision.reason },
        agent.id,
      );
      const evidence = await this.evidenceFor(step, index);
      await this.recordStep(agent, index, step, intent, started, {
        status: "blocked",
        summary: `Blocked by policy: ${decision.reason}`,
        error: decision.reason,
        evidence: evidence.map((e) => e.path ?? e.summary),
      });
      this.outcomeReason = `step ${index} blocked by policy: ${decision.reason}`;
      return "blocked";
    }

    const ctx: StepExecutionContext = {
      page,
      packet: this.packet,
      observers: this.observers as PageObservers,
      storage: this.deps.storage,
      redactor: this.deps.redactor,
      resolveValue: this.resolveValue,
    };
    const outcome = await executeStep(ctx, step, index);
    for (const e of outcome.evidence) {
      this.track(e, e.includes("/screenshots/") ? "screenshot" : "dom");
      if (e.includes("/screenshots/")) this.latestScreenshot = packetRelative(e, this.packet.packetId);
    }

    // Post-action scope check: a blocked navigation or an out-of-scope page ends the packet.
    const newlyBlocked = this.blockedRequests.slice(blockedBefore).filter((b) => b.isNavigation);
    const after = page.url();
    const inScope = after === "about:blank" || checkUrl(after, this.packet.targetUrl, this.packet).allowed;
    if (newlyBlocked.length || !inScope) {
      const reason = newlyBlocked.length
        ? `navigation to ${newlyBlocked[0]?.url} blocked: ${newlyBlocked[0]?.reason}`
        : `page left allowed domains: ${this.deps.redactor.redactString(after)}`;
      this.emit("policy.blocked", { stepIndex: index, action: step.action, reason }, agent.id);
      const evidence = await this.evidenceFor(step, index);
      await this.recordStep(agent, index, step, intent, started, {
        status: "blocked",
        summary: `Blocked: ${reason}`,
        error: reason,
        evidence: [...outcome.evidence, ...evidence.map((e) => e.path ?? e.summary)],
      });
      this.outcomeReason = `step ${index} blocked: ${reason}`;
      return "blocked";
    }

    if (outcome.status === "failed") {
      const evidence = await this.evidenceFor(step, index);
      const extra: Evidence[] = outcome.evidence.map((p) => ({
        evidenceId: newId("ev"),
        type: p.includes("/screenshots/") ? "screenshot" : "dom",
        path: p,
        summary: "Evidence captured by the failing assertion",
        createdAt: this.deps.clock.iso(),
      }));
      const finding = this.createFinding(
        agent,
        index,
        step,
        outcome.expected,
        outcome.actual ?? outcome.error,
        [...extra, ...evidence],
      );
      await this.recordStep(agent, index, step, intent, started, {
        status: "failed",
        summary: outcome.summary,
        error: outcome.error,
        evidence: [...outcome.evidence, ...evidence.filter((e) => e.path).map((e) => e.path as string)],
      });
      this.outcomeReason = `step ${index} (${step.action}) failed: ${outcome.error ?? outcome.summary}`;
      this.emit(
        "finding.created",
        { findingId: finding.findingId, severity: finding.severity, stepIndex: index },
        agent.id,
      );
      return "failed";
    }

    if (outcome.status === "passed") this.confirmedFacts.push(`Step ${index}: ${outcome.summary}`);
    await this.recordStep(agent, index, step, intent, started, {
      status: outcome.status,
      summary: outcome.summary,
      evidence: outcome.evidence,
      ...(outcome.skipReason ? { skipReason: outcome.skipReason } : {}),
    });
    return outcome.status;
  }

  private async evidenceFor(step: TestStep, index: number): Promise<Evidence[]> {
    const ctx: StepExecutionContext = {
      page: this.page as Page,
      packet: this.packet,
      observers: this.observers as PageObservers,
      storage: this.deps.storage,
      redactor: this.deps.redactor,
      resolveValue: this.resolveValue,
    };
    const evidence = await captureFailureEvidence(ctx, step, index, () => this.deps.clock.iso());
    for (const e of evidence) {
      if (e.path && e.type === "screenshot") {
        this.track(e.path, "screenshot");
        this.latestScreenshot = packetRelative(e.path, this.packet.packetId);
      } else if (e.path && e.type === "dom") this.track(e.path, "dom");
    }
    await this.writeLogs();
    return evidence;
  }

  private async recordStep(
    agent: AgentInstanceHandle,
    index: number,
    step: TestStep,
    intent: string,
    startedMs: number,
    r: {
      status: "passed" | "failed" | "skipped" | "blocked";
      summary: string;
      error?: string;
      evidence: string[];
      skipReason?: string;
    },
  ): Promise<void> {
    const durationMs = Math.max(0, this.deps.clock.now() - startedMs);
    const red = this.deps.redactor;
    const { action: _a, ...args } = step as TestStep & Record<string, unknown>;
    const entry: BrowserActionResult = {
      packetId: this.packet.packetId,
      agentInstanceId: agent.id,
      actionNumber: this.ledger.length + 1,
      stepIndex: index,
      action: step.action,
      actionIntent: truncate(red.redactString(intent), 300),
      origin: "scripted",
      timestamp: this.deps.clock.iso(),
      // Arguments keep unresolved {{testData.*}} templates, so ledgers never contain test values.
      args: red.redactValue(args as Record<string, unknown>),
      ...("locator" in step && step.locator ? { locator: step.locator } : {}),
      url: red.redactString(this.page?.url() ?? ""),
      durationMs,
      status: r.status,
      evidence: r.evidence.map((e) => packetRelative(e, this.packet.packetId)),
      llmInvolved: false,
      ...(r.error ? { error: truncate(red.redactString(r.error), 2000) } : {}),
      ...(r.skipReason ? { skipReason: r.skipReason } : {}),
    };
    this.ledger.push(entry);
    await this.deps.storage.appendLine(this.layout.actions, canonicalize(entry));
    const summary: StepResultSummary = {
      index,
      action: step.action,
      status: r.status,
      summary: truncate(red.redactString(r.summary), 500),
      durationMs,
      evidence: entry.evidence,
      agentInstanceId: agent.id,
      ...(r.error ? { error: truncate(red.redactString(r.error), 2000) } : {}),
    };
    this.stepResults.set(index, summary);
    await this.writeStepResults();
    this.emit(
      r.status === "failed"
        ? "packet.step.failed"
        : r.status === "skipped"
          ? "packet.step.skipped"
          : "packet.step.completed",
      {
        stepIndex: index,
        action: step.action,
        status: r.status,
        durationMs,
      },
      agent.id,
    );
  }

  private async writeStepResults(): Promise<void> {
    const list = [...this.stepResults.values()].sort((a, b) => a.index - b.index);
    await this.deps.storage.writeJson(this.layout.stepResults, list);
  }

  private async writeLogs(): Promise<void> {
    if (!this.observers) return;
    await this.deps.storage.writeJson(this.layout.console, this.observers.console);
    await this.deps.storage.writeJson(this.layout.network, {
      failures: this.observers.network,
      blocked: this.blockedRequests,
    });
  }

  private createFinding(
    agent: AgentInstanceHandle,
    index: number,
    step: TestStep,
    expected: string | undefined,
    actual: string | undefined,
    evidence: Evidence[],
  ): Finding {
    const severity: Severity = this.packet.priority;
    const red = this.deps.redactor;
    const needsVerification = SEVERITY_RANK[severity] >= SEVERITY_RANK[this.deps.verifySeverityAtOrAbove];
    const normalizedActual = (actual ?? "").replace(/\d+ms/g, "Nms").slice(0, 80);
    const finding: Finding = {
      findingId: newId("finding"),
      runId: this.packet.runId,
      packetId: this.packet.packetId,
      scenarioId: this.packet.scenarioId,
      role: this.packet.role,
      viewportName: this.packet.viewportName,
      agentInstanceId: agent.id,
      stepIndex: index,
      title: truncate(`${this.packet.scenarioTitle}: step ${index} ${describeStep(step)} failed`, 300),
      severity,
      confidence: "high",
      status: "candidate",
      origin: "deterministic",
      probabilistic: false,
      expected: truncate(
        red.redactString(expected ?? `${describeStep(step)} succeeds (${this.packet.expectedOutcome})`),
        1000,
      ),
      actual: truncate(red.redactString(actual ?? "step failed"), 2000),
      reproductionSteps: this.packet.steps.slice(0, index + 1).map((s, i) => `${i}. ${describeStep(s)}`),
      evidence,
      persistedThroughHandoff: this.instances.length > 1,
      verificationStatus: needsVerification ? "pending" : "not_required",
      dedupeKey: `${this.packet.scenarioId}:${index}:${step.action}:${normalizedActual}`,
      createdAt: this.deps.clock.iso(),
    };
    this.findings.push(finding);
    return finding;
  }

  private completedIndexes(): number[] {
    return [...this.stepResults.values()]
      .filter((s) => s.status === "passed" || s.status === "skipped")
      .map((s) => s.index)
      .sort((a, b) => a - b);
  }

  private async writeCheckpoint(
    reason: CheckpointReason,
    agent: AgentInstanceHandle,
    nextIndex: number,
    handoffDocumentReference = "none",
  ): Promise<AgentCheckpoint> {
    const n = this.packet.steps.length;
    const page = this.page;
    let browserSession: AgentCheckpoint["browserSession"] = { type: "none" };
    if (this.packet.contextPolicy.restoreBrowserSession === "storage-state" && this.context) {
      const state = await this.context.storageState();
      // Sanitize: keep only cookies/origins inside the approved domains. Never copied into handoffs.
      const sanitized = {
        cookies: state.cookies.filter(
          (c) =>
            checkUrl(`https://${c.domain.replace(/^\./, "")}/`, this.packet.targetUrl, this.packet).allowed,
        ),
        origins: state.origins.filter((o) => checkUrl(o.origin, this.packet.targetUrl, this.packet).allowed),
      };
      await this.deps.storage.writeJson(this.layout.storageState, sanitized);
      this.track(this.layout.storageState, "storage-state");
      browserSession = {
        type: "storage-state",
        artifactPath: packetRelative(this.layout.storageState, this.packet.packetId),
        redactionApplied: true,
      };
    }
    let title: string | undefined;
    try {
      title = page ? await page.title() : undefined;
    } catch {
      title = undefined;
    }
    const url = page?.url();
    const cp = createCheckpoint({
      sequence: ++this.checkpointSeq,
      runId: this.packet.runId,
      workPacketId: this.packet.packetId,
      agentInstanceId: agent.id,
      createdAt: this.deps.clock.iso(),
      reason,
      immutableWorkPacketHash: this.packet.workPacketHash,
      approvedExecutionPlanHash: this.deps
        .approvedExecutionPlanHash as AgentCheckpoint["approvedExecutionPlanHash"],
      workPacketState: this.state.state,
      completedStepIndexes: this.completedIndexes(),
      currentStepIndex: Math.min(nextIndex, n),
      remainingStepIndexes: Array.from({ length: Math.max(0, n - nextIndex) }, (_, i) => nextIndex + i),
      stepResults: [...this.stepResults.values()].sort((a, b) => a.index - b.index),
      ...(url && url !== "about:blank" ? { currentUrl: this.deps.redactor.redactString(url) } : {}),
      ...(title ? { pageTitle: truncate(this.deps.redactor.redactString(title), 200) } : {}),
      viewport: this.packet.viewport,
      browserSession,
      contextUsage: (this.agent as ScriptedAgent).lifecycle.getUsage(),
      actionLedgerReference: "actions.ndjson",
      artifactManifestReference: "artifact-manifest.json",
      findingReferences: this.findings.map((f) => f.findingId),
      pendingFindingReferences: this.findings
        .filter((f) => f.verificationStatus === "pending")
        .map((f) => f.findingId),
      handoffDocumentReference,
    });
    const rel = await persistCheckpoint(this.deps.storage, cp);
    this.track(rel, "checkpoint");
    await this.deps.storage.writeJson(this.layout.manifest, this.manifest);
    this.lastCheckpoint = cp;
    this.emit(
      "packet.checkpoint.created",
      { checkpointId: cp.checkpointId, reason, integrityHash: cp.integrityHash, nextIndex },
      agent.id,
    );
    return cp;
  }

  private async handleResult(result: AgentRunResult): Promise<void> {
    const agent = (this.agent as ScriptedAgent).instance;
    switch (result.kind) {
      case "completed":
        agent.terminate("work packet completed");
        this.emit("agent.terminated", { reason: "completed" }, agent.id);
        await this.transition("COMPLETED");
        this.outcome = "passed";
        this.emit("packet.completed", { steps: this.packet.steps.length });
        return;
      case "failed":
        await this.skipRemaining(result.stepIndex + 1, "prior step failed");
        await this.writeCheckpoint("graceful_shutdown", agent, result.stepIndex);
        agent.terminate("step failed");
        this.emit("agent.terminated", { reason: "step_failed" }, agent.id);
        await this.transition("FAILED", this.outcomeReason);
        this.outcome = "failed";
        this.emit("packet.failed", { stepIndex: result.stepIndex, reason: this.outcomeReason });
        return;
      case "blocked":
        await this.skipRemaining(result.stepIndex + 1, "packet blocked by policy");
        await this.writeCheckpoint("graceful_shutdown", agent, result.stepIndex);
        agent.terminate("blocked by policy");
        this.emit("agent.terminated", { reason: "blocked" }, agent.id);
        await this.transition("BLOCKED", this.outcomeReason);
        this.outcome = "blocked";
        this.emit("packet.blocked", { stepIndex: result.stepIndex, reason: this.outcomeReason });
        return;
      case "budget_exhausted":
        await this.writeCheckpoint("graceful_shutdown", agent, result.nextIndex);
        await this.skipRemaining(result.nextIndex, result.reason);
        agent.terminate(result.reason);
        this.outcomeReason = result.reason;
        if (/timeout/.test(result.reason)) {
          await this.transition("FAILED", result.reason);
          this.outcome = "error";
          this.emit("packet.failed", { reason: result.reason });
        } else {
          await this.transition("BLOCKED", result.reason);
          this.outcome = "blocked";
          this.emit("packet.blocked", { reason: result.reason });
        }
        return;
      case "cancelled":
        await this.writeCheckpoint("graceful_shutdown", agent, result.nextIndex);
        await this.skipRemaining(result.nextIndex, "run cancelled");
        agent.terminate("run cancelled");
        await this.transition("CANCELLED", "run cancelled");
        this.outcome = "cancelled";
        this.outcomeReason = "run cancelled";
        this.emit("packet.cancelled", { nextIndex: result.nextIndex });
        return;
      case "rotation_required":
        await this.rotate(result.nextIndex, result.checkpointReason, result.reason);
        return;
    }
  }

  /**
   * Controlled agent shutdown: checkpoint -> handoff (validated, policy-checked, persisted) -> terminate.
   * The replacement is created only through the ReplacementAgentFactory after preflight verification;
   * without one (Milestone 1) or when preflight fails, the packet is BLOCKED with its remaining work reported.
   */
  private async rotate(nextIndex: number, reason: CheckpointReason, description: string): Promise<void> {
    const agent = (this.agent as ScriptedAgent).instance;
    this.rotationReasons.push(`${agent.id}: ${description}`);
    const handoffState = new TrackedState<HandoffState>(handoffStateMachine, "NOT_REQUIRED", (_from, to) => {
      if (to === "REQUIRED")
        this.emit("packet.handoff.required", { reason, description, nextIndex }, agent.id);
    });
    await this.transition("CHECKPOINTING", description);
    if (agent.current !== "CHECKPOINTING") agent.to("CHECKPOINTING", description);
    this.emit("agent.checkpointing", { reason }, agent.id);
    handoffState.to("REQUIRED");

    const seq = this.handoffSeq + 1;
    const handoffPath = this.layout.handoff(seq);
    const checkpoint = await this.writeCheckpoint(
      reason,
      agent,
      nextIndex,
      packetRelative(handoffPath, this.packet.packetId),
    );

    handoffState.to("WRITING");
    const writer = new DeterministicHandoffWriter(this.deps.redactor, this.deps.clock);
    await this.writeLogs();
    const handoff = await writer.create(
      {
        workPacket: this.packet,
        agentInstance: agent.record,
        checkpoint,
        recentActions: this.ledger,
        findings: this.findings,
        artifacts: this.manifest,
      },
      {
        handoffSequence: seq,
        handoffsUsed: this.handoffSeq,
        elapsedMsInPacket: this.deps.clock.now() - this.startMs,
        actionsUsedInPacket: this.actionCount,
        llmCallsUsedInPacket: 0,
        confirmedFacts: this.confirmedFacts,
        consoleOrNetworkObservations: [
          ...(this.observers?.consoleErrors() ?? []).map((c) => `console ${c.type}: ${c.text}`),
          ...(this.observers?.networkFailures() ?? []).map(
            (n) => `network ${n.status ?? n.failure}: ${n.url}`,
          ),
        ],
        ...(this.latestScreenshot ? { latestScreenshot: this.latestScreenshot } : {}),
      },
    );
    const validation = writer.validate(handoff);
    const policy = checkHandoff({
      handoff,
      packet: this.packet,
      approvedExecutionPlanHash: this.deps.approvedExecutionPlanHash,
      redactor: this.deps.redactor,
    });
    if (!validation.valid || !policy.allowed) {
      const why = [...validation.errors, ...(policy.reason ? [policy.reason] : [])].join("; ");
      agent.terminate(`handoff invalid: ${why}`);
      await this.skipRemaining(nextIndex, "handoff validation failed");
      await this.transition("BLOCKED", `handoff validation failed: ${why}`);
      this.outcome = "blocked";
      this.outcomeReason = `handoff validation failed: ${why}`;
      this.blockedByCheckpointFailure = true;
      this.emit("packet.blocked", { reason: this.outcomeReason });
      return;
    }
    handoffState.to("VALIDATED");
    this.emit(
      "packet.handoff.validated",
      { handoffId: handoff.handoffId, integrityHash: handoff.integrityHash },
      agent.id,
    );
    const rel = await persistHandoff(this.deps.storage, handoff);
    this.track(rel, "handoff");
    handoffState.to("PERSISTED");
    this.handoffSeq = seq;
    this.emit(
      "packet.handoff.created",
      {
        handoffId: handoff.handoffId,
        path: packetRelative(rel, this.packet.packetId),
        checkpointId: checkpoint.checkpointId,
      },
      agent.id,
    );

    // The exhausted agent is terminated only after checkpoint and handoff are durable.
    agent.terminate(description);
    this.emit(
      "agent.terminated",
      { reason: description, checkpointId: checkpoint.checkpointId, handoffId: handoff.handoffId },
      agent.id,
    );
    await this.transition("HANDOFF_PENDING");

    const summary: HandoffSummary = {
      handoffId: handoff.handoffId,
      workPacketId: this.packet.packetId,
      previousAgentInstanceId: agent.id,
      triggerReason: reason,
      progressAtHandoff: {
        completed: checkpoint.completedStepIndexes.length,
        total: this.packet.steps.length,
      },
      remainingStepIndexes: checkpoint.remainingStepIndexes,
      restorationOutcome: "not_attempted",
      integrityValid: true,
      path: packetRelative(rel, this.packet.packetId),
    };
    this.handoffs.push(summary);

    const preflight = replacementPreflight({
      packet: this.packet,
      approvedExecutionPlanHash: this.deps.approvedExecutionPlanHash,
      checkpoint,
      handoff,
      handoffsUsed: this.handoffSeq - 1,
      packetTerminal: false,
      redactor: this.deps.redactor,
    });
    const blockReason = !preflight.ok
      ? preflight.reason
      : !this.deps.replacementFactory
        ? "replacement_agent_unavailable: automatic replacement agents arrive in Milestone 3; handoff persisted for resumption"
        : undefined;
    if (blockReason) {
      if (!preflight.ok && preflight.code === "HANDOFF_LIMIT_EXCEEDED") this.blockedByHandoffLimit = true;
      summary.restorationOutcome = "blocked";
      this.resumeOutcome = `blocked: ${blockReason}`;
      await this.skipRemaining(nextIndex, blockReason);
      await this.transition("BLOCKED", blockReason);
      this.outcome = "blocked";
      this.outcomeReason = blockReason;
      this.emit("packet.blocked", {
        reason: blockReason,
        remainingStepIndexes: checkpoint.remainingStepIndexes,
      });
      return;
    }
    // Replacement path (Milestone 3): factory creates the new instance; consumption is recorded there.
    throw new BrowserSwarmError(
      "NOT_IMPLEMENTED_IN_MILESTONE",
      "replacement execution is wired in Milestone 3",
    );
  }

  private async skipRemaining(from: number, reason: string): Promise<void> {
    let changed = false;
    for (let i = from; i < this.packet.steps.length; i++) {
      if (this.stepResults.has(i)) continue;
      const step = this.packet.steps[i] as TestStep;
      this.stepResults.set(i, {
        index: i,
        action: step.action,
        status: "skipped",
        summary: `Not executed: ${reason}`,
        evidence: [],
      });
      changed = true;
    }
    if (changed) await this.writeStepResults();
  }

  private async handleCrash(error: unknown): Promise<void> {
    const err = error as Error;
    const isCheckpointFailure =
      error instanceof BrowserSwarmError && error.code === "CHECKPOINT_PERSISTENCE_FAILED";
    const message = truncate(this.deps.redactor.redactString(err?.message ?? String(error)), 1000);
    this.outcomeReason = isCheckpointFailure
      ? `checkpoint persistence failed: ${message}`
      : `packet error: ${message}`;
    for (const inst of this.instances) inst.terminate(this.outcomeReason);
    await this.skipRemaining(0, this.outcomeReason).catch(() => undefined);
    try {
      if (!this.state.isTerminal()) {
        const target: WorkPacketState = isCheckpointFailure ? "BLOCKED" : "FAILED";
        if (workPacketStateMachine.canTransition(this.state.state, target))
          await this.transition(target, this.outcomeReason);
      }
    } catch {
      /* state file write failed too; the event log still records the error */
    }
    this.outcome = isCheckpointFailure ? "blocked" : "error";
    if (isCheckpointFailure) this.blockedByCheckpointFailure = true;
    this.emit(isCheckpointFailure ? "packet.blocked" : "packet.failed", { reason: this.outcomeReason });
  }

  private async finish(): Promise<PacketRunResult> {
    const { storage } = this.deps;
    await this.writeLogs().catch(() => undefined);
    await storage.writeJson(this.layout.findings, this.findings);
    await this.writeStepResults();
    for (const inst of this.instances) {
      await storage.writeJson(this.layout.agentInstance(inst.id), inst.record);
      if (this.agent && this.agent.instance === inst) {
        await storage.writeJson(this.layout.agentContextUsage(inst.id), this.agent.lifecycle.getUsage());
      }
    }
    await storage.writeJson(this.layout.manifest, this.manifest);
    const records: AgentInstance[] = this.instances.map((i) => i.record);
    const report: PacketReport = {
      packetId: this.packet.packetId,
      scenarioId: this.packet.scenarioId,
      scenarioTitle: this.packet.scenarioTitle,
      role: this.packet.role,
      viewportName: this.packet.viewportName,
      viewport: this.packet.viewport,
      model: this.packet.model ? `${this.packet.model.provider}:${this.packet.model.model}` : null,
      state: this.state.state,
      outcome: this.outcome,
      ...(this.outcomeReason ? { outcomeReason: this.outcomeReason } : {}),
      agentInstances: records,
      actionsCompleted: this.ledger.filter((l) => l.status === "passed").length,
      deterministicActions: this.ledger.filter((l) => !l.llmInvolved).length,
      llmAssistedActions: this.ledger.filter((l) => l.llmInvolved).length,
      checkpoints: this.checkpointSeq,
      handoffs: this.handoffs,
      rotationReasons: this.rotationReasons,
      resumeOutcome: this.resumeOutcome,
      stepResults: [...this.stepResults.values()].sort((a, b) => a.index - b.index),
      findingIds: this.findings.map((f) => f.findingId),
      artifactDir: this.packet.artifactDir,
      durationMs: Math.max(0, Math.round(this.deps.clock.now() - this.startMs)),
    };
    return {
      report,
      findings: this.findings,
      contextWarnings: this.contextWarnings,
      checkpoints: this.checkpointSeq,
      blockedByHandoffLimit: this.blockedByHandoffLimit,
      blockedByCheckpointFailure: this.blockedByCheckpointFailure,
    };
  }
}
