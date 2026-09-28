import type { ExecutionPlan, TestPlan, WebsiteUnderstandingProfile } from "@browserswarm/core";

const RULE = "------------------------------------------------";

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Distinct list of route strings for display. */
function routesOf(xs: { routes: string[] }[]): string[] {
  return [...new Set(xs.flatMap((x) => x.routes))];
}

/**
 * The Autonomous Discovery Review shown at PENDING_APPROVAL. Everything the user approves is summarized
 * here: what discovery understood, what it deliberately did not touch, the exact proposed scenarios and
 * packets, budgets, and the three integrity hashes that the approval is bound to.
 */
export function renderAutonomousReview(
  profile: WebsiteUnderstandingProfile,
  plan: TestPlan,
  ep: ExecutionPlan,
): string {
  const out: string[] = [];
  const line = (t = "") => out.push(t);
  const c = profile.applicationClassification;
  const q = profile.qualitySurface;
  const st = profile.discoveryStats;
  const rc = profile.riskClassification;
  const restrictedRoutes = new Set([
    ...profile.accessModel.restrictedAreas.flatMap((a) => a.routes),
    ...profile.routeGraph.routes.filter((r) => r.requiresAuth).map((r) => r.path),
  ]);
  const roles = [...new Set(plan.scenarios.flatMap((s) => s.roles))];
  const rationale = new Map(
    profile.recommendedTestStrategy.recommendedAgentRoles.map((r) => [r.role, r.rationale]),
  );
  const plannedSteps = ep.workPackets.reduce((n, p) => n + p.steps.length, 0);

  line(RULE);
  line("BrowserSwarm Autonomous Discovery Review");
  line(RULE);
  line();
  line("Target:");
  line(`  ${profile.targetUrl}`);
  line();
  line("Allowed domains:");
  line(`  ${profile.allowedDomains.join(", ")}`);
  line();
  line("Discovery status:");
  line(`  ${profile.discoveryStatus}`);
  line();
  line("Website understanding:");
  line(`  - Primary category: ${c.primaryCategory} (confidence: ${pct(c.confidence)})`);
  if (c.secondaryCategories.length) line(`  - Secondary categories: ${c.secondaryCategories.join(", ")}`);
  line(`  - Summary: ${c.summary}`);
  line(`  - Authentication observed: ${profile.accessModel.authenticationObserved ? "yes" : "no"}`);
  line(`  - Public routes discovered: ${profile.accessModel.publicRoutes.length}`);
  line(`  - Restricted/authenticated routes observed: ${restrictedRoutes.size}`);
  line(`  - User journeys discovered: ${profile.userJourneys.length}`);
  line(`  - Domain entities identified: ${profile.domainModel.entities.length}`);
  line();
  line("Discovery limits:");
  line(`  - Routes visited/discovered: ${st.routesVisited}/${st.routesDiscovered}`);
  line(`  - Navigation depth reached: ${st.maxDepthReached}`);
  line(`  - Duration: ${duration(st.durationMs)}`);
  line(`  - Stop reason: ${st.stopReason}`);
  line(`  - Limitations: ${profile.limitations.length ? "" : "none recorded"}`);
  for (const l of profile.limitations.slice(0, 10)) line(`      * ${l}`);
  line();
  line("Safe areas discovered:");
  for (const a of rc.safeReadOnlyAreas.slice(0, 15)) line(`  - ${a.label} (${a.routes.length} route(s))`);
  if (!rc.safeReadOnlyAreas.length) line("  - none");
  line();
  line("Restricted or excluded areas:");
  const restricted = [
    ...rc.needsCredentials.map((a) => ({ a, why: "needs credentials" })),
    ...rc.needsTestData.map((a) => ({ a, why: "needs test data + risk approval" })),
    ...rc.needsExplicitRiskApproval.map((a) => ({ a, why: "needs explicit risk approval" })),
    ...rc.excludedByDefault.map((a) => ({ a, why: "excluded by default" })),
  ];
  for (const { a, why } of restricted.slice(0, 20)) line(`  - ${a.label} | ${why}: ${a.reason}`);
  if (restricted.length > 20) line(`  - ... ${restricted.length - 20} more (see risk-inventory.json)`);
  if (!restricted.length) line("  - none");
  line();
  line("Quality surface:");
  line(`  - Accessibility signals: ${q.accessibility.violationCount}`);
  line(`  - Console errors: ${q.console.errorCount}`);
  line(`  - Failed network requests: ${q.network.failedRequestCount + q.network.httpErrorCount}`);
  line(`  - Responsive concerns: ${q.responsive.concerns.length}`);
  line(`  - Broken media: ${q.brokenMedia.length}`);
  line();
  line("Proposed test strategy:");
  line(`  - Agent roles selected: ${roles.length}`);
  for (const r of roles) line(`      * ${r}: ${rationale.get(r) ?? "justified by discovery evidence"}`);
  line(`  - Scenarios proposed: ${plan.scenarios.length}`);
  line(`  - Work packets proposed: ${ep.summary.workPacketCount}`);
  line(`  - Maximum concurrent subagents: ${ep.summary.maxConcurrentWorkPackets}`);
  line(
    `  - Browser/viewport matrix: ${ep.summary.browserMatrix.map((b) => `${b.engine} ${b.viewportName} ${b.viewport.width}x${b.viewport.height}`).join("; ")}`,
  );
  line(`  - Deterministic packets: ${ep.summary.deterministicPackets}`);
  line(`  - LLM fallback-capable packets: ${ep.summary.llmCapablePackets}`);
  line(
    `  - Estimated browser actions: ${plannedSteps} planned steps (budget ${ep.summary.maxBrowserActions})`,
  );
  line(`  - Estimated LLM calls: ${ep.summary.maxLlmCalls}`);
  line(`  - Estimated token budget: ${ep.summary.estimatedMaxTokens}`);
  line(`  - Estimated context rotations/handoffs: ${ep.summary.estimatedContextHandoffs}`);
  line();
  line("Proposed scenarios:");
  plan.scenarios.forEach((s, i) => {
    const route = s.routes?.join(", ") ?? "-";
    line(
      `  ${i + 1}. ${s.id} | ${s.roles.join(",")} | ${route} | ${s.objective} | ${s.safetyClass ?? "safe-read-only"}`,
    );
  });
  line();
  line("Deferred (not executed; need data, credentials or risk approval):");
  for (const d of (plan.deferredScenarios ?? []).slice(0, 20))
    line(`  - ${d.title} | ${d.safetyClass}: ${d.reason}`);
  if (!(plan.deferredScenarios ?? []).length) line("  - none");
  line();
  line("Explicitly excluded:");
  for (const e of (plan.excludedScenarios ?? []).slice(0, 25))
    line(`  - ${e.title}${e.routes.length ? ` (${e.routes.slice(0, 3).join(", ")})` : ""} | ${e.reason}`);
  if ((plan.excludedScenarios ?? []).length > 25)
    line(`  - ... ${(plan.excludedScenarios ?? []).length - 25} more`);
  const conflicts = plan.origin?.scopeResolution?.conflicts ?? [];
  if (conflicts.length) {
    line();
    line("Scope conflicts (safety policy wins):");
    for (const x of conflicts) line(`  - ${x}`);
  }
  line();
  line("Integrity:");
  line(`  - Discovery profile hash: ${profile.profileHash}`);
  line(`  - Test plan hash: ${ep.planHash}`);
  line(`  - Execution plan hash: ${ep.executionPlanHash}`);
  line();
  line("Choose:");
  line("  approve-safe-plan");
  line("  export-and-edit");
  line("  reject");
  line(RULE);
  return out.join("\n");
}

