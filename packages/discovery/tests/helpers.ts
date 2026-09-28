import {
  BrowserConfigSchema,
  ContextPolicySchema,
  DiscoveryPolicySchema,
  type RouteEdge,
} from "@browserswarm/core";
import { FakeClock } from "@browserswarm/shared";
import {
  buildWebsiteUnderstandingProfile,
  createDiscoveryPacket,
  type DiscoveryRunResult,
  type PageExtract,
  type RouteObservation,
} from "../src/index.js";

export const TARGET = "https://shop.example.test";

export function extract(partial: Partial<PageExtract> = {}): PageExtract {
  return {
    url: TARGET,
    title: "",
    lang: "en",
    metaDescription: "",
    headings: [],
    landmarks: ["header", "nav", "main"],
    links: [],
    controls: [],
    forms: [],
    tables: [],
    cards: [],
    media: [],
    errorTexts: [],
    emptyStateTexts: [],
    mainText: "",
    dialogs: 0,
    iframes: 0,
    cookieBanner: { present: false, labels: [] },
    loginSignals: { passwordField: false, loginHeading: false },
    numbers: [],
    truncated: false,
    ...partial,
  };
}

let n = 0;
export function observation(
  path: string,
  depth: number,
  e?: Partial<PageExtract>,
  extra: Partial<RouteObservation> = {},
): RouteObservation {
  n++;
  return {
    evidenceId: `ev-route-${String(n).padStart(3, "0")}`,
    path,
    url: `${TARGET}${path}`,
    depth,
    status: "visited",
    httpStatus: 200,
    requiresAuth: false,
    extract: extract({ url: `${TARGET}${path}`, ...e }),
    overflow: [{ viewport: "desktop", scrollWidth: 1440, clientWidth: 1440 }],
    console: [],
    network: [],
    interactions: [],
    searchExercises: [],
    ...extra,
  };
}

const navLink = (idx: number, text: string, path: string) => ({
  idx,
  text,
  href: `${TARGET}${path}`,
  download: false,
  region: "nav" as const,
  regionLabel: "Main",
});

