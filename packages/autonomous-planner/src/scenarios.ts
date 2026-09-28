import {
  type AgentRole,
  type DeferredScenario,
  type EvidenceReference,
  type ExcludedScenario,
  type Locator,
  type Priority,
  type RecommendedAgentRole,
  type ScenarioSafetyClass,
  type ScenarioSource,
  type TestStepInput,
  type WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import { RISK_RULES } from "@browserswarm/policy-engine";
import { slugify } from "@browserswarm/shared";

/** The profile without the recommendation block: the planner derives recommendations from these facts. */
export type ProfileFacts = Omit<WebsiteUnderstandingProfile, "recommendedTestStrategy" | "profileHash">;

/** A scenario the planner can run: deterministic steps built only from observed routes and locators. */
export interface CandidateScenario {
  id: string;
  title: string;
  objective: string;
  role: AgentRole;
  category: string;
  source: ScenarioSource;
  safetyClass: "safe-read-only";
  priority: Priority;
  routes: string[];
  viewports: string[];
  preconditions: string[];
  expectedOutcome: string;
  steps: TestStepInput[];
  evidence: EvidenceReference[];
  rationale: string;
}

export interface ScenarioCandidates {
  scenarios: CandidateScenario[];
  deferred: DeferredScenario[];
  excluded: ExcludedScenario[];
  roles: RecommendedAgentRole[];
}

export interface CandidateOptions {
  /** Maximum routes per quality role (accessibility, responsive, console-network). */
  maxRoutesPerQualityRole?: number;
  /** Maximum journeys per functional role. */
  maxJourneysPerRole?: number;
  /** Viewport names available in the plan. The first is the primary (desktop) viewport. */
  viewports?: string[];
}

const ROLE_RATIONALE: Partial<Record<AgentRole, string>> = {
  navigation: "internal navigation links were observed between discovered public routes",
  content: "the site presents readable content (headings, articles or cards) on public routes",
  "table-data": "data tables with column headers were observed",
  dashboard: "dashboard-like pages (multiple tables or metric lists) were observed",
  "search-filter": "a read-only GET search/filter form was observed and exercised during discovery",
  "forms-read-only":
    "forms were observed; they are checked for rendering and labelling only, never submitted",
  "functional-ui": "tabs, disclosures or pagination were exercised safely during discovery",
  "ecommerce-browse-only": "product listing/detail browsing was observed; cart and checkout are excluded",
  "booking-browse-only": "booking-related listing/detail browsing was observed; reservations are excluded",
  accessibility: "public routes were discovered; axe-core scans check them nonintrusively",
  responsive: "a mobile viewport was inspected during discovery",
  "console-network":
    "console errors or failed requests were observed, or key public routes need a smoke check",
  "domain-consistency": "the same labelled value was visible on more than one route",
};

const isRiskyLabel = (label: string) => RISK_RULES.some((r) => r.pattern.test(label.replace(/[-_]/g, " ")));

function heading(profile: ProfileFacts, route: string): string | undefined {
  const r = profile.routeGraph.routes.find((x) => x.path === route);
  return r?.headings.find((h) => h.trim().length > 0 && h.length <= 120);
}

function routeEvidence(profile: ProfileFacts, route: string): EvidenceReference[] {
  const r = profile.routeGraph.routes.find((x) => x.path === route);
  return r?.evidence.slice(0, 2) ?? [];
}

function pathOnly(route: string): string {
  return route.split("?")[0] as string;
}

/**
 * Ranks public visited routes: entry and primary-nav targets first, then by depth. Query-string variants of a
 * path already in the list (e.g. /catalog?page=2 next to /catalog) are dropped to avoid redundant packets.
 */
export function rankedPublicRoutes(profile: ProfileFacts): string[] {
  const nav = new Set(profile.uiInventory.navigationPatterns.flatMap((n) => n.routes));
  const entry = new Set(profile.routeGraph.entryRoutes);
  const qualityHits = new Map<string, number>();
  for (const s of profile.qualitySurface.console.samples)
    qualityHits.set(s.route, (qualityHits.get(s.route) ?? 0) + 1);
  for (const s of profile.qualitySurface.network.samples)
    qualityHits.set(s.route, (qualityHits.get(s.route) ?? 0) + 1);
  const pub = new Set(profile.accessModel.publicRoutes);
  return profile.routeGraph.routes
    .filter((r) => r.status === "visited" && !r.requiresAuth && pub.has(r.path))
    .map((r) => ({
      path: r.path,
      score:
        (entry.has(r.path) ? 100 : 0) +
        (nav.has(r.path) ? 50 : 0) +
        (qualityHits.get(r.path) ?? 0) * 5 -
        r.depth,
    }))
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .map((r) => r.path)
    .filter((p, i, all) => all.findIndex((q) => pathOnly(q) === pathOnly(p)) === i);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Builds safe, deterministic scenario candidates from observed facts only. A role gets scenarios only when
 * the profile contains evidence for it; restricted areas become deferred or excluded scenarios instead.
 */
export function buildScenarioCandidates(
  profile: ProfileFacts,
  options: CandidateOptions = {},
): ScenarioCandidates {
  const maxQ = options.maxRoutesPerQualityRole ?? 6;
  const maxJ = options.maxJourneysPerRole ?? 6;
  const viewports = options.viewports ?? ["desktop", "mobile"];
  const desktop = viewports[0] ?? "desktop";
  const mobile = viewports.find((v) => /mobile|phone/i.test(v));
  const scenarios: CandidateScenario[] = [];
  const deferred: DeferredScenario[] = [];
  const excluded: ExcludedScenario[] = [];
  const ids = new Set<string>();
  const uid = (base: string) => {
    let id = slugify(base).slice(0, 80) || "scenario";
    for (let n = 2; ids.has(id); n++) id = `${slugify(base).slice(0, 76)}-${n}`;
    ids.add(id);
    return id;
  };
  const ranked = rankedPublicRoutes(profile);
  const category = profile.applicationClassification.primaryCategory;
  const secondary = new Set(profile.applicationClassification.secondaryCategories);
  const isCat = (c: string) => category === c || secondary.has(c);
  const add = (s: Omit<CandidateScenario, "id" | "safetyClass"> & { idBase: string }) => {
    const { idBase, ...rest } = s;
    if (!rest.evidence.length) return; // never schedule without evidence
    scenarios.push({ ...rest, id: uid(idBase), safetyClass: "safe-read-only" });
  };

  // --- navigation: primary navigation journeys from the entry route -----------------------------------
  const entry = profile.routeGraph.entryRoutes[0] ?? "/";
  const navEdges = profile.routeGraph.edges.filter(
    (e) =>
      e.from === entry &&
      e.kind === "link" &&
      e.to !== entry &&
      e.label.trim().length > 0 &&
      e.label.length <= 80 &&
      !isRiskyLabel(e.label) &&
      ranked.includes(e.to),
  );
  const seenTargets = new Set<string>();
  for (const e of navEdges) {
    if (seenTargets.size >= maxJ + 2) break;
    if (seenTargets.has(e.to)) continue;
    seenTargets.add(e.to);
    const h = heading(profile, e.to);
    const steps: TestStepInput[] = [
      { action: "navigate", url: entry },
      { action: "assert_visible", locator: { role: "link", name: e.label, exact: true } },
      { action: "click", locator: { role: "link", name: e.label, exact: true } },
      { action: "assert_url_contains", value: pathOnly(e.to) === "/" ? "/" : pathOnly(e.to) },
      ...(h ? [{ action: "assert_visible", locator: { role: "heading", name: h } } as TestStepInput] : []),
      { action: "inspect_console_logs" },
    ];
    add({
      idBase: `nav-${e.to === "/" ? "home" : e.to}`,
      title: `Navigate from ${entry} to "${e.label}"`,
      objective: `Verify the observed link "${e.label}" on ${entry} opens ${e.to}${h ? ` showing "${h}"` : ""}.`,
      role: "navigation",
      category: "navigation",
      source: "discovery-journey",
      priority: "high",
      routes: [entry, e.to],
      viewports: [desktop],
      preconditions: ["Public page; no sign-in required"],
      expectedOutcome: `The link navigates to ${e.to}${h ? ` and the heading "${h}" is visible` : ""}.`,
      steps,
      evidence: [...routeEvidence(profile, entry).slice(0, 1), ...routeEvidence(profile, e.to).slice(0, 1)],
      rationale: `Link "${e.label}" from ${entry} to ${e.to} was observed during discovery (${ROLE_RATIONALE.navigation}).`,
    });
  }

  // --- content: headings on content-bearing routes -------------------------------------------------------
  const contentLike = isCat("content") || isCat("documentation") || isCat("portfolio") || isCat("education");
  const contentRoutes = ranked.filter((r) => {
    const route = profile.routeGraph.routes.find((x) => x.path === r);
    return route && route.headings.length >= 2 && (contentLike || route.landmarks.includes("article"));
  });
  for (const r of contentRoutes.slice(0, maxJ)) {
    const route = profile.routeGraph.routes.find((x) => x.path === r);
    const hs = (route?.headings ?? []).filter((h) => h.length <= 120).slice(0, 3);
    if (!hs.length) continue;
    add({
      idBase: `content-${r === "/" ? "home" : r}`,
      title: `Content structure of ${r}`,
      objective: `Verify the observed headings on ${r} render.`,
      role: "content",
      category: "content",
      source: "discovery-route",
      priority: "medium",
      routes: [r],
      viewports: [desktop],
      preconditions: ["Public page; content may change over time (headings observed during discovery)"],
      expectedOutcome: `Headings ${hs.map((h) => `"${h}"`).join(", ")} are visible on ${r}.`,
      steps: [
        { action: "navigate", url: r },
        ...hs.map(
          (h) => ({ action: "assert_visible", locator: { role: "heading", name: h } }) as TestStepInput,
        ),
        { action: "screenshot", name: "content", fullPage: true },
      ],
      evidence: routeEvidence(profile, r),
      rationale: `Headings observed on ${r} (${ROLE_RATIONALE.content}).`,
    });
  }

  // --- table-data ----------------------------------------------------------------------------------------
  const tablesByRoute = new Map<string, typeof profile.uiInventory.tables>();
  for (const t of profile.uiInventory.tables) {
    if (!ranked.includes(t.route) || t.headers.length === 0) continue;
    tablesByRoute.set(t.route, [...(tablesByRoute.get(t.route) ?? []), t]);
  }
  for (const [r, tables] of [...tablesByRoute.entries()].slice(0, maxJ)) {
    const t = tables[0] as (typeof tables)[number];
    const headers = t.headers.filter((h) => h.length > 0 && h.length <= 60).slice(0, 5);
    // Header cells are matched as text inside the table: engines disagree on whether a <th> without
    // scope is a "columnheader" or a "cell", so a role-based header locator would be fragile.
    const table: Locator = t.caption ? { role: "table", name: t.caption } : { role: "table" };
    const steps: TestStepInput[] = [
      { action: "navigate", url: r },
      { action: "assert_visible", locator: table },
      ...headers.map((h) => ({ action: "assert_text_contains", locator: table, text: h }) as TestStepInput),
    ];
    add({
      idBase: `table-${r === "/" ? "home" : r}`,
      title: `Data table on ${r} shows its columns`,
      objective: `Verify the table observed on ${r} renders with its ${t.headers.length} column header(s).`,
      role: "table-data",
      category: "data",
      source: "discovery-route",
      priority: "medium",
      routes: [r],
      viewports: [desktop],
      preconditions: ["Public page; row counts may vary and are not asserted"],
      expectedOutcome: `A table with headers ${headers.map((h) => `"${h}"`).join(", ")} is visible.`,
      steps,
      evidence: t.evidence.slice(0, 2),
      rationale: `Table with headers observed on ${r} (${ROLE_RATIONALE["table-data"]}).`,
    });
  }

  // --- dashboard -----------------------------------------------------------------------------------------
  const dashboardRoutes = ranked.filter((r) => {
    const route = profile.routeGraph.routes.find((x) => x.path === r);
    return route && (route.counts.tables >= 2 || (isCat("dashboard") && route.counts.tables >= 1));
  });
  for (const r of dashboardRoutes.slice(0, 3)) {
    const h = heading(profile, r);
    add({
      idBase: `dashboard-${r === "/" ? "home" : r}`,
      title: `Dashboard view ${r} renders`,
      objective: `Verify the dashboard-like page ${r} renders its heading and data regions.`,
      role: "dashboard",
      category: "data",
      source: "discovery-route",
      priority: "medium",
      routes: [r],
      viewports: [desktop],
      preconditions: ["Public page"],
      expectedOutcome: `${r} shows ${h ? `"${h}" and ` : ""}its tables.`,
      steps: [
        { action: "navigate", url: r },
        ...(h ? [{ action: "assert_visible", locator: { role: "heading", name: h } } as TestStepInput] : []),
        { action: "assert_visible", locator: { role: "table" } },
        { action: "screenshot", name: "dashboard", fullPage: true },
      ],
      evidence: routeEvidence(profile, r),
      rationale: `${r} contains multiple data regions (${ROLE_RATIONALE.dashboard}).`,
    });
  }

  // --- search-filter (read-only GET URLs only) ----------------------------------------------------------
  for (const sf of profile.uiInventory.searchAndFilters
    .filter((x) => x.exercisedUrl && x.resultsObserved)
    .slice(0, maxJ)) {
    const url = sf.exercisedUrl as string;
    const param = sf.paramName ?? "";
    add({
      idBase: `${sf.kind}-${sf.route === "/" ? "home" : sf.route}`,
      title: `Read-only ${sf.kind} on ${sf.route}`,
      objective: `Verify the read-only ${sf.kind} URL observed on ${sf.route} returns a results page.`,
      role: "search-filter",
      category: "search",
      source: "discovery-journey",
      priority: "medium",
      routes: [sf.route],
      viewports: [desktop],
      preconditions: [
        "Uses the exact GET query observed during discovery (term taken from visible page text)",
      ],
      expectedOutcome: `Opening ${url} shows a results page without errors.`,
      steps: [
        { action: "navigate", url },
        ...(param ? [{ action: "assert_url_contains", value: `${param}=` } as TestStepInput] : []),
        { action: "assert_visible", locator: { role: "heading" } },
        { action: "inspect_console_logs" },
      ],
      evidence: sf.evidence.slice(0, 2),
      rationale: `${sf.kind} form on ${sf.route} was exercised as a GET URL during discovery (${ROLE_RATIONALE["search-filter"]}).`,
    });
  }

  // --- forms-read-only: rendering and labels only ---------------------------------------------------------
  const formsSeen = new Set<string>();
  for (const f of profile.uiInventory.forms) {
    if (formsSeen.size >= maxJ) break;
    if (!ranked.includes(f.route) || formsSeen.has(f.route)) continue;
    const labels = f.fields
      .map((x) => x.label)
      .filter((l) => l && l.length <= 60)
      .slice(0, 5);
    if (!labels.length) continue;
    formsSeen.add(f.route);
    add({
      idBase: `form-render-${f.route === "/" ? "home" : f.route}`,
      title: `Form on ${f.route} renders labelled fields (no submission)`,
      objective: `Verify the ${f.purpose} form on ${f.route} renders its labelled fields. The form is never filled or submitted.`,
      role: "forms-read-only",
      category: "forms",
      source: "discovery-route",
      priority: "low",
      routes: [f.route],
      viewports: [desktop],
      preconditions: ["Read-only: no typing, no submission"],
      expectedOutcome: `Fields ${labels.map((l) => `"${l}"`).join(", ")} are visible.`,
      steps: [
        { action: "navigate", url: f.route },
        ...labels.map((l) => ({ action: "assert_visible", locator: { label: l } }) as TestStepInput),
      ],
      evidence: f.evidence.slice(0, 2),
      rationale: `A ${f.purpose} form was observed on ${f.route} (${ROLE_RATIONALE["forms-read-only"]}).`,
    });
  }

  // --- functional-ui: tabs / disclosures / pagination exercised during discovery ------------------------
  const toggles = profile.uiInventory.tabsAndAccordions.filter(
    (t) => t.exercised && t.locator && ranked.includes(t.route),
  );
  for (const t of toggles.slice(0, maxJ)) {
    const loc = t.locator as Locator;
    const steps: TestStepInput[] = [
      { action: "navigate", url: t.route },
      { action: "assert_visible", locator: loc },
      { action: "click", locator: loc },
      ...(t.kind === "tab"
        ? [{ action: "assert_visible", locator: { role: "tabpanel" } } as TestStepInput]
        : []),
      { action: "assert_url_contains", value: pathOnly(t.route) },
    ];
    add({
      idBase: `ui-${t.kind}-${t.route === "/" ? "home" : t.route}-${t.label}`,
      title: `${t.kind} "${t.label}" on ${t.route} toggles without navigation`,
      objective: `Verify the ${t.kind} "${t.label}" observed on ${t.route} can be operated without leaving the page.`,
      role: "functional-ui",
      category: "interaction",
      source: "discovery-route",
      priority: "low",
      routes: [t.route],
      viewports: [desktop],
      preconditions: ["Non-persistent UI state only"],
      expectedOutcome: `The ${t.kind} responds and the URL stays on ${pathOnly(t.route)}.`,
      steps,
      evidence: t.evidence.slice(0, 2),
      rationale: `${t.kind} "${t.label}" was exercised safely during discovery (${ROLE_RATIONALE["functional-ui"]}).`,
    });
  }
  const pagEdges = profile.routeGraph.edges.filter(
    (e) => e.kind === "pagination" && ranked.includes(e.from) && e.label.trim() && !isRiskyLabel(e.label),
  );
  for (const e of pagEdges.slice(0, 2)) {
    add({
      idBase: `pagination-${e.from === "/" ? "home" : e.from}`,
      title: `Pagination "${e.label}" on ${e.from}`,
      objective: `Verify the pagination link "${e.label}" on ${e.from} opens ${e.to}.`,
      role: "functional-ui",
      category: "interaction",
      source: "discovery-journey",
      priority: "low",
      routes: [e.from],
      viewports: [desktop],
      preconditions: ["Read-only pagination"],
      expectedOutcome: `The URL changes to ${e.to}.`,
      steps: [
        { action: "navigate", url: e.from },
        { action: "click", locator: { role: "link", name: e.label, exact: true } },
        {
          action: "assert_url_contains",
          value: e.to.includes("?") ? ((e.to.split("?")[1] as string).split("&")[0] as string) : e.to,
        },
      ],
      evidence: routeEvidence(profile, e.from),
      rationale: `Pagination link observed on ${e.from} (${ROLE_RATIONALE["functional-ui"]}).`,
    });
  }

  // --- ecommerce / booking browse-only: list -> detail ---------------------------------------------------
  const browseRole: AgentRole | undefined =
    isCat("ecommerce") || isCat("marketplace")
      ? "ecommerce-browse-only"
      : isCat("booking") || isCat("restaurant")
        ? "booking-browse-only"
        : undefined;
  if (browseRole) {
    const rels = profile.domainModel.relationships.filter(
      (r) => r.kind === "list-detail" && ranked.includes(r.from),
    );
    for (const rel of rels.slice(0, maxJ)) {
      const edge = profile.routeGraph.edges.find(
        (e) =>
          e.from === rel.from &&
          e.to === rel.to &&
          e.kind === "link" &&
          e.label.trim() &&
          !isRiskyLabel(e.label),
      );
      if (!edge) continue;
      const h = heading(profile, rel.to);
      add({
        idBase: `browse-${rel.from}-to-detail`,
        title: `Browse from ${rel.from} to "${edge.label}"`,
        objective: `Verify a listing on ${rel.from} opens its detail page ${rel.to}. No cart, booking or checkout action is taken.`,
        role: browseRole,
        category: browseRole === "ecommerce-browse-only" ? "commerce" : "booking",
        source: "discovery-journey",
        priority: "high",
        routes: [rel.from, rel.to],
        viewports: [desktop],
        preconditions: ["Browse-only: no add-to-cart, reservation, checkout or payment"],
        expectedOutcome: `The detail page ${rel.to}${h ? ` shows "${h}"` : ""}.`,
        steps: [
          { action: "navigate", url: rel.from },
          { action: "click", locator: { role: "link", name: edge.label, exact: true } },
          { action: "assert_url_contains", value: pathOnly(rel.to) },
          ...(h
            ? [{ action: "assert_visible", locator: { role: "heading", name: h } } as TestStepInput]
            : []),
        ],
        evidence: rel.evidence.slice(0, 2),
        rationale: `List-detail relationship observed between ${rel.from} and ${rel.to} (${ROLE_RATIONALE[browseRole]}).`,
      });
    }
  }

  // --- domain-consistency: same labelled value on multiple routes -------------------------------------
  for (const rule of profile.domainModel.domainRulesObserved.filter((r) => r.assertion).slice(0, 4)) {
    const a = rule.assertion as NonNullable<typeof rule.assertion>;
    const routes = rule.routes.filter((r) => ranked.includes(r)).slice(0, 3);
    if (routes.length < 2) continue;
    add({
      idBase: `consistency-${a.label}`,
      title: `"${a.label}" shows the same value across ${routes.length} routes`,
      objective: `Verify the value "${a.value}" for "${a.label}" is consistent on ${routes.join(", ")}.`,
      role: "domain-consistency",
      category: "domain",
      source: "discovery-domain-rule",
      priority: "medium",
      routes,
      viewports: [desktop],
      preconditions: ["Values observed during discovery; live data may legitimately change between runs"],
      expectedOutcome: `"${a.value}" is visible on every listed route.`,
      steps: routes.flatMap(
        (r) =>
          [
            { action: "navigate", url: r },
            { action: "assert_visible", locator: { text: a.value, exact: true } },
          ] as TestStepInput[],
      ),
      evidence: rule.evidence.slice(0, 3),
      rationale: `${rule.description} (${ROLE_RATIONALE["domain-consistency"]}).`,
    });
  }

  // --- accessibility ------------------------------------------------------------------------------------
  const a11yRoutes = new Set(profile.qualitySurface.accessibility.topRules.flatMap((r) => r.routes));
  const a11yOrder = [...ranked].sort((a, b) => Number(a11yRoutes.has(b)) - Number(a11yRoutes.has(a)));
  for (const r of a11yOrder.slice(0, maxQ)) {
    const flagged = a11yRoutes.has(r);
    add({
      idBase: `a11y-${r === "/" ? "home" : r}`,
      title: `Accessibility scan of ${r}`,
      objective: `Run axe-core (WCAG 2 A/AA) on ${r}; serious or critical violations fail the scenario.`,
      role: "accessibility",
      category: "accessibility",
      source: flagged ? "discovery-quality-signal" : "discovery-route",
      priority: flagged ? "high" : "medium",
      routes: [r],
      viewports: [desktop],
      preconditions: ["Nonintrusive scan; no interaction"],
      expectedOutcome: `No serious or critical axe violations on ${r}.`,
      steps: [
        { action: "navigate", url: r },
        { action: "run_accessibility_scan", tags: ["wcag2a", "wcag2aa"] },
      ],
      evidence: routeEvidence(profile, r),
      rationale: flagged
        ? `Discovery's axe scan reported violations on ${r}.`
        : `${r} is a key public route (${ROLE_RATIONALE.accessibility}).`,
    });
  }

  // --- responsive ----------------------------------------------------------------------------------------
  if (mobile) {
    const concernRoutes = new Set(profile.qualitySurface.responsive.concerns.map((c) => c.route));
    const order = [...ranked].sort((a, b) => Number(concernRoutes.has(b)) - Number(concernRoutes.has(a)));
    for (const group of chunk(order.slice(0, maxQ), 3)) {
      const flagged = group.some((g) => concernRoutes.has(g));
      add({
        idBase: `responsive-${group[0] === "/" ? "home" : group[0]}`,
        title: `Mobile layout of ${group.join(", ")}`,
        objective: `Verify ${group.join(", ")} render without horizontal overflow on the ${mobile} viewport.`,
        role: "responsive",
        category: "responsive",
        source: flagged ? "discovery-quality-signal" : "discovery-route",
        priority: flagged ? "high" : "medium",
        routes: group,
        viewports: [mobile],
        preconditions: ["Viewport change only"],
        expectedOutcome: "No horizontal overflow on any listed route.",
        steps: group.flatMap(
          (r, i) =>
            [
              { action: "navigate", url: r },
              { action: "assert_no_horizontal_overflow" },
              { action: "screenshot", name: `mobile-${i + 1}` },
            ] as TestStepInput[],
        ),
        evidence: group.flatMap((r) => routeEvidence(profile, r).slice(0, 1)),
        rationale: flagged
          ? `Discovery measured horizontal overflow on ${group.filter((g) => concernRoutes.has(g)).join(", ")}.`
          : `Key public routes on a mobile viewport (${ROLE_RATIONALE.responsive}).`,
      });
    }
  }

  // --- console-network --------------------------------------------------------------------------------
  const signalRoutes = new Set([
    ...profile.qualitySurface.console.samples.map((s) => s.route),
    ...profile.qualitySurface.network.samples.map((s) => s.route),
  ]);
  const cnOrder = [...new Set([...[...signalRoutes].filter((r) => ranked.includes(r)), ...ranked])].slice(
    0,
    maxQ,
  );
  for (const r of cnOrder) {
    const flagged = signalRoutes.has(r);
    add({
      idBase: `console-network-${r === "/" ? "home" : r}`,
      title: `Console and network health of ${r}`,
      objective: `Verify ${r} loads without console errors or failed requests.`,
      role: "console-network",
      category: "console-network",
      source: flagged ? "discovery-quality-signal" : "discovery-route",
      priority: flagged ? "high" : "low",
      routes: [r],
      viewports: [desktop],
      preconditions: ["Requests outside the allowed domains are blocked and may appear as failures"],
      expectedOutcome: `No console errors and no failed requests on ${r}.`,
      steps: [
        { action: "navigate", url: r },
        { action: "inspect_console_logs" },
        { action: "inspect_network_failures" },
        { action: "assert_no_console_errors" },
        { action: "assert_no_network_failures" },
      ],
      evidence: [
        ...profile.qualitySurface.console.samples
          .filter((s) => s.route === r)
          .slice(0, 1)
          .map((s) => ({
            evidenceId: `ev-console-${slugify(r) || "home"}`,
            kind: "console" as const,
            route: r,
            excerpt: s.text.slice(0, 300),
          })),
        ...routeEvidence(profile, r).slice(0, 1),
      ],
      rationale: flagged
        ? `Discovery observed console errors or failed requests on ${r}.`
        : `${r} is a key public route.`,
    });
  }

  // --- deferred and excluded ------------------------------------------------------------------------------
  const areaToDeferred = (
    areas: WebsiteUnderstandingProfile["riskClassification"]["needsCredentials"],
    safetyClass: DeferredScenario["safetyClass"],
    requiredData: (a: (typeof areas)[number]) => string[],
  ) => {
    for (const a of areas) {
      deferred.push({
        id: uid(`deferred-${a.areaId}`),
        title: a.label.slice(0, 200),
        objective: `Test ${a.label} once the required inputs and approvals are supplied.`,
        source: "discovery-route",
        safetyClass,
        routes: a.routes,
        requiredData: requiredData(a),
        reason: a.reason,
        evidence: a.evidence,
      });
    }
  };
  const rc = profile.riskClassification;
  areaToDeferred(rc.needsCredentials, "requires-credentials", () => [
    "test account credentials (via testData fromEnv)",
  ]);
  areaToDeferred(rc.needsTestData, "requires-test-data", () => [
    "non-personal test data for each field",
    "explicit risk approval to submit",
  ]);
  areaToDeferred(rc.needsExplicitRiskApproval, "requires-risk-approval", (a) => [
    `safety policy opt-in for ${a.category}`,
  ]);
  for (const a of rc.excludedByDefault) {
    excluded.push({
      id: uid(`excluded-${a.areaId}`),
      title: a.label.slice(0, 200),
      routes: a.routes,
      reason: a.reason,
      evidence: a.evidence,
    });
  }
  excluded.push({
    id: uid("excluded-active-security-testing"),
    title: "Active security testing (injection, fuzzing, scanning, credential attacks, bypasses)",
    routes: [],
    reason: "Never planned autonomously; requires a separate, explicitly authorized engagement.",
    evidence: [],
  });
  excluded.push({
    id: uid("excluded-visual-regression"),
    title: "Visual regression comparison",
    routes: [],
    reason: "No approved visual baseline exists; screenshots are captured as evidence only.",
    evidence: [],
  });
  excluded.push({
    id: uid("excluded-performance-load"),
    title: "Performance and load testing",
    routes: [],
    reason:
      "No performance evidence was gathered and load generation is never automated; console/network smoke checks cover basic health.",
    evidence: [],
  });
  if (profile.accessModel.authenticationObserved)
    excluded.push({
      id: uid("excluded-authenticated-areas"),
      title: "Logged-in functionality",
      routes: profile.accessModel.restrictedAreas.flatMap((a) => a.routes).slice(0, 20),
      reason:
        "No credentials were supplied; the authentication boundary is reported, logged-in testing is not fabricated.",
      evidence: profile.accessModel.authBoundaries.flatMap((b) => b.evidence).slice(0, 3),
    });

  // --- roles: only those with evidence-backed scenarios -------------------------------------------------
  const byRole = new Map<AgentRole, CandidateScenario[]>();
  for (const s of scenarios) byRole.set(s.role, [...(byRole.get(s.role) ?? []), s]);
  const roles: RecommendedAgentRole[] = [...byRole.entries()].map(([role, list]) => ({
    role,
    rationale: `${ROLE_RATIONALE[role] ?? "justified by discovery evidence"} (${list.length} scenario(s)).`,
    routes: [...new Set(list.flatMap((s) => s.routes))].slice(0, 20),
    evidence: list.flatMap((s) => s.evidence).slice(0, 3),
  }));
  return { scenarios, deferred, excluded, roles };
}

/** Maps a scenario id to the evidence and routes that justify it (written next to the plan). */
export function evidenceMap(
  scenarios: {
    id: string;
    routes?: string[];
    evidence?: EvidenceReference[];
    source?: ScenarioSource;
    safetyClass?: ScenarioSafetyClass;
  }[],
): Record<
  string,
  { routes: string[]; evidence: string[]; source?: ScenarioSource; safetyClass?: ScenarioSafetyClass }
> {
  const out: Record<
    string,
    { routes: string[]; evidence: string[]; source?: ScenarioSource; safetyClass?: ScenarioSafetyClass }
  > = {};
  for (const s of scenarios)
    out[s.id] = {
      routes: s.routes ?? [],
      evidence: (s.evidence ?? []).map((e) => e.evidenceId),
      ...(s.source ? { source: s.source } : {}),
      ...(s.safetyClass ? { safetyClass: s.safetyClass } : {}),
    };
  return out;
}
