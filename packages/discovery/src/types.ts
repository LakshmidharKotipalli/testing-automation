import type {
  AuthBoundary,
  BlockedRoute,
  DiscoveryStats,
  DiscoveryWorkPacket,
  ExternalLinkRecord,
  Locator,
  RouteEdge,
} from "@browserswarm/core";
import type { PageExtract } from "./extract.js";
import type { DiscoveryBlockedRequest } from "./guards.js";

export interface ConsoleEntry {
  type: string;
  text: string;
  url: string;
  at: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  failure?: string;
  resourceType: string;
  at: string;
}

export interface AxeScanResult {
  url: string;
  violations: {
    id: string;
    impact: string;
    help: string;
    helpUrl: string;
    nodeCount: number;
    targets: string[];
  }[];
  passes: number;
  incomplete: number;
}

export interface InteractionRecord {
  kind: "tab" | "accordion" | "details" | "menu" | "pagination" | "toggle" | "cookie-banner";
  label: string;
  outcome: "ok" | "navigated-back" | "error";
  locator?: Locator;
}

export interface SearchExercise {
  kind: "search" | "filter";
  formIndex: number;
  paramName: string;
  term: string;
  /** Relative path+query of the read-only GET request that was navigated to. */
  path: string;
  resultsObserved: boolean;
}

export interface RestrictedCandidate {
  route: string;
  kind: "button" | "link" | "input" | "form" | "select";
  label: string;
  category: string;
  reason: string;
  locator?: Locator;
}

/** Everything observed on one route. Strings are redacted and bounded before they are stored. */
export interface RouteObservation {
  evidenceId: string;
  path: string;
  url: string;
  depth: number;
  from?: string;
  status: "visited" | "error" | "blocked";
  httpStatus?: number;
  redirectedTo?: string;
  requiresAuth: boolean;
  authSignal?: AuthBoundary["kind"];
  extract?: PageExtract;
  axe?: AxeScanResult;
  axePath?: string;
  screenshot?: string;
  overflow: { viewport: string; scrollWidth: number; clientWidth: number }[];
  console: ConsoleEntry[];
  network: NetworkEntry[];
  interactions: InteractionRecord[];
  searchExercises: SearchExercise[];
  error?: string;
}

export interface DiscoveredRouteRef {
  path: string;
  url: string;
  depth: number;
  from?: string;
  label: string;
  visited: boolean;
  authPage: boolean;
}

export interface DiscoveryRunResult {
  packet: DiscoveryWorkPacket;
  status: "completed" | "partial" | "blocked" | "failed";
  stopReason: string;
  observations: RouteObservation[];
  discovered: DiscoveredRouteRef[];
  edges: RouteEdge[];
  externalLinks: ExternalLinkRecord[];
  blockedRequests: DiscoveryBlockedRequest[];
  blockedRoutes: BlockedRoute[];
  restricted: RestrictedCandidate[];
  stats: DiscoveryStats;
  limitations: string[];
  checkpoints: string[];
  handoffs: string[];
  artifacts: string[];
  maxDepthReached: number;
}
