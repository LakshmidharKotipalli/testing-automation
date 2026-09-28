import {
  DiscoveryReportSchema,
  type DiscoveryReport,
  type WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import { systemClock, type Clock } from "@browserswarm/shared";
import { RunLayout, type StorageAdapter } from "@browserswarm/storage";
import type { DiscoveryRunResult } from "./types.js";

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function buildDiscoveryReport(
  profile: WebsiteUnderstandingProfile,
  result: DiscoveryRunResult,
  clock: Clock = systemClock,
): DiscoveryReport {
  return DiscoveryReportSchema.parse({
    version: 1,
    runId: profile.runId,
    profileId: profile.profileId,
    profileHash: profile.profileHash,
    targetUrl: profile.targetUrl,
    allowedDomains: profile.allowedDomains,
    generatedAt: clock.iso(),
    discoveryStatus: profile.discoveryStatus,
    stats: profile.discoveryStats,
    guarantees: result.packet.guarantees,
    blockedRequests: result.blockedRequests
      .slice(0, 200)
      .map((b) => ({ url: b.url.slice(0, 500), method: b.method, reason: b.reason.slice(0, 300) })),
    restrictedControlsNotUsed: result.restricted.length,
    artifacts: result.artifacts,
    limitations: profile.limitations,
  });
}

/** Mermaid flowchart of the discovered route graph (bounded). */
export function renderRouteMapMermaid(profile: WebsiteUnderstandingProfile, maxEdges = 150): string {
  const ids = new Map<string, string>();
  const id = (p: string) => {
    let v = ids.get(p);
    if (!v) {
      v = `r${ids.size}`;
      ids.set(p, v);
    }
    return v;
  };
  const esc = (s: string) => s.replace(/["[\]{}()<>|]/g, " ").slice(0, 60);
  const lines = ["flowchart LR"];
  for (const r of profile.routeGraph.routes) {
    const shape = r.requiresAuth
      ? `{{"${esc(r.path)} (auth)"}}`
      : r.status === "visited"
        ? `["${esc(r.path)}"]`
        : `("${esc(r.path)}")`;
    lines.push(`  ${id(r.path)}${shape}`);
  }
  for (const e of profile.routeGraph.edges.slice(0, maxEdges)) {
    if (!ids.has(e.to)) continue;
    const arrow = e.kind === "redirect" ? "-.->" : e.kind === "search" ? "==>" : "-->";
    lines.push(`  ${id(e.from)} ${arrow}|${esc(e.label || e.kind) || e.kind}| ${id(e.to)}`);
  }
  if (profile.routeGraph.edges.length > maxEdges)
    lines.push(`  %% ${profile.routeGraph.edges.length - maxEdges} more edge(s) omitted`);
  return `${lines.join("\n")}\n`;
}

function list(items: string[], empty = "- none"): string[] {
  return items.length ? items.map((i) => `- ${i}`) : [empty];
}

export function renderProfileMarkdown(p: WebsiteUnderstandingProfile): string {
  const c = p.applicationClassification;
  const out: string[] = [
    `# Website Understanding Profile`,
    "",
    `- Target: ${p.targetUrl}`,
    `- Allowed domains: ${p.allowedDomains.join(", ")}`,
    `- Discovery status: **${p.discoveryStatus}**`,
    `- Profile: ${p.profileId} (\`${p.profileHash}\`)`,
    "",
    "## Classification (inference)",
    "",
    `- Primary category: **${c.primaryCategory}** (confidence ${pct(c.confidence)})`,
    `- Secondary: ${c.secondaryCategories.join(", ") || "none"}`,
    `- ${c.summary}`,
    ...c.evidence.slice(0, 5).map((e) => `  - evidence ${e.evidenceId}: ${e.excerpt}`),
    "",
    "## Business purpose (inference)",
    "",
    `- ${p.businessPurpose.inferredPurpose} (confidence ${pct(p.businessPurpose.confidence)})`,
    ...list(
      p.businessPurpose.primaryUserGoals.map((g) => `Goal: ${g}`),
      "- No user goals inferred",
    ),
    "",
    "## Access model (facts)",
    "",
    `- Public routes: ${p.accessModel.publicRoutes.length}`,
    `- Authentication observed: ${p.accessModel.authenticationObserved ? "yes" : "no"}`,
    ...p.accessModel.authBoundaries.map((b) => `- Auth boundary: ${b.route} (${b.kind})`),
    ...p.accessModel.observedRoles.map((r) => `- Role (inferred): ${r.name}`),
    "",
    "## Routes",
    "",
    "| Path | Status | Depth | Title | Auth |",
    "| --- | --- | --- | --- | --- |",
    ...p.routeGraph.routes.map(
      (r) =>
        `| ${r.path} | ${r.status} | ${r.depth} | ${r.title.replace(/\|/g, "/")} | ${r.requiresAuth ? "yes" : ""} |`,
    ),
    "",
    "## Domain model",
    "",
    ...list(
      p.domainModel.entities.map(
        (e) =>
          `${e.name} (${e.sourceKind}; ${e.attributes.slice(0, 6).join(", ")}) on ${e.routes.join(", ")}`,
      ),
      "- No entities identified",
    ),
    "",
    `Terminology: ${p.domainModel.terminology.map((t) => t.term).join(", ") || "none"}`,
    "",
    ...list(
      p.domainModel.domainRulesObserved.map((r) => `Observed rule: ${r.description}`),
      "- No domain rules observed",
    ),
    ...p.domainModel.domainRulesNeedingVerification.map((r) => `- Needs verification: ${r.description}`),
    "",
    "## User journeys",
    "",
    ...list(
      p.userJourneys.map(
        (j) => `${j.name} [${j.kind}] ${j.routes.join(" → ")} (confidence ${pct(j.confidence)})`,
      ),
    ),
    "",
    "## Assumptions",
    "",
    ...list(p.assumptions),
    "",
    "## Limitations",
    "",
    ...list(p.limitations),
    "",
  ];
  return out.join("\n");
}

export function renderDiscoveryReportMarkdown(p: WebsiteUnderstandingProfile, r: DiscoveryReport): string {
  const rc = p.riskClassification;
  const q = p.qualitySurface;
  const s = p.recommendedTestStrategy;
  const out: string[] = [
    "# Discovery Report",
    "",
    `Target ${p.targetUrl} · status **${p.discoveryStatus}** · ${r.stats.routesVisited}/${r.stats.routesDiscovered} routes visited · depth ${r.stats.maxDepthReached} · ${Math.round(r.stats.durationMs / 1000)}s`,
    "",
    "## 1. What the website appears to be",
    "",
    `**${p.applicationClassification.primaryCategory}** (confidence ${pct(p.applicationClassification.confidence)}). ${p.applicationClassification.summary}`,
    "",
    "## 2. Evidence",
    "",
    ...list(
      p.applicationClassification.evidence.map(
        (e) => `${e.evidenceId} (${e.kind}${e.route ? `, ${e.route}` : ""}): ${e.excerpt}`,
      ),
    ),
    "",
    "## 3. Route map",
    "",
    "```mermaid",
    renderRouteMapMermaid(p, 60).trimEnd(),
    "```",
    "",
    "## 4. Visible user journeys",
    "",
    ...list(p.userJourneys.map((j) => `${j.name}: ${j.routes.join(" → ")}`)),
    "",
    "## 5. Domain entities and terminology",
    "",
    ...list(p.domainModel.entities.map((e) => `${e.name}: ${e.attributes.slice(0, 8).join(", ")}`)),
    `- Terms: ${
      p.domainModel.terminology
        .slice(0, 15)
        .map((t) => t.term)
        .join(", ") || "none"
    }`,
    "",
    "## 6. Public / read-only features",
    "",
    ...list(rc.safeReadOnlyAreas.map((a) => `${a.label}: ${a.routes.slice(0, 6).join(", ")}`)),
    "",
    "## 7. Features that appear to require login",
    "",
    ...list([...rc.needsCredentials.map((a) => `${a.label}: ${a.reason}`)]),
    "",
    "## 8. State-changing controls discovered but deliberately not used",
    "",
    `${r.restrictedControlsNotUsed} restricted candidate(s) recorded; ${q.network.blockedNonReadCount} non-GET request(s) and ${q.network.blockedExternalCount} external request(s) blocked.`,
    "",
    ...list(
      [...rc.needsExplicitRiskApproval, ...rc.needsTestData, ...rc.excludedByDefault].map(
        (a) => `${a.label}: ${a.reason}`,
      ),
    ),
    "",
    "## 9. Potential test areas",
    "",
    ...list(s.recommendedAgentRoles.map((x) => `${x.role}: ${x.routes.slice(0, 5).join(", ")}`)),
    "",
    "## 10. Quality observations",
    "",
    `- Accessibility: ${q.accessibility.violationCount} violation(s) on ${q.accessibility.routesScanned} scanned route(s)`,
    ...q.accessibility.topRules.slice(0, 8).map((x) => `  - ${x.id} (${x.impact}) × ${x.count}: ${x.help}`),
    `- Console errors: ${q.console.errorCount}; warnings: ${q.console.warningCount}`,
    `- Failed requests: ${q.network.failedRequestCount}; HTTP errors: ${q.network.httpErrorCount}`,
    `- Responsive concerns: ${q.responsive.concerns.length}`,
    ...q.responsive.concerns.slice(0, 5).map((x) => `  - ${x.route} @ ${x.viewport}: ${x.issue}`),
    `- Broken media: ${q.brokenMedia.length}; visible error states: ${q.visibleErrorStates.length}`,
    "",
    "## 11. Recommended test-agent roles",
    "",
    ...list(s.recommendedAgentRoles.map((x) => `**${x.role}**: ${x.rationale}`)),
    "",
    "## 12. Proposed safe test scenarios",
    "",
    ...list(
      s.recommendedScenarios.map(
        (x) => `${x.scenarioId} | ${x.role} | ${x.routes.join(", ")} | ${x.safetyClass}`,
      ),
    ),
    "",
    "## 13. Excluded and risky scenarios",
    "",
    ...list(s.excludedScenarios.map((x) => `${x.title} | ${x.safetyClass}: ${x.reason}`)),
    "",
    "## 14. Limitations and confidence",
    "",
    ...list(p.limitations),
    "",
    "## Read-only guarantees",
    "",
    ...list(r.guarantees),
    "",
    `Profile hash: \`${p.profileHash}\``,
    "",
  ];
  return out.join("\n");
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Self-contained HTML rendering of the discovery report (no external assets or scripts). */
export function renderDiscoveryReportHtml(p: WebsiteUnderstandingProfile, r: DiscoveryReport): string {
  const md = renderDiscoveryReportMarkdown(p, r);
  const body = md
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return `<h1>${escHtml(line.slice(2))}</h1>`;
      if (line.startsWith("## ")) return `<h2>${escHtml(line.slice(3))}</h2>`;
      if (line.startsWith("  - ")) return `<li class="sub">${escHtml(line.slice(4))}</li>`;
      if (line.startsWith("- ")) return `<li>${escHtml(line.slice(2))}</li>`;
      if (line.startsWith("```")) return line === "```mermaid" ? '<pre class="mermaid">' : "</pre>";
      return line ? `<p>${escHtml(line)}</p>` : "";
    })
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BrowserSwarm Discovery Report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 16px; line-height: 1.45; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 1.6rem; border-bottom: 1px solid #8884; }
  li { margin: 2px 0 2px 1rem; } li.sub { margin-left: 2.2rem; font-size: .92em; }
  pre { overflow-x: auto; background: #8881; padding: 8px; font-size: .8em; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Writes every discovery output file. Returns the relative paths written. */
export async function writeDiscoveryOutputs(
  storage: StorageAdapter,
  profile: WebsiteUnderstandingProfile,
  report: DiscoveryReport,
): Promise<string[]> {
  const D = RunLayout.discovery;
  const files: [string, string | unknown][] = [
    [D.profileJson, profile],
    [D.profileMarkdown, renderProfileMarkdown(profile)],
    [D.profileHash, `${profile.profileHash}\n`],
    [D.reportJson, report],
    [D.reportMarkdown, renderDiscoveryReportMarkdown(profile, report)],
    [D.reportHtml, renderDiscoveryReportHtml(profile, report)],
    [D.routeMap, profile.routeGraph],
    [D.routeMapMermaid, renderRouteMapMermaid(profile)],
    [
      D.routeInventory,
      {
        routes: profile.routeGraph.routes,
        blocked: profile.routeGraph.unreachableOrBlockedRoutes,
        external: profile.routeGraph.externalLinks,
      },
    ],
    [D.uiInventory, profile.uiInventory],
    [D.domainModel, profile.domainModel],
    [D.journeyInventory, profile.userJourneys],
    [
      D.riskInventory,
      {
        accessModel: profile.accessModel,
        riskClassification: profile.riskClassification,
        restrictedControls: profile.uiInventory.sideEffectingControls,
      },
    ],
    [D.qualitySurface, profile.qualitySurface],
  ];
  for (const [path, content] of files) {
    if (typeof content === "string") await storage.writeText(path, content);
    else await storage.writeJson(path, content);
  }
  return files.map(([p]) => p);
}
