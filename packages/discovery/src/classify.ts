import type { ApplicationCategory, EvidenceReference } from "@browserswarm/core";
import type { RouteObservation } from "./types.js";

/**
 * Deterministic category vocabulary. Terms are matched as whole words in observed titles, headings,
 * navigation labels, table headers, meta descriptions and visible text; structural signals add weight.
 */
export const CATEGORY_TERMS: Record<Exclude<ApplicationCategory, "unknown">, string[]> = {
  ecommerce: [
    "shop",
    "store",
    "product",
    "products",
    "cart",
    "add to cart",
    "price",
    "checkout",
    "catalog",
    "sku",
    "sale",
    "collection",
    "shipping",
    "in stock",
  ],
  saas: [
    "pricing",
    "plans",
    "features",
    "free trial",
    "start free",
    "integrations",
    "workspace",
    "per month",
    "per user",
    "sign up",
    "enterprise",
  ],
  dashboard: ["dashboard", "analytics", "reports", "metrics", "overview", "kpi", "widgets", "insights"],
  content: [
    "blog",
    "article",
    "articles",
    "news",
    "posts",
    "stories",
    "read more",
    "author",
    "published",
    "editorial",
    "magazine",
  ],
  social: ["followers", "following", "feed", "friends", "likes", "community", "profile", "timeline"],
  marketplace: ["marketplace", "sellers", "vendors", "listings", "buyers", "sell"],
  booking: [
    "booking",
    "book now",
    "reservation",
    "reservations",
    "availability",
    "check-in",
    "check-out",
    "appointments",
    "appointment",
    "rooms",
  ],
  finance: [
    "banking",
    "balance",
    "transactions",
    "loan",
    "loans",
    "invest",
    "investment",
    "interest rate",
    "credit",
    "savings",
    "mortgage",
  ],
  healthcare: [
    "patient",
    "patients",
    "doctor",
    "doctors",
    "clinic",
    "medical",
    "hospital",
    "health",
    "treatment",
  ],
  education: [
    "course",
    "courses",
    "students",
    "lesson",
    "lessons",
    "learn",
    "curriculum",
    "university",
    "school",
    "enroll",
    "faculty",
  ],
  government: [
    "government",
    "citizens",
    "department",
    "ministry",
    "permit",
    "public services",
    "agency",
    "official",
  ],
  sports: [
    "team",
    "teams",
    "match",
    "matches",
    "fixtures",
    "league",
    "standings",
    "scores",
    "players",
    "season",
    "tournament",
    "results",
  ],
  cricket: [
    "cricket",
    "innings",
    "wickets",
    "wicket",
    "overs",
    "batting",
    "bowling",
    "scorecard",
    "odi",
    "t20",
    "runs",
    "umpire",
  ],
  "real-estate": [
    "property",
    "properties",
    "rent",
    "bedrooms",
    "bathrooms",
    "sq ft",
    "real estate",
    "homes for sale",
    "realtor",
  ],
  restaurant: ["menu", "dishes", "cuisine", "order online", "restaurant", "chef", "dine", "takeaway"],
  portfolio: ["portfolio", "my work", "about me", "resume", "projects", "case studies", "hire me"],
  documentation: [
    "documentation",
    "docs",
    "guide",
    "guides",
    "api reference",
    "getting started",
    "tutorial",
    "reference",
    "changelog",
  ],
  "developer-tool": [
    "api",
    "sdk",
    "cli",
    "developers",
    "npm",
    "install",
    "repository",
    "open source",
    "github",
  ],
};

