import {
  computeHandoffHash,
  describeStep,
  formatZodIssues,
  HandoffDocumentSchema,
  type AgentCheckpoint,
  type AgentInstance,
  type ArtifactManifest,
  type BrowserActionResult,
  type Finding,
  type HandoffActionSummary,
  type HandoffDocument,
  type HandoffStepSummary,
  type Locator,
  type WorkPacket,
} from "@browserswarm/core";
import { estimateTokens } from "@browserswarm/opencode-adapter";
import { summarizeSafety } from "@browserswarm/policy-engine";
import {
  canonicalize,
  padSequence,
  systemClock,
  truncate,
  type Clock,
  type Redactor,
} from "@browserswarm/shared";

export interface HandoffCreateInput {
  workPacket: WorkPacket;
  agentInstance: AgentInstance;
  checkpoint: AgentCheckpoint;
  recentActions: BrowserActionResult[];
  findings: Finding[];
  artifacts: ArtifactManifest;
}

/** Deterministic extras the executor knows (never model reasoning). */
export interface HandoffContext {
  handoffSequence: number;
  handoffsUsed: number;
  elapsedMsInPacket: number;
  actionsUsedInPacket: number;
  llmCallsUsedInPacket: number;
  confirmedFacts?: string[];
  consoleOrNetworkObservations?: string[];
  accessibilityObservations?: string[];
  unresolvedAmbiguities?: string[];
  relevantVisibleStateSummary?: string;
  latestScreenshot?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface HandoffWriter {
  create(input: HandoffCreateInput, context: HandoffContext): Promise<HandoffDocument>;
  validate(handoff: HandoffDocument): ValidationResult;
  renderMarkdown(handoff: HandoffDocument): string;
}

export function estimateHandoffTokens(doc: HandoffDocument | Omit<HandoffDocument, "integrityHash">): number {
  return estimateTokens(canonicalize(doc)).tokens;
}

/**
 * Deterministic handoff writer: everything is extracted from the approved packet, the validated checkpoint,
 * the action ledger and finding records. No LLM is needed; every string passes through the redactor.
 */
export class DeterministicHandoffWriter implements HandoffWriter {
  constructor(
    private readonly redactor: Redactor,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: HandoffCreateInput, context: HandoffContext): Promise<HandoffDocument> {
    const { workPacket: p, checkpoint: cp, agentInstance, recentActions, findings } = input;
    const policy = p.contextPolicy;
    const r = (s: string) => this.redactor.redactString(s);
    const stepSummary = (index: number): HandoffStepSummary => {
      const result = cp.stepResults.find((x) => x.index === index);
      const step = p.steps[index];
      return {
        index,
        action: step?.action ?? "unknown",
        status: result?.status ?? "not_started",
        summary: truncate(
          r(result?.summary ?? (step ? describeStep(step) : "")),
          policy.includeCompletedStepDetail === "full" ? 400 : 160,
        ),
      };
    };
    const completed = cp.completedStepIndexes.map(stepSummary);
    const skipped = cp.stepResults
      .filter((s) => s.status === "skipped" || s.status === "blocked")
      .map((s) => stepSummary(s.index));
    const remaining = cp.remainingStepIndexes.map(stepSummary);
    const current = cp.remainingStepIndexes.length ? stepSummary(cp.currentStepIndex) : undefined;

    const toAction = (a: BrowserActionResult): HandoffActionSummary => ({
      action: a.action,
      status: a.status,
      summary: truncate(r(a.error ? `${a.actionIntent} -> ${a.error}` : a.actionIntent), 200),
      stepIndex: a.stepIndex,
    });
    const failed = recentActions.filter((a) => a.status === "failed" || a.status === "blocked");
    const locators: Locator[] = [];
    const seen = new Set<string>();
    for (const i of [...cp.completedStepIndexes, ...cp.remainingStepIndexes]) {
      const step = p.steps[i];
      if (step && "locator" in step && step.locator) {
        const key = canonicalize(step.locator);
        if (!seen.has(key)) {
          seen.add(key);
          locators.push(step.locator);
        }
      }
    }
    const obsLimit = policy.includeRecentObservationCount;
    const nextStep = p.steps[cp.currentStepIndex];
    const status: HandoffDocument["executionProgress"]["status"] =
      p.mode !== "agentic" && cp.remainingStepIndexes.length === 0
        ? "completed"
        : cp.workPacketState === "BLOCKED"
          ? "blocked"
          : cp.workPacketState === "FAILED"
            ? "failed"
            : "in_progress";

    const doc: Omit<HandoffDocument, "integrityHash"> = {
      version: 1,
      handoffId: `handoff-${padSequence(context.handoffSequence)}`,
      runId: p.runId,
      workPacketId: p.packetId,
      previousAgentInstanceId: agentInstance.agentInstanceId,
      createdAt: this.clock.iso(),
      immutableWorkPacketHash: p.workPacketHash,
      approvedExecutionPlanHash: cp.approvedExecutionPlanHash,
      sourceCheckpointId: cp.checkpointId,
      mission: {
        scenarioId: p.scenarioId,
        scenarioTitle: p.scenarioTitle,
        role: p.role,
        objective: r(p.objective),
        expectedOutcome: r(p.expectedOutcome),
        allowedDomains: [...p.allowedDomains],
        safetySummary: summarizeSafety(p.safety),
      },
      executionProgress: {
        status,
        completedSteps: completed,
        ...(current ? { currentStep: current } : {}),
        remainingSteps: remaining,
        skippedSteps: skipped,
      },
      currentBrowserState: {
        ...(cp.currentUrl ? { currentUrl: r(cp.currentUrl) } : {}),
        ...(cp.pageTitle ? { pageTitle: r(cp.pageTitle) } : {}),
        viewport: p.viewport,
        sessionRestorationAvailable: cp.browserSession.type === "storage-state",
        ...(cp.browserSession.type === "storage-state"
          ? { storageStateArtifact: cp.browserSession.artifactPath }
          : {}),
        ...(context.relevantVisibleStateSummary
          ? { relevantVisibleStateSummary: truncate(r(context.relevantVisibleStateSummary), 480) }
          : {}),
      },
      importantObservations: {
        confirmedFacts: (context.confirmedFacts ?? []).slice(-obsLimit).map((s) => truncate(r(s), 280)),
        relevantElementLocators: locators,
        consoleOrNetworkObservations: (context.consoleOrNetworkObservations ?? [])
          .slice(-obsLimit)
          .map((s) => truncate(r(s), 280)),
        accessibilityObservations: (context.accessibilityObservations ?? [])
          .slice(-obsLimit)
          .map((s) => truncate(r(s), 280)),
        unresolvedAmbiguities: (context.unresolvedAmbiguities ?? [])
          .slice(-obsLimit)
          .map((s) => truncate(r(s), 280)),
      },
      findings: {
        confirmedFindingIds: findings.filter((f) => f.status === "confirmed").map((f) => f.findingId),
        candidateFindingIds: findings
          .filter((f) => f.status === "candidate" || f.status === "likely" || f.status === "unverified")
          .map((f) => f.findingId),
        rejectedFindingIds: findings.filter((f) => f.status === "rejected").map((f) => f.findingId),
      },
      actionHistorySummary: {
        totalActions: context.actionsUsedInPacket,
        recentActions: recentActions.slice(-policy.includeRecentActionCount).map(toAction),
        failedActions: failed.slice(-policy.includeRecentActionCount).map(toAction),
        repeatedActionsToAvoid: failed
          .map((a) => truncate(r(`Step ${a.stepIndex} ${a.action}: ${a.error ?? "failed"}`), 280))
          .slice(-5),
      },
      llmUsage: {
        callsUsed: context.llmCallsUsedInPacket,
        callsRemaining: Math.max(0, p.llmCallBudget - context.llmCallsUsedInPacket),
        contextUsage: cp.contextUsage,
        fallbackAttemptsRemaining: Math.max(0, p.llmCallBudget - context.llmCallsUsedInPacket),
      },
      ...(cp.agentProgress ? { agentProgress: cp.agentProgress } : {}),
      budgetsRemaining: {
        workPacketActionsRemaining: Math.max(0, p.actionBudget - context.actionsUsedInPacket),
        workPacketTimeMsRemaining: Math.max(0, Math.round(p.timeoutMs - context.elapsedMsInPacket)),
        workPacketLlmCallsRemaining: Math.max(0, p.llmCallBudget - context.llmCallsUsedInPacket),
        handoffsRemaining: Math.max(0, policy.maxHandoffsPerWorkPacket - context.handoffsUsed),
      },
      continuationInstructions: {
        ...(nextStep && cp.remainingStepIndexes.length
          ? {
              nextRequiredAction: truncate(
                r(
                  `Step ${cp.currentStepIndex}: ${describeStep(nextStep)}; then continue in approved step order.`,
                ),
                480,
              ),
            }
          : {}),
        resumeFromStepIndex: cp.currentStepIndex,
        doNotRepeat: [
          ...(cp.completedStepIndexes.length
            ? [
                `Do not repeat completed steps ${compactRange(cp.completedStepIndexes)} unless storage-state restoration fails validation (then replay minimally and log it).`,
              ]
            : []),
          ...failed
            .map((a) =>
              truncate(r(`Do not retry step ${a.stepIndex} unchanged: ${a.error ?? a.actionIntent}`), 280),
            )
            .slice(-3),
        ],
        stopConditions: [
          `Stop if navigation leaves ${p.allowedDomains.join(", ")}.`,
          "Stop if any action is blocked by the safety policy.",
          "Stop when the action, time or LLM budget is exhausted.",
          p.mode === "agentic"
            ? "Finish through report_verdict with fresh captured evidence for the approved outcome."
            : "Stop after all remaining approved steps are complete.",
        ],
        policyReminders: [
          p.mode === "agentic"
            ? "Follow the approved mission and guidance; do not change expected outcomes."
            : "Execute only the approved steps of this work packet; do not add tests or change expected outcomes.",
          "Do not create accounts, purchase, upload/download, send messages or perform destructive actions unless the packet's approved risk flags allow it.",
          "Never place secrets, cookies or credentials in notes, findings or model context.",
        ],
      },
      artifactReferences: {
        ...(context.latestScreenshot ? { latestScreenshot: context.latestScreenshot } : {}),

        actionLedger: "actions.ndjson",
        stepResults: "step-results.json",
        consoleLog: "console.json",
        networkLog: "network.json",
        findings: "findings.json",
      },
      conciseStatusSummary: truncate(
        r(
          `Agent ${agentInstance.agentInstanceId} completed ${cp.completedStepIndexes.length}/${p.steps.length} steps` +
            (cp.remainingStepIndexes.length
              ? `; resume at step ${cp.currentStepIndex}`
              : "; no steps remain") +
            `. Checkpoint reason: ${cp.reason}. Findings: ${findings.length}. ` +
            (cp.browserSession.type === "storage-state"
              ? "Sanitized storage state is available."
              : "No session state; replay may be required."),
        ),
        900,
      ),
    };

    const compacted = compactHandoff(doc, policy.handoffMaxTokensEstimate);
    return { ...compacted, integrityHash: computeHandoffHash(compacted) };
  }