/** A small e-commerce site as discovery would observe it: catalog, items, search, login boundary, risky controls. */
export function syntheticShop(): DiscoveryRunResult {
  n = 0;
  const packet = createDiscoveryPacket(
    {
      targetUrl: `${TARGET}/`,
      allowedDomains: ["shop.example.test"],
      mode: "autonomous",
      discoveryPolicy: DiscoveryPolicySchema.parse({}),
      browser: BrowserConfigSchema.parse({}),
      contextLifecycle: ContextPolicySchema.parse({}),
    },
    "run-test",
  );
  const home = observation("/", 0, {
    title: "Tool Shop",
    metaDescription: "Online store for tools and garden products",
    headings: [
      { level: 1, text: "Tool Shop" },
      { level: 2, text: "Featured products" },
    ],
    links: [
      navLink(0, "Products", "/products"),
      navLink(1, "About", "/about"),
      navLink(2, "Sign in", "/login"),
    ],
    mainText: "Shop our catalog. Add to cart. Free shipping on products over $50.",
  });
  const products = observation(
    "/products",
    1,
    {
      title: "Products",
      headings: [{ level: 1, text: "Products" }],
      links: [
        {
          idx: 0,
          text: "Cordless Drill",
          href: `${TARGET}/products/1`,
          download: false,
          region: "main",
          regionLabel: "",
        },
        {
          idx: 1,
          text: "Garden Hose",
          href: `${TARGET}/products/2`,
          download: false,
          region: "main",
          regionLabel: "",
        },
      ],
      tables: [
        {
          caption: "Products",
          headers: ["Name", "Price", "Stock"],
          rowCount: 2,
          sampleRows: [["Cordless Drill", "$89", "In stock"]],
          role: "table",
        },
      ],
      forms: [
        {
          index: 0,
          name: "Product search",
          role: "search",
          method: "get",
          action: `${TARGET}/search`,
          fields: [{ name: "q", type: "search", label: "Search products", required: false, options: [] }],
          submitLabel: "Search",
          hasPassword: false,
          hasFile: false,
          inSearchLandmark: true,
        },
      ],
      controls: [
        {
          idx: 5,
          tag: "button",
          role: "tab",
          type: null,
          label: "Specifications",
          inForm: false,
          ariaExpanded: null,
          ariaControls: true,
          ariaHasPopup: null,
          inPagination: false,
          inCookieBanner: false,
          visible: true,
          testId: null,
        },
      ],
      numbers: [{ label: "Total products", value: "2" }],
      mainText: "Our products: price, stock, add to cart.",
    },
    {
      interactions: [
        {
          kind: "tab",
          label: "Specifications",
          outcome: "ok",
          locator: { role: "tab", name: "Specifications" },
        },
      ],
      searchExercises: [
        {
          kind: "search",
          formIndex: 0,
          paramName: "q",
          term: "Drill",
          path: "/search?q=Drill",
          resultsObserved: true,
        },
      ],
      console: [
        { type: "error", text: "widget failed", url: `${TARGET}/products`, at: "2026-01-01T00:00:00.000Z" },
      ],
    },
  );
  const item1 = observation("/products/1", 2, {
    title: "Cordless Drill",
    headings: [{ level: 1, text: "Cordless Drill" }],
    numbers: [{ label: "Total products", value: "2" }],
  });
  const item2 = observation("/products/2", 2, {
    title: "Garden Hose",
    headings: [{ level: 1, text: "Garden Hose" }],
  });
  const about = observation("/about", 1, {
    title: "About",
    headings: [
      { level: 1, text: "About us" },
      { level: 2, text: "Our story" },
    ],
  });
  const login = observation(
    "/login",
    1,
    {
      title: "Sign in",
      headings: [{ level: 1, text: "Sign in" }],
      forms: [
        {
          index: 0,
          name: "login",
          role: null,
          method: "post",
          action: `${TARGET}/session`,
          fields: [
            { name: "email", type: "email", label: "Email", required: true, options: [] },
            { name: "password", type: "password", label: "Password", required: true, options: [] },
          ],
          submitLabel: "Sign in",
          hasPassword: true,
          hasFile: false,
          inSearchLandmark: false,
        },
      ],
      loginSignals: { passwordField: true, loginHeading: true },
    },
    { authSignal: "login-form" },
  );
  const account = observation("/account", 1, undefined, {
    requiresAuth: true,
    authSignal: "redirect-to-login",
    redirectedTo: "/login",
  });
  const search = observation("/search?q=Drill", 2, {
    title: "Search results",
    headings: [{ level: 1, text: "Search results" }],
  });
  const observations = [home, products, item1, item2, about, login, account, search];
  const edges: RouteEdge[] = [
    { from: "/", to: "/products", label: "Products", kind: "link" },
    { from: "/", to: "/about", label: "About", kind: "link" },
    { from: "/", to: "/login", label: "Sign in", kind: "link" },
    { from: "/", to: "/account", label: "My account", kind: "link" },
    { from: "/products", to: "/products/1", label: "Cordless Drill", kind: "link" },
    { from: "/products", to: "/products/2", label: "Garden Hose", kind: "link" },
    { from: "/products", to: "/search?q=Drill", label: "search: Drill", kind: "search" },
    { from: "/account", to: "/login", label: "redirect", kind: "redirect" },
  ];
  return {
    packet,
    status: "completed",
    stopReason: "all reachable safe routes within limits visited",
    observations,
    discovered: observations.map((o) => ({
      path: o.path,
      url: o.url,
      depth: o.depth,
      label: o.extract?.title ?? o.path,
      visited: true,
      authPage: o.path === "/login",
      ...(o.depth ? { from: "/" } : {}),
    })),
    edges,
    externalLinks: [
      { url: "https://partner.example.org/", host: "partner.example.org", fromRoute: "/", label: "Partner" },
    ],
    blockedRequests: [
      {
        url: `${TARGET}/api/cart`,
        method: "POST",
        reason: "blocked",
        kind: "non-read-method",
        isNavigation: false,
        at: "2026-01-01T00:00:00.000Z",
      },
    ],
    blockedRoutes: [],
    restricted: [
      {
        route: "/products",
        kind: "button",
        label: "Add to cart",
        category: "purchase",
        reason: "label indicates purchase",
        locator: { role: "button", name: "Add to cart" },
      },
      {
        route: "/products",
        kind: "button",
        label: "Delete product",
        category: "deletion",
        reason: "label indicates deletion",
      },
      {
        route: "/products",
        kind: "input",
        label: "Upload photo",
        category: "file_upload",
        reason: "file input",
      },
      { route: "/", kind: "link", label: "Log out", category: "authentication", reason: "logout link" },
    ],
    stats: {
      routesDiscovered: observations.length,
      routesVisited: observations.length,
      maxDepthReached: 2,
      navigations: 8,
      safeInteractions: 2,
      screenshots: 0,
      durationMs: 1234,
      agentInstances: 1,
      handoffs: 0,
      llmCalls: 0,
      stopReason: "all reachable safe routes within limits visited",
    },
    limitations: [],
    checkpoints: [],
    handoffs: [],
    artifacts: [],
    maxDepthReached: 2,
  };
}

export async function syntheticProfile() {
  return buildWebsiteUnderstandingProfile(syntheticShop(), { clock: new FakeClock() });
}