export interface CategoryScore {
  category: ApplicationCategory;
  score: number;
  hits: { term: string; route: string; strong: boolean }[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TERM_RES = new Map<string, RegExp>();
function termRe(term: string): RegExp {
  let re = TERM_RES.get(term);
  if (!re) {
    re = new RegExp(`\\b${escapeRe(term)}\\b`, "i");
    TERM_RES.set(term, re);
  }
  return re;
}

/** Strong text (weight 3): title, headings, nav labels, table headers. Weak text (weight 1): body sample. */
export function routeTexts(o: RouteObservation): { strong: string; weak: string } {
  const e = o.extract;
  if (!e) return { strong: "", weak: "" };
  return {
    strong: [
      e.title,
      e.metaDescription,
      ...e.headings.map((h) => h.text),
      ...e.links.filter((l) => l.region === "nav" || l.region === "header").map((l) => l.text),
      ...e.tables.flatMap((t) => t.headers),
    ].join(" \n "),
    weak: e.mainText.slice(0, 2000),
  };
}

export function scoreCategories(observations: RouteObservation[]): CategoryScore[] {
  const scores: CategoryScore[] = [];
  const visited = observations.filter((o) => o.status === "visited" && o.extract);
  for (const [category, terms] of Object.entries(CATEGORY_TERMS) as [
    Exclude<ApplicationCategory, "unknown">,
    string[],
  ][]) {
    const hits: CategoryScore["hits"] = [];
    let score = 0;
    for (const term of terms) {
      const re = termRe(term);
      let routes = 0;
      for (const o of visited) {
        const t = routeTexts(o);
        const strong = re.test(t.strong);
        const weak = !strong && re.test(t.weak);
        if (strong || weak) {
          routes++;
          if (hits.length < 12) hits.push({ term, route: o.path, strong });
          score += strong ? 3 : 1;
          if (routes >= 3) break; // one term cannot dominate by repetition across many routes
        }
      }
    }
    // Structural signals.
    if (category === "dashboard")
      score += 2 * visited.filter((o) => (o.extract?.tables.length ?? 0) >= 2).length;
    if (category === "documentation")
      score += visited.some((o) => o.extract?.links.some((l) => l.region === "aside")) ? 2 : 0;
    scores.push({ category, score, hits });
  }
  // Cricket implies sports; give sports the cricket evidence as secondary weight.
  const cricket = scores.find((s) => s.category === "cricket");
  const sports = scores.find((s) => s.category === "sports");
  if (cricket && sports && cricket.score > 0) sports.score += Math.floor(cricket.score / 2);
  return scores.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
}

export interface Classification {
  primaryCategory: ApplicationCategory;
  secondaryCategories: string[];
  confidence: number;
  evidence: EvidenceReference[];
  summary: string;
}

/** Minimum score for a category to be claimed at all; below it the category stays "unknown". */
export const CATEGORY_THRESHOLD = 6;

export function classifyApplication(
  observations: RouteObservation[],
  evidenceFor: (route: string) => string,
): Classification {
  const scores = scoreCategories(observations);
  const top = scores[0];
  const second = scores[1];
  if (!top || top.score < CATEGORY_THRESHOLD) {
    return {
      primaryCategory: "unknown",
      secondaryCategories: [],
      confidence: 0,
      evidence: [],
      summary: `Insufficient evidence to classify the application (top signal "${top?.category ?? "none"}" scored ${top?.score ?? 0}, threshold ${CATEGORY_THRESHOLD}).`,
    };
  }
  const confidence = Math.max(0.1, Math.min(0.95, top.score / (top.score + (second?.score ?? 0) + 6)));
  const secondary = scores
    .slice(1)
    .filter((s) => s.score >= CATEGORY_THRESHOLD && s.score >= top.score * 0.5)
    .slice(0, 3)
    .map((s) => s.category);
  const evidence: EvidenceReference[] = top.hits.slice(0, 5).map((h, i) => ({
    evidenceId: `${evidenceFor(h.route)}-term-${i + 1}`,
    kind: "heuristic",
    route: h.route,
    excerpt:
      `term "${h.term}" observed in ${h.strong ? "title/heading/navigation" : "page text"} of ${h.route}`.slice(
        0,
        300,
      ),
  }));
  const terms = [...new Set(top.hits.map((h) => h.term))].slice(0, 6);
  return {
    primaryCategory: top.category,
    secondaryCategories: secondary,
    confidence: Math.round(confidence * 100) / 100,
    evidence,
    summary: `Observed terms ${terms.map((t) => `"${t}"`).join(", ")} across ${new Set(top.hits.map((h) => h.route)).size} route(s) suggest a ${top.category} site (heuristic, not a verified fact).`,
  };
}

const STOP = new Set(
  "the and for with your from this that have are was were will you our about more home page menu search sign log login contact privacy terms cookie cookies policy skip content main next previous back all new view read learn here click open close show hide also into over than then them they their there what when where which while who why how can may not just only very some such each other".split(
    " ",
  ),
);

/** Frequent observed terms (strong text only), for the domain terminology list. */
export function terminology(
  observations: RouteObservation[],
  limit = 25,
): { term: string; occurrences: number; routes: string[] }[] {
  const counts = new Map<string, { n: number; routes: Set<string> }>();
  for (const o of observations) {
    const text = routeTexts(o).strong.toLowerCase();
    for (const w of text.split(/[^a-z0-9À-ɏ]+/)) {
      if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
      const c = counts.get(w) ?? { n: 0, routes: new Set<string>() };
      c.n++;
      c.routes.add(o.path);
      counts.set(w, c);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c.n >= 2)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, c]) => ({ term, occurrences: c.n, routes: [...c.routes].slice(0, 10) }));
}