  validate(handoff: HandoffDocument): ValidationResult {
    const errors: string[] = [];
    const parsed = HandoffDocumentSchema.safeParse(handoff);
    if (!parsed.success) errors.push(...formatZodIssues(parsed.error));
    if (computeHandoffHash(handoff) !== handoff.integrityHash) errors.push("integrity hash mismatch");
    const serialized = canonicalize(handoff);
    if (this.redactor.containsSecret(serialized)) errors.push("contains an unredacted secret value");
    if (/"(cookies|origins)"\s*:/.test(serialized)) errors.push("contains raw storage state");
    if (/(chain[- ]of[- ]thought|<thinking>|"transcript"|"messages"\s*:\s*\[)/i.test(serialized)) {
      errors.push("contains transcript or reasoning content");
    }
    return { valid: errors.length === 0, errors };
  }

  renderMarkdown(h: HandoffDocument): string {
    return renderHandoffMarkdown(h);
  }
}

function compactRange(indexes: number[]): string {
  if (!indexes.length) return "none";
  const sorted = [...indexes].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (const i of sorted.slice(1)) {
    if (i === prev + 1) {
      prev = i;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = i;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(", ");
}

/**
 * Deterministic compaction to fit handoffMaxTokensEstimate. Order: shorten summaries, trim observation
 * lists, collapse completed steps to the last three, trim action history. Mission, remaining steps,
 * budgets, continuation instructions and hashes are never removed.
 */
export function compactHandoff<T extends Omit<HandoffDocument, "integrityHash">>(
  doc: T,
  maxTokens: number,
): T {
  let d: T = structuredClone(doc);
  const fits = () => estimateHandoffTokens(d) <= maxTokens;
  if (fits()) return d;

  const shorten = (xs: HandoffStepSummary[], n: number) =>
    xs.map((x) => ({ ...x, summary: truncate(x.summary, n) }));
  const steps: ((x: T) => T)[] = [
    (x) => ({
      ...x,
      executionProgress: {
        ...x.executionProgress,
        completedSteps: shorten(x.executionProgress.completedSteps, 60),
        remainingSteps: shorten(x.executionProgress.remainingSteps, 100),
        skippedSteps: shorten(x.executionProgress.skippedSteps, 60),
      },
    }),
    (x) => ({
      ...x,
      importantObservations: {
        ...x.importantObservations,
        confirmedFacts: x.importantObservations.confirmedFacts.slice(-3),
        consoleOrNetworkObservations: x.importantObservations.consoleOrNetworkObservations.slice(-3),
        accessibilityObservations: x.importantObservations.accessibilityObservations.slice(-3),
        relevantElementLocators: x.importantObservations.relevantElementLocators.slice(0, 8),
      },
    }),
    (x) => ({
      ...x,
      executionProgress: {
        ...x.executionProgress,
        completedSteps: x.executionProgress.completedSteps.slice(-3),
      },
      actionHistorySummary: {
        ...x.actionHistorySummary,
        recentActions: x.actionHistorySummary.recentActions.slice(-3),
        failedActions: x.actionHistorySummary.failedActions.slice(-3),
        repeatedActionsToAvoid: x.actionHistorySummary.repeatedActionsToAvoid.slice(-2),
      },
    }),
    (x) => ({
      ...x,
      executionProgress: {
        ...x.executionProgress,
        remainingSteps: shorten(x.executionProgress.remainingSteps, 48),
      },
      conciseStatusSummary: truncate(x.conciseStatusSummary, 300),
    }),
    (x) => ({
      ...x,
      importantObservations: {
        ...x.importantObservations,
        confirmedFacts: x.importantObservations.confirmedFacts.slice(-1),
        relevantElementLocators: x.importantObservations.relevantElementLocators.slice(0, 4),
        unresolvedAmbiguities: x.importantObservations.unresolvedAmbiguities.slice(-2),
      },
      actionHistorySummary: {
        ...x.actionHistorySummary,
        recentActions: x.actionHistorySummary.recentActions
          .slice(-1)
          .map((a) => ({ ...a, summary: truncate(a.summary, 100) })),
        failedActions: x.actionHistorySummary.failedActions
          .slice(-1)
          .map((a) => ({ ...a, summary: truncate(a.summary, 100) })),
        repeatedActionsToAvoid: x.actionHistorySummary.repeatedActionsToAvoid
          .slice(-1)
          .map((s) => truncate(s, 100)),
      },
      continuationInstructions: {
        ...x.continuationInstructions,
        doNotRepeat: x.continuationInstructions.doNotRepeat.slice(0, 2).map((s) => truncate(s, 160)),
      },
    }),
    (x) => ({
      ...x,
      executionProgress: {
        ...x.executionProgress,
        completedSteps: [],
        skippedSteps: x.executionProgress.skippedSteps.slice(-2),
        remainingSteps: shorten(x.executionProgress.remainingSteps, 32),
      },
      currentBrowserState: { ...x.currentBrowserState, relevantVisibleStateSummary: undefined },
      conciseStatusSummary: truncate(x.conciseStatusSummary, 200),
    }),
  ];
  for (const step of steps) {
    d = step(d);
    if (fits()) break;
  }
  return d;
}

export function renderHandoffMarkdown(h: HandoffDocument): string {
  const L: string[] = [];
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`) : ["- none"]);
  const stepLine = (s: HandoffStepSummary) => `- [${s.status}] step ${s.index} \`${s.action}\`: ${s.summary}`;
  L.push(`# Handoff ${h.handoffId}: ${h.mission.scenarioTitle}`);
  L.push("");
  L.push(
    "> Operational execution record for a replacement agent. Contains no model transcript or reasoning.",
  );
  L.push("");
  L.push(`| Field | Value |`, `| --- | --- |`);
  L.push(
    `| Run | ${h.runId} |`,
    `| Work packet | ${h.workPacketId} |`,
    `| Previous agent | ${h.previousAgentInstanceId} |`,
  );
  L.push(`| Replacement agent | ${h.replacementAgentInstanceId ?? "(not yet assigned)"} |`);
  L.push(`| Source checkpoint | ${h.sourceCheckpointId} |`, `| Created | ${h.createdAt} |`);
  L.push(
    `| Work packet hash | \`${h.immutableWorkPacketHash}\` |`,
    `| Execution plan hash | \`${h.approvedExecutionPlanHash}\` |`,
  );
  L.push(`| Integrity | \`${h.integrityHash}\` |`);
  L.push("");
  L.push("## Status", "", h.conciseStatusSummary, "");
  L.push("## Mission", "");
  L.push(`- Scenario: ${h.mission.scenarioTitle} (\`${h.mission.scenarioId}\`), role **${h.mission.role}**`);
  L.push(`- Objective: ${h.mission.objective}`);
  if (h.mission.expectedOutcome) L.push(`- Expected outcome: ${h.mission.expectedOutcome}`);
  L.push(`- Allowed domains: ${h.mission.allowedDomains.join(", ")}`);
  L.push("", "### Safety", "", ...list(h.mission.safetySummary), "");
  L.push("## Progress", "", `Status: **${h.executionProgress.status}**`, "");
  L.push(
    "### Completed",
    "",
    ...(h.executionProgress.completedSteps.length
      ? h.executionProgress.completedSteps.map(stepLine)
      : ["- none"]),
    "",
  );
  if (h.executionProgress.currentStep)
    L.push("### Current step", "", stepLine(h.executionProgress.currentStep), "");
  L.push(
    "### Remaining",
    "",
    ...(h.executionProgress.remainingSteps.length
      ? h.executionProgress.remainingSteps.map(stepLine)
      : ["- none"]),
    "",
  );
  if (h.executionProgress.skippedSteps.length)
    L.push("### Skipped / blocked", "", ...h.executionProgress.skippedSteps.map(stepLine), "");
  const b = h.currentBrowserState;
  L.push("## Browser state", "");
  L.push(
    `- URL: ${b.currentUrl ?? "unknown"}`,
    `- Title: ${b.pageTitle ?? "unknown"}`,
    `- Viewport: ${b.viewport.width}x${b.viewport.height}`,
  );
  L.push(
    `- Session restoration: ${b.sessionRestorationAvailable ? `available (${b.storageStateArtifact})` : "not available (deterministic replay required)"}`,
  );
  if (b.relevantVisibleStateSummary) L.push(`- Visible state: ${b.relevantVisibleStateSummary}`);
  L.push("");
  const o = h.importantObservations;
  L.push("## Observations", "");
  L.push("### Confirmed facts", "", ...list(o.confirmedFacts), "");
  L.push(
    "### Relevant locators",
    "",
    ...list(o.relevantElementLocators.map((l) => `\`${JSON.stringify(l)}\``)),
    "",
  );
  L.push("### Console / network", "", ...list(o.consoleOrNetworkObservations), "");
  L.push("### Accessibility", "", ...list(o.accessibilityObservations), "");
  L.push("### Unresolved ambiguities", "", ...list(o.unresolvedAmbiguities), "");
  L.push("## Findings", "");
  L.push(`- Confirmed: ${h.findings.confirmedFindingIds.join(", ") || "none"}`);
  L.push(`- Candidate: ${h.findings.candidateFindingIds.join(", ") || "none"}`);
  L.push(`- Rejected: ${h.findings.rejectedFindingIds.join(", ") || "none"}`, "");
  L.push("## Action history", "", `Total actions: ${h.actionHistorySummary.totalActions}`, "");
  L.push(
    "### Recent",
    "",
    ...list(h.actionHistorySummary.recentActions.map((a) => `[${a.status}] ${a.action}: ${a.summary}`)),
    "",
  );
  L.push(
    "### Failed",
    "",
    ...list(h.actionHistorySummary.failedActions.map((a) => `${a.action}: ${a.summary}`)),
    "",
  );
  L.push("### Avoid repeating", "", ...list(h.actionHistorySummary.repeatedActionsToAvoid), "");
  L.push("## Budgets remaining", "");
  const br = h.budgetsRemaining;
  L.push(
    `- Actions: ${br.workPacketActionsRemaining}`,
    `- Time: ${br.workPacketTimeMsRemaining} ms`,
    `- LLM calls: ${br.workPacketLlmCallsRemaining}`,
    `- Handoffs: ${br.handoffsRemaining}`,
  );
  L.push(
    `- Context at handoff: ${h.llmUsage.contextUsage.estimatedTotalTokens} est. tokens, ${h.llmUsage.contextUsage.contextUtilizationPercent ?? 0}% utilization, ${h.llmUsage.contextUsage.browserActionCount} actions`,
    "",
  );
  const c = h.continuationInstructions;
  L.push("## Continuation", "", `Resume from step **${c.resumeFromStepIndex}**.`, "");
  if (c.nextRequiredAction) L.push(`Next required action: ${c.nextRequiredAction}`, "");
  L.push("### Do not repeat", "", ...list(c.doNotRepeat), "");
  L.push("### Stop conditions", "", ...list(c.stopConditions), "");
  L.push("### Policy reminders", "", ...list(c.policyReminders), "");
  L.push("## Artifacts", "");
  for (const [k, v] of Object.entries(h.artifactReferences)) if (v) L.push(`- ${k}: \`${v}\``);
  L.push("");
  return L.join("\n");
}
