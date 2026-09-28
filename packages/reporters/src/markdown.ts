import type { RunReport } from "@browserswarm/core";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Human-readable run report. All AI-generated claims are labeled probabilistic unless confirmed. */
export function renderMarkdownReport(r: RunReport): string {
  const o = r.overview;
  const e = r.execution;
  const L: string[] = [];
  const outcomeIcon: Record<string, string> = {
    passed: "PASS",
    failed: "FAIL",
    blocked: "BLOCKED",
    error: "ERROR",
    cancelled: "CANCELLED",
  };

  L.push(`# BrowserSwarm Report: ${o.planName}`, "");
  L.push(
    `Run \`${o.runId}\` finished in state **${o.runState}** (${Math.round(o.durationMs / 100) / 10}s).`,
    "",
  );
  L.push("## Run overview", "");
  L.push("| Field | Value |", "| --- | --- |");
  L.push(`| Target | ${o.target} |`);
  L.push(`| Allowed domains | ${o.allowedDomains.join(", ")} |`);
  L.push(`| Plan hash | \`${o.planHash}\` |`);
  L.push(`| Execution plan hash | \`${o.executionPlanHash}\` |`);
  L.push(
    `| Approval | ${o.approval.mode} by ${esc(o.approval.operator)} at ${o.approval.decidedAt} (\`${o.approval.approvalId}\`) |`,
  );
  L.push(
    `| Models configured | ${Object.entries(o.modelsConfigured)
      .map(([k, v]) => `${k}: ${v ? v.model : "none"}`)
      .join(", ")} |`,
  );
  L.push(
    `| Models invoked | ${o.modelsInvoked.length ? o.modelsInvoked.join(", ") : "none (zero LLM calls)"} |`,
  );
  L.push(`| Browser matrix | ${o.browserMatrix.join("; ")} |`);
  L.push(`| Concurrency | ${o.concurrency} (max observed ${e.maxObservedConcurrency}) |`);
  L.push(
    `| Context policy | warn ${o.contextPolicy.contextWarningThresholdPercent}%, hard stop ${o.contextPolicy.contextHardStopThresholdPercent}%, ` +
      `max actions/instance ${o.contextPolicy.maxActionsPerAgentInstance ?? "unset"}, max handoffs ${o.contextPolicy.maxHandoffsPerWorkPacket}, restore ${o.contextPolicy.restoreBrowserSession} |`,
  );
  L.push(
    `| Safety | destructive ${o.safetyPolicy.destructiveActions}, external navigation blocked, accounts ${o.safetyPolicy.allowAccountCreation ? "allowed" : "blocked"}, purchases ${o.safetyPolicy.allowPurchases ? "allowed" : "blocked"} |`,
  );
  L.push("");

  L.push("## Execution overview", "");
  L.push("| Metric | Value |", "| --- | --- |");
  const rows: [string, number | string][] = [
    ["Scenarios", e.scenarioCount],
    ["Work packets", e.packetCount],
    ["Agent instances", e.agentInstanceCount],
    [
      "Passed / failed / blocked / error / cancelled",
      `${e.packetsPassed} / ${e.packetsFailed} / ${e.packetsBlocked} / ${e.packetsErrored} / ${e.packetsCancelled}`,
    ],
    ["Deterministic operations", e.deterministicOperations],
    ["LLM-assisted operations", e.llmAssistedOperations],
    ["LLM calls / tokens", `${e.llmCalls} / ${e.llmTokens}`],
    ["Context warnings", e.contextWarnings],
    ["Checkpoints", e.checkpointCount],
    ["Handoffs", e.handoffCount],
    ["Replacement agents", e.replacementAgentCount],
    ["Packets resumed successfully", e.packetsResumedSuccessfully],
    ["Blocked by checkpoint/handoff failure", e.packetsBlockedByCheckpointOrHandoffFailure],
    ["Blocked by handoff limit", e.packetsBlockedByHandoffLimit],
  ];
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
  L.push("");

  L.push("## Work packets", "");
  L.push(
    "| Packet | Role | Viewport | Model | Outcome | Actions | Checkpoints | Handoffs | Agents |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const p of r.packets) {
    L.push(
      `| \`${p.packetId}\` | ${p.role} | ${p.viewportName} ${p.viewport.width}x${p.viewport.height} | ${p.model ?? "none"} | ${outcomeIcon[p.outcome]} | ${p.actionsCompleted} | ${p.checkpoints} | ${p.handoffs.length} | ${p.agentInstances.map((a) => a.agentInstanceId).join(" -> ")} |`,
    );
  }
  L.push("");
  for (const p of r.packets) {
    L.push(`### ${p.packetId}`, "");
    L.push(`- Scenario: ${p.scenarioTitle} (\`${p.scenarioId}\`)`);
    L.push(
      `- Outcome: **${outcomeIcon[p.outcome]}**${p.outcomeReason ? ` (${esc(p.outcomeReason)})` : ""}; final state ${p.state}`,
    );
    L.push(
      `- Agent-instance sequence: ${p.agentInstances.map((a) => `${a.agentInstanceId} [${a.state}${a.terminationReason ? `: ${esc(a.terminationReason)}` : ""}]`).join(" -> ")}`,
    );
    if (p.rotationReasons.length) L.push(`- Rotation reasons: ${p.rotationReasons.map(esc).join("; ")}`);
    L.push(`- Resume outcome: ${p.resumeOutcome}`);
    L.push(`- Artifacts: \`${p.artifactDir}/\``);
    L.push("", "| # | Action | Status | Summary |", "| --- | --- | --- | --- |");
    for (const s of p.stepResults)
      L.push(
        `| ${s.index} | ${s.action} | ${s.status} | ${esc(s.summary)}${s.error && s.status !== "passed" ? ` (${esc(s.error)})` : ""} |`,
      );
    L.push("");
    for (const h of p.handoffs) {
      L.push(`#### Handoff ${h.handoffId}`, "");
      L.push(
        `- Previous agent: ${h.previousAgentInstanceId}; replacement: ${h.replacementAgentInstanceId ?? "none"}`,
      );
      L.push(
        `- Trigger: ${h.triggerReason}; progress ${h.progressAtHandoff.completed}/${h.progressAtHandoff.total}; remaining steps ${h.remainingStepIndexes.join(", ") || "none"}`,
      );
      L.push(
        `- Restoration/replay: ${h.restorationOutcome}; integrity ${h.integrityValid ? "valid" : "INVALID"}; document \`${p.artifactDir}/${h.path}\``,
        "",
      );
    }
  }

  L.push("## Findings", "");
  if (!r.findings.length) L.push("No findings.", "");
  for (const f of r.findings) {
    L.push(`### ${esc(f.title)}`, "");
    L.push(
      `- Severity **${f.severity}**, confidence ${f.confidence}, status ${f.status}, verification ${f.verificationStatus}`,
    );
    L.push(
      `- Origin: ${f.origin}${f.probabilistic ? " (probabilistic, AI-generated claim)" : " (deterministic, evidence-backed)"}`,
    );
    L.push(
      `- Scenario \`${f.scenarioId}\`, role ${f.role}, viewport ${f.viewportName}, agent ${f.agentInstanceId}${f.persistedThroughHandoff ? " (persisted through handoff)" : ""}`,
    );
    L.push(`- Expected: ${esc(f.expected)}`);
    L.push(`- Actual: ${esc(f.actual)}`);
    L.push("- Reproduction:", ...f.reproductionSteps.map((s) => `  ${s}`));
    L.push(
      "- Evidence:",
      ...f.evidence.map((ev) => `  - ${ev.type}: ${esc(ev.summary)}${ev.path ? ` (\`${ev.path}\`)` : ""}`),
      "",
    );
  }

  L.push("## Limitations", "", ...r.limitations.map((l) => `- ${esc(l)}`), "");
  return L.join("\n");
}