/** Human-readable plan summary written next to the generated plan (autonomous-plan-summary.md). */
export function renderPlanSummaryMarkdown(
  profile: WebsiteUnderstandingProfile,
  plan: TestPlan,
  ep: ExecutionPlan,
): string {
  const out: string[] = [];
  const c = profile.applicationClassification;
  out.push(`# Autonomous test plan: ${plan.name}`);
  out.push("");
  out.push(`- Target: ${profile.targetUrl}`);
  out.push(`- Website category: ${c.primaryCategory} (${pct(c.confidence)} confidence)`);
  out.push(`- Discovery status: ${profile.discoveryStatus}`);
  out.push(
    `- Scenarios: ${plan.scenarios.length}; work packets: ${ep.summary.workPacketCount}; max concurrency: ${ep.summary.maxConcurrentWorkPackets}`,
  );
  out.push(`- Profile hash: \`${profile.profileHash}\``);
  out.push(`- Test plan hash: \`${ep.planHash}\``);
  out.push(`- Execution plan hash: \`${ep.executionPlanHash}\``);
  out.push("");
  out.push("## Scenarios (safe, read-only)");
  out.push("");
  out.push("| ID | Role | Routes | Source | Priority | Evidence |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const s of plan.scenarios)
    out.push(
      `| ${s.id} | ${s.roles.join(", ")} | ${(s.routes ?? []).join(", ")} | ${s.source ?? "-"} | ${s.priority} | ${(s.evidence ?? []).map((e) => e.evidenceId).join(", ")} |`,
    );
  out.push("");
  out.push("## Deferred");
  out.push("");
  for (const d of plan.deferredScenarios ?? []) out.push(`- **${d.title}** (${d.safetyClass}): ${d.reason}`);
  if (!(plan.deferredScenarios ?? []).length) out.push("- none");
  out.push("");
  out.push("## Excluded");
  out.push("");
  for (const e of plan.excludedScenarios ?? []) out.push(`- **${e.title}**: ${e.reason}`);
  out.push("");
  out.push("## Editing");
  out.push("");
  out.push(
    "Remove scenarios, routes, roles or categories from the exported plan (or use `--exclude-*` flags), then preview and approve again. Any edit changes the plan hash and requires a fresh approval.",
  );
  out.push("");
  out.push(`Routes covered: ${routesOf(plan.scenarios.map((s) => ({ routes: s.routes ?? [] }))).join(", ")}`);
  out.push("");
  return out.join("\n");
}
