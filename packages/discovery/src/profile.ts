import { recommendStrategy, type ProfileFacts } from "@browserswarm/autonomous-planner";
import {
  ApplicationCategorySchema,
  computeProfileHash,
  WebsiteUnderstandingProfileSchema,
  type AuthBoundary,
  type CandidateDomainRule,
  type DiscoveredEntity,
  type DiscoveredJourney,
  type DiscoveredRelationship,
  type DiscoveredRoute,
  type EvidenceReference,
  type FormInventoryItem,
  type InteractiveInventoryItem,
  type ModelRef,
  type NavigationPattern,
  type ObservedDomainRule,
  type RestrictedArea,
  type RestrictedControl,
  type SafeArea,
  type SearchFilterInventoryItem,
  type TableInventoryItem,
  type WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import { generateStructured, type LLMClient } from "@browserswarm/opencode-adapter";
import { formatZodIssues } from "@browserswarm/core";
import { newId, slugify, systemClock, truncate, type Clock } from "@browserswarm/shared";
import { RunLayout } from "@browserswarm/storage";
import { z } from "zod";
import { classifyApplication, terminology, type Classification } from "./classify.js";
import { isReadOnlyQueryForm } from "./crawler.js";
import type { ExtractedForm } from "./extract.js";
import type { DiscoveryRunResult, RestrictedCandidate, RouteObservation } from "./types.js";

export interface ProfileOptions {
  userIntent?: string;
  clock?: Clock;
  /** Optional bounded LLM refinement of the classification. Only redacted structure is sent. */
  llm?: { client: LLMClient; model: ModelRef; maxTokens: number; maxRepairAttempts: number };
}

const clip = (s: string, n = 300) => truncate(s, n);
const LOGIN_LABEL = /\b(log ?in|sign ?in)\b/i;
const SIGNUP_LABEL = /\b(sign ?up|register|create (an )?account|join)\b/i;
const ROLE_NAMES =
  /\b(admin|administrator|seller|vendor|member|members|student|students|teacher|instructor|doctor|patient|customer|partner|agent|host|guest|employer|candidate|merchant|coach|player)s?\b/gi;

function formPurpose(f: ExtractedForm, readOnly: boolean): FormInventoryItem["purpose"] {
  const text = `${f.name} ${f.submitLabel} ${f.fields.map((x) => `${x.name} ${x.label}`).join(" ")}`;
  if (readOnly) return f.fields.some((x) => x.type === "search" || x.type === "text") ? "search" : "filter";
  if (f.hasFile) return "upload";
  if (/password|reset|forgot/i.test(text) && !f.hasPassword) return "password-reset";
  if (f.hasPassword && SIGNUP_LABEL.test(text)) return "signup";
  if (f.hasPassword) return "login";
  if (SIGNUP_LABEL.test(text)) return "signup";
  if (/card|payment|billing|checkout|cvv|expir/i.test(text)) return "checkout";
  if (/newsletter|subscribe/i.test(text)) return "newsletter";
  if (/message|contact|enquiry|inquiry|feedback|comment/i.test(text)) return "contact";
  return "generic";
}

function areaKey(route: string): string {
  const seg = route.split("?")[0]?.split("/").filter(Boolean)[0];
  return seg ? `/${seg}` : "/";
}

/**
 * Assembles the Website Understanding Profile from discovery observations. Facts (routes, controls, tables,
 * quality signals) are copied from observations; inferences (category, purpose, journeys, entities, roles)
 * carry confidence and evidence and are listed as assumptions. Nothing is invented: an unclassifiable site
 * stays "unknown".
 */
export async function buildWebsiteUnderstandingProfile(
  result: DiscoveryRunResult,
  options: ProfileOptions = {},
): Promise<WebsiteUnderstandingProfile> {
  const clock = options.clock ?? systemClock;
  const req = result.packet.request;
  const obs = result.observations;
  const visited = obs.filter((o) => o.status === "visited");
  const byPath = new Map(obs.map((o) => [o.path, o]));
  const evidenceIdFor = (route: string) =>
    byPath.get(route)?.evidenceId ?? `ev-route-${slugify(route) || "root"}`;
  const ev = (
    o: RouteObservation,
    excerpt: string,
    kind: EvidenceReference["kind"] = "route-observation",
    artifactPath?: string,
    suffix = "",
  ): EvidenceReference => ({
    evidenceId: `${o.evidenceId}${suffix}`,
    kind,
    route: o.path,
    ...(artifactPath ? { artifactPath } : {}),
    excerpt: clip(excerpt),
  });
  const routeEv = (route: string, excerpt?: string): EvidenceReference[] => {
    const o = byPath.get(route);
    if (!o) return [];
    return [
      ev(
        o,
        excerpt ?? `${o.extract?.title || route} (HTTP ${o.httpStatus ?? "?"})`,
        "route-observation",
        o.screenshot,
      ),
    ];
  };
  const assumptions: string[] = [];
  const limitations = [...result.limitations];

  // ---- routes --------------------------------------------------------------------------------------
  const routes: DiscoveredRoute[] = result.discovered.map((d, i) => {
    const o = byPath.get(d.path);
    const e = o?.extract;
    const status: DiscoveredRoute["status"] = o
      ? o.status === "visited"
        ? "visited"
        : o.status === "blocked"
          ? "blocked"
          : "error"
      : d.visited
        ? "visited"
        : "discovered";
    return {
      routeId: `route-${String(i + 1).padStart(3, "0")}`,
      path: d.path,
      url: d.url,
      title: clip(e?.title ?? d.label ?? "", 300),
      depth: d.depth,
      status,
      ...(o?.httpStatus !== undefined ? { httpStatus: o.httpStatus } : {}),
      headings: (e?.headings ?? []).slice(0, 10).map((h) => clip(h.text, 200)),
      landmarks: (e?.landmarks ?? []).slice(0, 12),
      counts: {
        links: e?.links.length ?? 0,
        buttons: e?.controls.filter((c) => c.tag === "button" || c.role === "button").length ?? 0,
        forms: e?.forms.length ?? 0,
        tables: e?.tables.length ?? 0,
        interactive: (e?.links.length ?? 0) + (e?.controls.length ?? 0),
      },
      requiresAuth: o?.requiresAuth ?? false,
      ...(o?.screenshot ? { screenshot: o.screenshot } : {}),
      evidence: o
        ? [
            ev(
              o,
              `${e?.title || d.path}; ${e?.headings.length ?? 0} heading(s), ${e?.links.length ?? 0} link(s)`,
              "route-observation",
              o.screenshot,
            ),
          ]
        : [],
    };
  });
  const knownPaths = new Set(routes.map((r) => r.path));
  const entry = routes[0]?.path ?? "/";

  // ---- access model -------------------------------------------------------------------------------
  const authBoundaries: AuthBoundary[] = [];
  for (const o of obs) {
    if (o.authSignal)
      authBoundaries.push({
        route: o.path,
        kind: o.authSignal,
        evidence: [ev(o, `auth signal: ${o.authSignal}`, "route-observation", undefined, "-auth")],
      });
  }
  for (const d of result.discovered.filter((x) => x.authPage && LOGIN_LABEL.test(x.label))) {
    const from = d.from ? byPath.get(d.from) : undefined;
    if (from && !authBoundaries.some((b) => b.route === d.path && b.kind === "login-link"))
      authBoundaries.push({
        route: d.path,
        kind: "login-link",
        evidence: [
          ev(
            from,
            `link "${d.label}" to ${d.path}`,
            "dom-extract",
            undefined,
            `-login-${authBoundaries.length}`,
          ),
        ],
      });
  }
  const authRoutes = new Set(obs.filter((o) => o.requiresAuth).map((o) => o.path));
  const publicRoutes = visited.filter((o) => !o.requiresAuth).map((o) => o.path);
  const restrictedAreas: RestrictedArea[] = [...authRoutes]
    .map((r, i) => ({
      areaId: `auth-${i + 1}`,
      label: `Authenticated area ${r}`,
      routes: [r],
      category: "authentication",
      reason: "requires sign-in (redirect to login or 401/403 observed)",
      evidence: routeEv(r, "redirected to login or returned 401/403"),
    }))
    .filter((a) => a.evidence.length);
  const roleHits = new Map<string, RouteObservation>();
  for (const o of visited)
    for (const l of o.extract?.links.filter((x) => x.region === "nav" || x.region === "header") ?? [])
      for (const m of l.text.matchAll(ROLE_NAMES))
        if (!roleHits.has(m[1]!.toLowerCase())) roleHits.set(m[1]!.toLowerCase(), o);
  const observedRoles = [...roleHits.entries()].slice(0, 8).map(([name, o]) => ({
    name,
    confidence: 0.4,
    evidence: [
      ev(o, `navigation label mentions "${name}"`, "dom-extract", undefined, `-role-${slugify(name)}`),
    ],
  }));
  if (observedRoles.length)
    assumptions.push(
      `User roles inferred from navigation labels only: ${observedRoles.map((r) => r.name).join(", ")} (low confidence).`,
    );

  // ---- classification --------------------------------------------------------------------------------
  let classification: Classification = classifyApplication(visited, evidenceIdFor);
  let llmCalls = 0;
  if (options.llm && visited.length) {
    const refined = await refineWithLlm(options.llm, visited, classification).catch((e: Error) => {
      limitations.push(`LLM classification refinement skipped: ${clip(e.message, 200)}`);
      return undefined;
    });
    llmCalls = refined?.calls ?? (options.llm ? 1 : 0);
    if (refined?.classification) classification = refined.classification;
  }
  if (classification.primaryCategory === "unknown")
    assumptions.push(
      "Application category could not be determined from observed evidence; it is reported as unknown.",
    );
  else
    assumptions.push(
      `Category "${classification.primaryCategory}" is a heuristic inference (confidence ${classification.confidence}).`,
    );

  const entryObs = byPath.get(entry);
  const entryHeadings = (entryObs?.extract?.headings ?? []).map((h) => h.text);
  const purposeText = entryObs?.extract?.metaDescription || entryHeadings[0] || "";
  const businessPurpose = {
    inferredPurpose: purposeText
      ? clip(
          `Based on the entry page${entryObs?.extract?.metaDescription ? " description" : " heading"}: "${purposeText}"`,
          1000,
        )
      : "Not determinable from observed evidence.",
    primaryUserGoals: [] as string[],
    observedValuePropositions: entryHeadings.slice(1, 4).map((h) => clip(h)),
    confidence: entryObs?.extract?.metaDescription ? 0.5 : purposeText ? 0.3 : 0,
    evidence: entryObs
      ? [ev(entryObs, purposeText || entryObs.path, "dom-extract", undefined, "-purpose")]
      : [],
  };

  // ---- edges, navigation patterns ---------------------------------------------------------------------
  const navigationPatterns: NavigationPattern[] = [];
  const seenNav = new Set<string>();
  for (const o of visited) {
    const groups = new Map<
      string,
      { kind: NavigationPattern["kind"]; label: string; routes: Set<string>; n: number }
    >();
    for (const l of o.extract?.links ?? []) {
      const kind: NavigationPattern["kind"] =
        l.region === "nav" || l.region === "header"
          ? "primary-nav"
          : l.region === "footer"
            ? "footer"
            : l.region === "breadcrumb"
              ? "breadcrumb"
              : l.region === "aside"
                ? "sidebar"
                : "inline-links";
      if (kind === "inline-links") continue;
      const key = `${kind}|${l.regionLabel}`;
      const g = groups.get(key) ?? { kind, label: l.regionLabel || kind, routes: new Set<string>(), n: 0 };
      g.n++;
      const to = result.edges.find((e) => e.from === o.path && e.label === l.text)?.to;
      if (to && knownPaths.has(to)) g.routes.add(to);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      if (seenNav.has(key)) continue;
      seenNav.add(key);
      navigationPatterns.push({
        kind: g.kind,
        label: clip(g.label, 200),
        linkCount: g.n,
        routes: [...g.routes].slice(0, 30),
      });
    }
  }

  // ---- UI inventory ---------------------------------------------------------------------------------
  const forms: FormInventoryItem[] = [];
  const searchAndFilters: SearchFilterInventoryItem[] = [];
  const tables: TableInventoryItem[] = [];
  const tabsAndAccordions: InteractiveInventoryItem[] = [];
  const modals: InteractiveInventoryItem[] = [];
  const pagination: InteractiveInventoryItem[] = [];
  const otherInteractive: InteractiveInventoryItem[] = [];
  const formSigs = new Set<string>();
  const scope = { allowedDomains: req.allowedDomains, allowSubdomains: req.allowSubdomains };
  for (const o of visited) {
    const e = o.extract;
    if (!e) continue;
    e.forms.forEach((f) => {
      const sig = `${f.method}|${f.action}|${f.fields.map((x) => x.name).join(",")}`;
      if (formSigs.has(sig) || forms.length >= req.discoveryPolicy.maxUniqueFormsInventoried) return;
      formSigs.add(sig);
      const readOnly = isReadOnlyQueryForm(f, req.targetUrl, scope);
      const purpose = formPurpose(f, readOnly);
      const fe = ev(
        o,
        `${f.method.toUpperCase()} form "${f.name || f.submitLabel || "unnamed"}" with ${f.fields.length} field(s)`,
        "dom-extract",
        undefined,
        `-form-${f.index + 1}`,
      );
      forms.push({
        formId: `form-${forms.length + 1}`,
        route: o.path,
        name: clip(f.name, 200),
        method: f.method === "get" || f.method === "post" || f.method === "dialog" ? f.method : "unknown",
        action: clip(f.action, 500),
        fields: f.fields.map((x) => ({
          name: clip(x.name, 100),
          type: clip(x.type, 40),
          label: clip(x.label, 200),
          required: x.required,
        })),
        submitLabel: clip(f.submitLabel, 200),
        purpose,
        persistsData: !readOnly,
        restricted: !readOnly,
        evidence: [fe],
      });
      if (readOnly) {
        const ex = o.searchExercises.find((s) => s.formIndex === f.index);
        const text = f.fields.find((x) => x.type === "search" || x.type === "text");
        searchAndFilters.push({
          id: `sf-${searchAndFilters.length + 1}`,
          route: o.path,
          kind: purpose === "search" ? "search" : "filter",
          label: clip(f.name || f.submitLabel || text?.label || "search", 200),
          method: "get",
          action: clip(f.action, 500),
          ...(ex ? { paramName: ex.paramName } : text?.name ? { paramName: text.name } : {}),
          ...(text?.label ? { locator: { label: text.label } } : {}),
          ...(ex ? { exercisedUrl: ex.path } : {}),
          resultsObserved: ex?.resultsObserved ?? false,
          evidence: [fe],
        });
      }
    });
    e.tables.forEach((t, i) => {
      if (tables.length >= 50) return;
      tables.push({
        tableId: `table-${tables.length + 1}`,
        route: o.path,
        caption: clip(t.caption, 200),
        headers: t.headers.map((h) => clip(h, 100)),
        rowCount: t.rowCount,
        evidence: [
          ev(
            o,
            `table "${t.caption || "untitled"}" headers: ${t.headers.join(", ")}; ${t.rowCount} row(s)`,
            "dom-extract",
            undefined,
            `-table-${i + 1}`,
          ),
        ],
      });
    });
    const exercised = new Set(
      o.interactions.filter((x) => x.outcome !== "error").map((x) => `${x.kind}|${x.label}`),
    );
    for (const c of e.controls) {
      if (c.inCookieBanner || !c.visible) continue;
      const label = clip(c.label || c.testId || c.tag, 200);
      const base = {
        route: o.path,
        label,
        evidence: [ev(o, `${c.role ?? c.tag} "${label}"`, "dom-extract", undefined, `-ctl-${c.idx}`)],
      };
      if (c.role === "tab") {
        tabsAndAccordions.push({
          id: `ui-${tabsAndAccordions.length + 1}`,
          kind: "tab",
          ...base,
          ...(c.label ? { locator: { role: "tab", name: c.label } } : {}),
          exercised: exercised.has(`tab|${label}`),
        });
      } else if (c.tag === "summary") {
        tabsAndAccordions.push({
          id: `ui-${tabsAndAccordions.length + 1}`,
          kind: "details",
          ...base,
          ...(c.label ? { locator: { text: c.label } } : {}),
          exercised: exercised.has(`details|${label}`),
        });
      } else if (c.ariaHasPopup === "dialog") {
        modals.push({ id: `modal-${modals.length + 1}`, kind: "modal", ...base, exercised: false });
      } else if (c.ariaExpanded === "true" || c.ariaExpanded === "false") {
        const kind = c.ariaHasPopup && c.ariaHasPopup !== "false" ? "menu" : "accordion";
        tabsAndAccordions.push({
          id: `ui-${tabsAndAccordions.length + 1}`,
          kind,
          ...base,
          ...(c.label ? { locator: { role: "button", name: c.label } } : {}),
          exercised: exercised.has(`${kind}|${label}`),
        });
      } else if (c.inPagination) {
        pagination.push({
          id: `pag-${pagination.length + 1}`,
          kind: "pagination",
          ...base,
          exercised: exercised.has(`pagination|${label}`),
        });
      }
    }
    for (const l of e.links.filter((x) => x.region === "pagination").slice(0, 10))
      pagination.push({
        id: `pag-${pagination.length + 1}`,
        kind: "pagination",
        route: o.path,
        label: clip(l.text, 200),
        locator: { role: "link", name: l.text || "page" },
        exercised: false,
        evidence: [ev(o, `pagination link "${l.text}"`, "dom-extract", undefined, `-pag-${l.idx}`)],
      });
    for (const s of e.controls.filter((c) => c.tag === "select").slice(0, 5))
      otherInteractive.push({
        id: `other-${otherInteractive.length + 1}`,
        kind: "select",
        route: o.path,
        label: clip(s.label, 200),
        exercised: false,
        evidence: [ev(o, `select "${s.label}"`, "dom-extract", undefined, `-sel-${s.idx}`)],
      });
  }

  const restrictedControl = (c: RestrictedCandidate, i: number): RestrictedControl | undefined => {
    const o = byPath.get(c.route);
    if (!o) return undefined;
    return {
      id: `rc-${i + 1}`,
      route: c.route,
      kind: c.kind,
      label: clip(c.label, 200),
      category: c.category,
      reason: clip(c.reason, 500),
      ...(c.locator ? { locator: c.locator } : {}),
      evidence: [
        ev(
          o,
          `${c.kind} "${c.label}" (${c.category}) recorded, not used`,
          "dom-extract",
          undefined,
          `-rc-${i + 1}`,
        ),
      ],
    };
  };
  const allRestricted = result.restricted.map(restrictedControl).filter((x): x is RestrictedControl => !!x);
  const uploads = allRestricted.filter((c) => c.category === "file_upload");
  const downloads = allRestricted.filter((c) => c.category === "file_download");
  const sideEffecting = allRestricted.filter(
    (c) => c.category !== "file_upload" && c.category !== "file_download",
  );

  // ---- quality surface ------------------------------------------------------------------------------
  const ruleAgg = new Map<string, { impact: string; help: string; count: number; routes: Set<string> }>();
  const byImpact: Record<string, number> = {};
  let violationCount = 0;
  for (const o of visited)
    for (const v of o.axe?.violations ?? []) {
      violationCount++;
      byImpact[v.impact] = (byImpact[v.impact] ?? 0) + 1;
      const a = ruleAgg.get(v.id) ?? { impact: v.impact, help: v.help, count: 0, routes: new Set<string>() };
      a.count += v.nodeCount;
      a.routes.add(o.path);
      ruleAgg.set(v.id, a);
    }
  const concerns = visited.flatMap((o) =>
    o.overflow
      .filter((m) => m.scrollWidth > m.clientWidth + 1)
      .map((m) => ({
        route: o.path,
        viewport: m.viewport,
        issue: `horizontal overflow: scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}`,
      })),
  );
  const consoleErrors = visited.flatMap((o) =>
    o.console
      .filter((c) => c.type === "error" || c.type === "pageerror")
      .map((c) => ({ route: o.path, text: clip(c.text) })),
  );
  const consoleWarnings = visited.reduce(
    (n, o) => n + o.console.filter((c) => c.type === "warning").length,
    0,
  );
  const failures = visited.flatMap((o) =>
    o.network
      .filter((n) => !/blockedbyclient/i.test(n.failure ?? ""))
      .map((n) => ({
        route: o.path,
        url: clip(n.url, 500),
        ...(n.status !== undefined ? { status: n.status } : {}),
        ...(n.failure ? { failure: clip(n.failure, 200) } : {}),
      })),
  );
  const brokenMedia = visited.flatMap((o) =>
    (o.extract?.media ?? [])
      .filter((m) => m.broken)
      .slice(0, 10)
      .map((m, i) => ({
        route: o.path,
        src: clip(m.src, 500),
        evidence: [ev(o, `broken image ${m.src}`, "dom-extract", undefined, `-media-${i + 1}`)],
      })),
  );
  const visibleErrorStates = visited.flatMap((o) =>
    (o.extract?.errorTexts ?? []).slice(0, 3).map((t, i) => ({
      route: o.path,
      text: clip(t),
      evidence: [ev(o, t, "dom-extract", undefined, `-err-${i + 1}`)],
    })),
  );

  // ---- domain model -----------------------------------------------------------------------------------
  const entities: DiscoveredEntity[] = [];
  for (const t of tables.slice(0, 10)) {
    const o = byPath.get(t.route);
    const name = clip(t.caption || o?.extract?.headings[0]?.text || `Records on ${t.route}`, 100);
    if (entities.some((e) => e.name === name)) continue;
    entities.push({
      name,
      sourceKind: "table-header",
      attributes: t.headers.slice(0, 15),
      routes: [t.route],
      confidence: 0.6,
      evidence: t.evidence,
    });
  }
  for (const o of visited) {
    const cards = o.extract?.cards ?? [];
    if (cards.length < 3 || entities.length >= 20) continue;
    const name = clip(o.extract?.headings[0]?.text || `Items on ${o.path}`, 100);
    if (entities.some((e) => e.name === name)) continue;
    const attrs = [...new Set(cards.flatMap((c) => c.fields))].slice(0, 10);
    entities.push({
      name,
      sourceKind: "card",
      attributes: attrs,
      routes: [o.path],
      confidence: 0.4,
      evidence: [
        ev(o, `${cards.length} repeated item(s) (cards/articles)`, "dom-extract", undefined, "-cards"),
      ],
    });
  }
  if (entities.length)
    assumptions.push(
      "Entities are named from table captions/page headings; names are observations, not a verified data model.",
    );

  const relationships: DiscoveredRelationship[] = [];
  for (const o of visited) {
    const base = o.path.split("?")[0] as string;
    const children = result.edges.filter(
      (e) =>
        e.from === o.path &&
        e.kind === "link" &&
        e.to.split("?")[0]!.startsWith(`${base === "/" ? "" : base}/`) &&
        e.to !== o.path,
    );
    if (children.length >= 2 && base !== "/") {
      for (const c of children.slice(0, 3)) {
        if (!knownPaths.has(c.to)) continue;
        relationships.push({
          from: o.path,
          to: c.to,
          kind: "list-detail",
          evidence: [
            ev(
              o,
              `${children.length} links from ${o.path} to child routes such as ${c.to}`,
              "navigation-graph",
              undefined,
              `-rel-${relationships.length + 1}`,
            ),
          ],
        });
      }
    }
  }

  const domainRulesObserved: ObservedDomainRule[] = [];
  const domainRulesNeedingVerification: CandidateDomainRule[] = [];
  const valueSightings = new Map<string, { value: string; route: string; o: RouteObservation }[]>();
  for (const o of visited)
    for (const n of o.extract?.numbers ?? []) {
      if (!n.label || !n.value) continue;
      const k = n.label.toLowerCase();
      valueSightings.set(k, [...(valueSightings.get(k) ?? []), { value: n.value, route: o.path, o }]);
    }
  for (const [label, sightings] of valueSightings) {
    const routesSeen = [...new Set(sightings.map((s) => s.route))];
    if (routesSeen.length < 2) continue;
    const values = new Set(sightings.map((s) => s.value));
    const evs = sightings
      .slice(0, 3)
      .map((s, i) =>
        ev(
          s.o,
          `"${label}" = "${s.value}" on ${s.route}`,
          "dom-extract",
          undefined,
          `-val-${slugify(label)}-${i}`,
        ),
      );
    if (values.size === 1) {
      domainRulesObserved.push({
        ruleId: `rule-${domainRulesObserved.length + 1}`,
        description: clip(
          `"${sightings[0]!.value}" is shown for "${label}" on ${routesSeen.length} routes`,
          500,
        ),
        routes: routesSeen.slice(0, 5),
        assertion: {
          kind: "same-value-on-routes",
          label: clip(label, 100),
          value: clip(sightings[0]!.value, 100),
        },
        evidence: evs,
      });
    } else {
      domainRulesNeedingVerification.push({
        ruleId: `candidate-${domainRulesNeedingVerification.length + 1}`,
        description: clip(
          `"${label}" shows different values across routes (${[...values].slice(0, 3).join(" / ")})`,
          500,
        ),
        routes: routesSeen.slice(0, 5),
        confidence: 0.3,
        verificationNeeded:
          "Confirm whether these values should match (different entities vs. inconsistency).",
        evidence: evs,
      });
    }
  }

  // ---- journeys --------------------------------------------------------------------------------------
  const journeys: DiscoveredJourney[] = [];
  const navTargets = result.edges.filter(
    (e) => e.from === entry && e.kind === "link" && knownPaths.has(e.to) && !authRoutes.has(e.to),
  );
  if (navTargets.length && entryObs)
    journeys.push({
      journeyId: "journey-primary-navigation",
      name: "Primary navigation from the entry page",
      kind: "navigation",
      routes: [entry, ...new Set(navTargets.map((e) => e.to))].slice(0, 15),
      steps: navTargets.slice(0, 10).map((e) => clip(`Follow "${e.label}" to ${e.to}`)),
      readOnly: true,
      confidence: 0.8,
      evidence: [
        ev(
          entryObs,
          `${navTargets.length} internal link(s) from the entry page`,
          "navigation-graph",
          undefined,
          "-nav",
        ),
      ],
    });
  for (const rel of relationships.slice(0, 5))
    journeys.push({
      journeyId: `journey-list-detail-${journeys.length + 1}`,
      name: `Browse ${rel.from} to a detail page`,
      kind: "list-detail",
      routes: [rel.from, rel.to],
      steps: [`Open ${rel.from}`, `Open ${rel.to}`],
      readOnly: true,
      confidence: 0.6,
      evidence: rel.evidence,
    });
  for (const sf of searchAndFilters.filter((s) => s.exercisedUrl))
    journeys.push({
      journeyId: `journey-${sf.kind}-${journeys.length + 1}`,
      name: `${sf.kind === "search" ? "Search" : "Filter"} on ${sf.route}`,
      kind: "search",
      routes: [sf.route],
      steps: [`Open ${sf.route}`, `Request ${sf.exercisedUrl} (read-only GET)`],
      readOnly: true,
      confidence: sf.resultsObserved ? 0.7 : 0.4,
      evidence: sf.evidence,
    });
  const pagEdges = result.edges.filter((e) => e.kind === "pagination" && knownPaths.has(e.from));
  if (pagEdges.length) {
    const first = byPath.get(pagEdges[0]!.from);
    if (first)
      journeys.push({
        journeyId: "journey-pagination",
        name: `Paginate ${pagEdges[0]!.from}`,
        kind: "pagination",
        routes: [pagEdges[0]!.from],
        steps: pagEdges.slice(0, 3).map((e) => clip(`Follow "${e.label}" to ${e.to}`)),
        readOnly: true,
        confidence: 0.7,
        evidence: [
          ev(first, `${pagEdges.length} pagination link(s)`, "navigation-graph", undefined, "-pagination"),
        ],
      });
  }
  if (journeys.length) businessPurpose.primaryUserGoals = journeys.slice(0, 5).map((j) => j.name);

  // ---- risk classification --------------------------------------------------------------------------------
  const safeAreas = new Map<string, string[]>();
  for (const r of publicRoutes) safeAreas.set(areaKey(r), [...(safeAreas.get(areaKey(r)) ?? []), r]);
  const safeReadOnlyAreas: SafeArea[] = [...safeAreas.entries()]
    .map(([area, rs], i) => ({
      areaId: `safe-${i + 1}`,
      label: area === "/" ? "Site root pages" : `Pages under ${area}`,
      routes: rs.slice(0, 30),
      reason: "public pages loaded with GET only; read-only inspection and safe navigation observed",
      evidence: routeEv(rs[0] as string),
    }))
    .filter((a) => a.evidence.length);
  const needsCredentials: RestrictedArea[] = [
    ...restrictedAreas,
    ...forms
      .filter((f) => f.purpose === "login")
      .map((f, i) => ({
        areaId: `login-${i + 1}`,
        label: `Sign-in form on ${f.route}`,
        routes: [f.route],
        category: "authentication",
        reason: "login requires credentials; never attempted during discovery",
        evidence: f.evidence,
      })),
  ];
  const needsTestData: RestrictedArea[] = forms
    .filter((f) => ["contact", "generic", "signup", "newsletter", "password-reset"].includes(f.purpose))
    .map((f, i) => ({
      areaId: `form-${i + 1}`,
      label: `${f.purpose} form on ${f.route}`,
      routes: [f.route],
      category:
        f.purpose === "signup"
          ? "account_creation"
          : f.purpose === "newsletter"
            ? "subscription"
            : "form_submission",
      reason: `${f.method.toUpperCase()} form "${f.submitLabel || f.name || "unnamed"}" may persist or send data; needs non-personal test data and explicit risk approval`,
      evidence: f.evidence,
    }));
  const riskCats = new Map<string, RestrictedControl[]>();
  for (const c of sideEffecting) {
    if (c.kind === "form") continue; // forms are covered above
    riskCats.set(c.category, [...(riskCats.get(c.category) ?? []), c]);
  }
  const needsExplicitRiskApproval: RestrictedArea[] = [];
  const excludedByDefault: RestrictedArea[] = [];
  let ai = 0;
  for (const [cat, controls] of riskCats) {
    const area: RestrictedArea = {
      areaId: `risk-${++ai}`,
      label: `${cat.replace(/_/g, " ")} controls (${controls.length})`,
      routes: [...new Set(controls.map((c) => c.route))].slice(0, 20),
      category: cat,
      reason: `e.g. ${[...new Set(controls.map((c) => `"${c.label}"`))]
        .slice(0, 3)
        .join(", ")}; recorded during discovery, never clicked`,
      evidence: controls.slice(0, 3).flatMap((c) => c.evidence),
    };
    if (["authentication", "unknown-effect", "non-navigational-link", "side-effect-url"].includes(cat))
      excludedByDefault.push(area);
    else needsExplicitRiskApproval.push(area);
  }
  for (const [label, list, cat] of [
    ["File uploads", uploads, "file_upload"],
    ["File downloads", downloads, "file_download"],
  ] as const)
    if (list.length)
      excludedByDefault.push({
        areaId: `risk-${++ai}`,
        label: `${label} (${list.length})`,
        routes: [...new Set(list.map((c) => c.route))].slice(0, 20),
        category: cat,
        reason: `${label.toLowerCase()} are blocked by default`,
        evidence: list.slice(0, 3).flatMap((c) => c.evidence),
      });
  if (result.externalLinks.length) {
    const from = byPath.get(result.externalLinks[0]!.fromRoute);
    if (from)
      excludedByDefault.push({
        areaId: `risk-${++ai}`,
        label: `External sites (${[...new Set(result.externalLinks.map((l) => l.host))].slice(0, 5).join(", ")})`,
        routes: [...new Set(result.externalLinks.map((l) => l.fromRoute))].slice(0, 20),
        category: "external_navigation",
        reason: "outside the allowed domains; links recorded, never opened",
        evidence: [
          ev(
            from,
            `${result.externalLinks.length} external link(s) recorded`,
            "dom-extract",
            undefined,
            "-external",
          ),
        ],
      });
  }

  if (authBoundaries.length)
    limitations.push(
      "Authenticated areas were not explored: no credentials are used in autonomous discovery.",
    );
  limitations.push(
    "Only read-only behavior was observed; server-side effects of restricted controls are unknown by design.",
  );
  if (req.discoveryPolicy.runAccessibilityScan)
    limitations.push(
      "Accessibility results come from automated axe-core rules only; manual review is still needed.",
    );

  const facts: ProfileFacts = {
    version: 1,
    profileId: newId("profile"),
    runId: result.packet.runId,
    targetUrl: req.targetUrl,
    allowedDomains: req.allowedDomains,
    generatedAt: clock.iso(),
    discoveryStatus: result.status,
    applicationClassification: classification,
    businessPurpose,
    accessModel: {
      publicRoutes,
      authenticationObserved: authBoundaries.length > 0,
      observedRoles,
      restrictedAreas,
      authBoundaries,
    },
    routeGraph: {
      routes,
      edges: result.edges.filter((e) => knownPaths.has(e.from)),
      entryRoutes: [entry],
      unreachableOrBlockedRoutes: result.blockedRoutes,
      externalLinks: result.externalLinks,
    },
    domainModel: {
      entities,
      relationships,
      terminology: terminology(visited),
      domainRulesObserved,
      domainRulesNeedingVerification,
    },
    userJourneys: journeys,
    uiInventory: {
      navigationPatterns,
      forms,
      tables,
      searchAndFilters,
      tabsAndAccordions,
      modals,
      pagination,
      uploads,
      downloads,
      sideEffectingControls: sideEffecting,
      otherInteractiveControls: otherInteractive,
    },
    qualitySurface: {
      accessibility: {
        routesScanned: visited.filter((o) => o.axe).length,
        violationCount,
        byImpact,
        topRules: [...ruleAgg.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 15)
          .map(([id, a]) => ({
            id,
            impact: a.impact,
            help: clip(a.help),
            count: a.count,
            routes: [...a.routes].slice(0, 10),
          })),
      },
      responsive: {
        viewportsChecked: Object.keys(req.discoveryPolicy.viewports),
        routesChecked: visited.filter((o) => o.overflow.length).length,
        concerns: concerns.slice(0, 50),
        mobileRelevant: Object.keys(req.discoveryPolicy.viewports).some((v) => /mobile|phone/i.test(v)),
      },
      console: {
        errorCount: consoleErrors.length,
        warningCount: consoleWarnings,
        samples: consoleErrors.slice(0, 20),
      },
      network: {
        failedRequestCount: failures.filter((f) => f.failure).length,
        httpErrorCount: failures.filter((f) => f.status !== undefined).length,
        blockedExternalCount: result.blockedRequests.filter((b) => b.kind === "external").length,
        blockedNonReadCount: result.blockedRequests.filter((b) => b.kind === "non-read-method").length,
        samples: failures.slice(0, 20),
      },
      visibleErrorStates: visibleErrorStates.slice(0, 20),
      brokenMedia: brokenMedia.slice(0, 20),
    },
    riskClassification: {
      safeReadOnlyAreas,
      needsCredentials,
      needsTestData,
      needsExplicitRiskApproval,
      excludedByDefault,
    },
    discoveryLimits: req.discoveryPolicy,
    discoveryStats: { ...result.stats, llmCalls: result.stats.llmCalls + llmCalls },
    limitations: [...new Set(limitations)].slice(0, 50).map((l) => clip(l, 500)),
    assumptions: assumptions.map((a) => clip(a, 500)),
    evidenceManifest: { path: RunLayout.discovery.lead.manifest, entryCount: result.artifacts.length },
  };
  const withStrategy = { ...facts, recommendedTestStrategy: recommendStrategy(facts) };
  const profile = {
    ...withStrategy,
    profileHash: computeProfileHash(withStrategy as WebsiteUnderstandingProfile),
  };
  const parsed = WebsiteUnderstandingProfileSchema.safeParse(profile);
  if (!parsed.success)
    throw new Error(`profile failed validation: ${formatZodIssues(parsed.error).slice(0, 5).join("; ")}`);
  return parsed.data;
}

// ---- optional bounded LLM refinement ---------------------------------------------------------------

const LlmClassificationSchema = z
  .object({
    primaryCategory: ApplicationCategorySchema,
    secondaryCategories: z.array(z.string().max(60)).max(3),
    confidence: z.number().min(0).max(1),
    summary: z.string().max(600),
    evidenceIds: z.array(z.string()).min(1),
  })
  .strict();

async function refineWithLlm(
  llm: NonNullable<ProfileOptions["llm"]>,
  visited: RouteObservation[],
  heuristic: Classification,
): Promise<{ classification?: Classification; calls: number }> {
  // Only redacted structure: route, title, top headings and nav labels. Never page text, values or cookies.
  const summary = visited.slice(0, 25).map((o) => ({
    evidenceId: o.evidenceId,
    route: o.path,
    title: clip(o.extract?.title ?? "", 100),
    headings: (o.extract?.headings ?? []).slice(0, 4).map((h) => clip(h.text, 80)),
    nav: (o.extract?.links ?? [])
      .filter((l) => l.region === "nav")
      .slice(0, 8)
      .map((l) => clip(l.text, 40)),
  }));
  const prompt = [
    "Classify the website from the observed structure below. Use only this evidence; do not guess.",
    `Categories: ${ApplicationCategorySchema.options.join(", ")}. Use "unknown" if the evidence is insufficient.`,
    `Heuristic result: ${heuristic.primaryCategory} (${heuristic.confidence}).`,
    'Respond with JSON: {"primaryCategory", "secondaryCategories", "confidence", "summary", "evidenceIds"} where evidenceIds are ids from the list.',
    JSON.stringify(summary),
  ].join("\n");
  const res = await generateStructured(
    llm.client,
    { prompt, maxTokens: llm.maxTokens, model: llm.model, metadata: { purpose: "discovery_classification" } },
    LlmClassificationSchema,
    llm.maxRepairAttempts,
  );
  const known = new Map(visited.map((o) => [o.evidenceId, o]));
  const cited = res.value.evidenceIds.filter((id) => known.has(id));
  // Claims without resolvable evidence are discarded; the heuristic result stands.
  if (!cited.length) return { calls: res.attempts };
  return {
    calls: res.attempts,
    classification: {
      primaryCategory: res.value.primaryCategory,
      secondaryCategories: res.value.secondaryCategories,
      confidence: Math.min(res.value.confidence, 0.9),
      summary: clip(
        `${res.value.summary} (model-assisted classification over redacted structure; probabilistic)`,
        1000,
      ),
      evidence: [
        ...heuristic.evidence,
        ...cited.slice(0, 5).map((id) => {
          const o = known.get(id) as RouteObservation;
          return {
            evidenceId: `${id}-llm`,
            kind: "llm-classification" as const,
            route: o.path,
            excerpt: clip(
              `cited by the model for ${res.value.primaryCategory}: ${o.extract?.title ?? o.path}`,
            ),
          };
        }),
      ],
    },
  };
}
