import { describeStep, type ExecutionPlan } from "@browserswarm/core";
import { summarizeSafety } from "@browserswarm/policy-engine";

const RULE = "------------------------------------------------";

function minutes(ms: number): string {
  const m = ms / 60_000;
  return m < 1 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(m * 10) / 10} min`;
}

/**
 * Human-readable execution plan review shown before approval. Everything the user approves is on this
 * screen: target, scope, scenarios and steps, packet assignments, models, budgets, lifecycle policy,
 * safety, risk flags, artifacts and integrity hashes.
 */
export function renderExecutionPlanReview(
  ep: ExecutionPlan,
  options: { includeSteps?: boolean } = {},
): string {
  const s = ep.summary;
  const cp = ep.contextLifecycle;
  const out: string[] = [];
  const line = (text = "") => out.push(text);
  const section = (title: string, items: string[]) => {
    line(`${title}:`);
    for (const item of items) line(`  ${item}`);
    line();
  };

  line(RULE);
  line("BrowserSwarm Execution Plan Review");
  line(RULE);
  line();
  section("Plan", [ep.planName, `id: ${ep.planId}   run: ${ep.runId}`]);
  section("Target", [ep.target.url]);
  section(
    "Allowed domains",
    ep.target.allowedDomains.map((d) => `- ${d}${ep.target.allowSubdomains ? " (and subdomains)" : ""}`),
  );
  section("Mode", [ep.mode]);
  section("Scenarios", [String(s.scenarioCount)]);
  section("Work packets", [String(s.workPacketCount)]);
  section("Maximum concurrent work packets", [String(s.maxConcurrentWorkPackets)]);
  section("Maximum concurrent browser contexts", [String(s.maxConcurrentBrowserContexts)]);
  section(
    "Browser / viewport matrix",
    s.browserMatrix.map((b) => `- ${b.engine} ${b.viewportName} ${b.viewport.width}x${b.viewport.height}`),
  );

  const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);
  section(
    "Models",
    Object.entries(ep.models).map(
      ([role, m]) => `- ${roleLabel(role)}: ${m ? `${m.provider}:${m.model}` : "none (deterministic only)"}`,
    ),
  );

  section("LLM policy", [
    `- Strategy: ${ep.llm.strategy}`,
    `- Maximum calls per work packet: ${ep.llm.maxCallsPerWorkPacket}`,
    `- Maximum tokens per call: ${ep.llm.maxTokensPerCall}`,
    `- Allowed triggers: ${ep.llm.allowedTriggers.length ? ep.llm.allowedTriggers.join(", ") : "none"}`,
  ]);

  section("Context lifecycle policy", [
    `- Context monitoring: ${cp.enabled ? "enabled" : "disabled"}`,
    `- Warning threshold: ${cp.contextWarningThresholdPercent}%`,
    `- Forced checkpoint threshold: ${cp.contextHardStopThresholdPercent}%`,
    `- Maximum agent actions before rotation: ${cp.maxActionsPerAgentInstance ?? "unset"}`,
    `- Maximum agent-instance duration: ${cp.maxDurationMsPerAgentInstance ? minutes(cp.maxDurationMsPerAgentInstance) : "unset"}`,
    `- Maximum messages per agent instance: ${cp.maxMessagesPerAgentInstance ?? "unset"}`,
    `- Maximum estimated tokens per agent instance: ${cp.maxEstimatedTotalTokensPerAgentInstance ?? "unset"}`,
    `- Maximum handoffs per work packet: ${cp.maxHandoffsPerWorkPacket}`,
    `- Browser session restoration: ${cp.restoreBrowserSession}`,
    `- Checkpoint after every step: ${cp.checkpointAfterEveryStep ? "enabled" : "disabled"}`,
    `- Checkpoint before risky action: ${cp.checkpointBeforeRiskyAction ? "enabled" : "disabled"}`,
    `- Handoff size budget: ~${cp.handoffMaxTokensEstimate} tokens`,
    "- Raw conversation transcript persistence: disabled",
  ]);

  section("Estimated execution", [
    `- Deterministic packets: ${s.deterministicPackets}`,
    `- LLM-capable packets: ${s.llmCapablePackets}`,
    `- Maximum browser actions: ${s.maxBrowserActions}`,
    `- Maximum LLM calls: ${s.maxLlmCalls}`,
    `- Estimated max tokens: ${s.estimatedMaxTokens.toLocaleString("en-US")}`,
    `- Estimated maximum agent instances: ${s.estimatedMaxAgentInstances}`,
    `- Estimated context handoffs: up to ${s.estimatedContextHandoffs}`,
    `- Estimated checkpoints: ${s.estimatedCheckpoints}`,
    `- Estimated runtime: ${minutes(s.estimatedRuntimeMs.min)}–${minutes(s.estimatedRuntimeMs.max)}`,
  ]);

  section(
    "Test data categories",
    s.testDataCategories.length ? s.testDataCategories.map((c) => `- ${c}`) : ["- none"],
  );
  section(
    "Safety",
    summarizeSafety(ep.safety).map((x) => `- ${x}`),
  );

  if (ep.riskFlags.length) {
    section("RISKY ACTIONS (require separate typed risk approval)", [
      ...ep.riskFlags.map(
        (f) => `- [${f.category}] scenario ${f.scenarioId} step ${f.stepIndex} (${f.action}): ${f.reason}`,
      ),
      `Risk plan hash: ${ep.riskPlanHash}`,
    ]);
  } else {
    section("Risky actions", ["- none detected"]);
  }

  const scenarioIds = [...new Set(ep.workPackets.map((p) => p.scenarioId))];
  line("Scenarios and ordered steps:");
  for (const id of scenarioIds) {
    const first = ep.workPackets.find((p) => p.scenarioId === id);
    if (!first) continue;
    line(`  [${id}] ${first.scenarioTitle} (priority ${first.priority})`);
    line(`    Objective: ${first.objective}`);
    line(`    Expected outcome: ${first.expectedOutcome}`);
    if (options.includeSteps !== false) {
      first.steps.forEach((step, i) => line(`    ${String(i).padStart(2, " ")}. ${describeStep(step)}`));
    }
  }
  line();

  line("Subagent assignments (work packets):");
  for (const p of ep.workPackets) {
    line(
      `  - ${p.packetId}: role=${p.role} viewport=${p.viewportName} ${p.viewport.width}x${p.viewport.height} ` +
        `mode=${p.mode} model=${p.model ? p.model.model : "none"} steps=${p.steps.length} ` +
        `actionBudget=${p.actionBudget} llmCalls=${p.llmCallBudget}${p.requiresExplicitRiskApproval ? " RISK" : ""}`,
    );
  }
  line();

  section("Artifacts", [
    "- Per-step action ledgers: enabled",
    `- Per-step checkpoints: ${cp.checkpointAfterEveryStep ? "enabled" : "disabled"}`,
    "- Handoff documents: enabled",
    `- Screenshots on failure: ${ep.browser.screenshot === "off" ? "disabled" : "enabled"}`,
    `- Playwright traces: ${ep.browser.trace ? "enabled" : "disabled"}`,
    `- Reports: ${ep.reporting.formats.join(", ")}`,
  ]);

  if (ep.limitations.length)
    section(
      "Current milestone limitations",
      ep.limitations.map((l) => `- ${l}`),
    );

  section("Integrity", [
    `- Test plan hash: ${ep.planHash}`,
    `- Execution plan hash: ${ep.executionPlanHash}`,
  ]);
  line("Approve execution of this exact plan?");
  line("Type: approve / reject / export / edit");
  line(RULE);
  return out.join("\n");
}
