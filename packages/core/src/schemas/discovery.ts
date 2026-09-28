import { z } from "zod";
import {
  AgentRoleSchema,
  EvidenceReferenceSchema,
  IsoDateSchema,
  PrioritySchema,
  ScenarioSafetyClassSchema,
  ScenarioSourceSchema,
  Sha256Schema,
  ViewportSizeSchema,
} from "./common.js";
import {
  BrowserConfigSchema,
  ContextPolicySchema,
  DomainSchema,
  LlmPolicySchema,
  ModelRefSchema,
} from "./plan.js";
import { LocatorSchema } from "./steps.js";

/**
 * Bounds for the single read-only Discovery Lead Agent. Every limit is enforced; reaching one ends discovery
 * cleanly with status "partial" and the limit recorded as a limitation.
 */
export const DiscoveryPolicySchema = z
  .object({
    maxRoutesDiscovered: z.number().int().min(1).max(5000).default(100),
    maxRoutesVisited: z.number().int().min(1).max(5000).default(75),
    maxNavigationDepth: z.number().int().min(0).max(50).default(5),
    maxNavigations: z.number().int().min(1).max(10_000).default(150),
    maxSafeInteractions: z.number().int().min(0).max(10_000).default(80),
    maxDurationMs: z
      .number()
      .int()
      .min(1000)
      .max(24 * 3_600_000)
      .default(900_000),
    maxScreenshots: z.number().int().min(0).max(5000).default(100),
    maxUniqueFormsInventoried: z.number().int().min(0).max(5000).default(50),
    maxUniqueInteractiveElementsPerRoute: z.number().int().min(1).max(5000).default(200),
    maxExternalLinksRecorded: z.number().int().min(0).max(5000).default(100),
    stopWhenNoNewRoutesAfter: z.number().int().min(1).max(1000).default(15),
    allowSearchAndFilters: z.boolean().default(true),
    allowNonPersistentTabsAndAccordions: z.boolean().default(true),
    allowReadOnlyPagination: z.boolean().default(true),
    allowCookieBannerDismissal: z.boolean().default(true),
    /** Viewports inspected per visited route for the responsive surface (first is the primary viewport). */
    viewports: z
      .record(z.string().min(1), ViewportSizeSchema)
      .default({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } }),
    /** Run axe-core on each visited route (nonintrusive; reads the DOM only). */
    runAccessibilityScan: z.boolean().default(true),
  })
  .strict();
export type DiscoveryPolicy = z.infer<typeof DiscoveryPolicySchema>;
export type DiscoveryPolicyInput = z.input<typeof DiscoveryPolicySchema>;

export const DiscoveryRequestSchema = z
  .object({
    targetUrl: z.string().url(),
    allowedDomains: z.array(DomainSchema).min(1),
    allowSubdomains: z.boolean().default(false),
    userIntent: z.string().max(2000).optional(),
    userInstructions: z.string().max(20_000).optional(),
    mode: z.literal("autonomous"),
    discoveryPolicy: DiscoveryPolicySchema,
    browser: BrowserConfigSchema,
    model: ModelRefSchema.nullable().default(null),
    contextLifecycle: ContextPolicySchema,
  })
  .strict();
export type DiscoveryRequest = z.infer<typeof DiscoveryRequestSchema>;

/** The one bounded, hash-bound work packet of the discovery phase. */
export const DiscoveryWorkPacketSchema = z
  .object({
    version: z.literal(1),
    packetId: z.string().min(1),
    runId: z.string().min(1),
    role: z.literal("discovery-lead"),
    request: DiscoveryRequestSchema,
    artifactDir: z.string(),
    guarantees: z.array(z.string()),
    packetHash: Sha256Schema,
  })
  .strict();
export type DiscoveryWorkPacket = z.infer<typeof DiscoveryWorkPacketSchema>;

/** Operator statement that they are authorized to run read-only discovery against this exact target. */
export const DiscoveryAuthorizationRecordSchema = z
  .object({
    version: z.literal(1),
    authorizationId: z.string(),
    runId: z.string(),
    operator: z.string().min(1),
    mode: z.enum(["interactive", "noninteractive"]),
    targetUrl: z.string().url(),
    allowedDomains: z.array(z.string()).min(1),
    discoveryPacketHash: Sha256Schema,
    statement: z.string().max(1000),
    authorizedAt: IsoDateSchema,
    recordHash: Sha256Schema,
  })
  .strict();
export type DiscoveryAuthorizationRecord = z.infer<typeof DiscoveryAuthorizationRecordSchema>;

export const FrontierEntrySchema = z
  .object({ url: z.string(), depth: z.number().int().min(0), from: z.string().optional() })
  .strict();
export type FrontierEntry = z.infer<typeof FrontierEntrySchema>;

export const DiscoveryCountersSchema = z
  .object({
    navigations: z.number().int().min(0),
    safeInteractions: z.number().int().min(0),
    screenshots: z.number().int().min(0),
    routesVisited: z.number().int().min(0),
    routesDiscovered: z.number().int().min(0),
    llmCalls: z.number().int().min(0),
  })
  .strict();
export type DiscoveryCounters = z.infer<typeof DiscoveryCountersSchema>;

export const DiscoveryCheckpointSchema = z
  .object({
    version: z.literal(1),
    checkpointId: z.string(),
    sequence: z.number().int().min(1),
    runId: z.string(),
    packetId: z.string(),
    agentInstanceId: z.string(),
    createdAt: IsoDateSchema,
    reason: z.enum(["route_completed", "rotation", "limit_reached", "cancelled", "completed"]),
    packetHash: Sha256Schema,
    frontier: z.array(FrontierEntrySchema),
    visited: z.array(z.string()),
    counters: DiscoveryCountersSchema,
    elapsedMs: z.number().int().min(0),
    integrityHash: Sha256Schema,
  })
  .strict();
export type DiscoveryCheckpoint = z.infer<typeof DiscoveryCheckpointSchema>;

export const DiscoveryHandoffSchema = z
  .object({
    version: z.literal(1),
    handoffId: z.string(),
    runId: z.string(),
    packetId: z.string(),
    previousAgentInstanceId: z.string(),
    replacementAgentInstanceId: z.string().optional(),
    createdAt: IsoDateSchema,
    packetHash: Sha256Schema,
    sourceCheckpointId: z.string(),
    trigger: z.string().max(200),
    mission: z.string().max(1000),
    progress: z
      .object({
        routesVisited: z.number().int().min(0),
        routesDiscovered: z.number().int().min(0),
        frontierSize: z.number().int().min(0),
      })
      .strict(),
    remainingBudgets: z
      .object({
        navigations: z.number().int().min(0),
        safeInteractions: z.number().int().min(0),
        screenshots: z.number().int().min(0),
        durationMs: z.number().int().min(0),
      })
      .strict(),
    doNotRepeat: z.array(z.string().max(300)),
    policyReminders: z.array(z.string().max(300)),
    conciseStatusSummary: z.string().max(1000),
    integrityHash: Sha256Schema,
  })
  .strict();
export type DiscoveryHandoff = z.infer<typeof DiscoveryHandoffSchema>;

// ---------------------------------------------------------------------------------------------------------
// Website Understanding Profile
// ---------------------------------------------------------------------------------------------------------

const Evidence = z.array(EvidenceReferenceSchema);
const RequiredEvidence = z.array(EvidenceReferenceSchema).min(1, "every claim requires evidence");
const Confidence = z.number().min(0).max(1);

export const ApplicationCategorySchema = z.enum([
  "ecommerce",
  "saas",
  "dashboard",
  "content",
  "social",
  "marketplace",
  "booking",
  "finance",
  "healthcare",
  "education",
  "government",
  "sports",
  "cricket",
  "real-estate",
  "restaurant",
  "portfolio",
  "documentation",
  "developer-tool",
  "unknown",
]);
export type ApplicationCategory = z.infer<typeof ApplicationCategorySchema>;

export const DiscoveredRouteSchema = z
  .object({
    routeId: z.string(),
    /** Normalized same-origin path + query, e.g. "/products?page=2". */
    path: z.string(),
    url: z.string(),
    title: z.string().max(300),
    depth: z.number().int().min(0),
    status: z.enum(["visited", "discovered", "blocked", "error"]),
    httpStatus: z.number().int().optional(),
    headings: z.array(z.string().max(200)),
    landmarks: z.array(z.string().max(60)),
    counts: z
      .object({
        links: z.number().int().min(0),
        buttons: z.number().int().min(0),
        forms: z.number().int().min(0),
        tables: z.number().int().min(0),
        interactive: z.number().int().min(0),
      })
      .strict(),
    requiresAuth: z.boolean(),
    screenshot: z.string().optional(),
    evidence: Evidence,
  })
  .strict();
export type DiscoveredRoute = z.infer<typeof DiscoveredRouteSchema>;

export const RouteEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    label: z.string().max(200),
    kind: z.enum(["link", "pagination", "search", "redirect"]),
  })
  .strict();
export type RouteEdge = z.infer<typeof RouteEdgeSchema>;

export const BlockedRouteSchema = z
  .object({ path: z.string(), reason: z.string().max(500), category: z.string().max(60).optional() })
  .strict();
export type BlockedRoute = z.infer<typeof BlockedRouteSchema>;

export const ExternalLinkRecordSchema = z
  .object({ url: z.string(), host: z.string(), fromRoute: z.string(), label: z.string().max(200) })
  .strict();
export type ExternalLinkRecord = z.infer<typeof ExternalLinkRecordSchema>;

export const ObservedRoleSchema = z
  .object({ name: z.string().max(100), confidence: Confidence, evidence: RequiredEvidence })
  .strict();
export type ObservedRole = z.infer<typeof ObservedRoleSchema>;

export const RestrictedAreaSchema = z
  .object({
    areaId: z.string(),
    label: z.string().max(200),
    routes: z.array(z.string()),
    category: z.string().max(60),
    reason: z.string().max(500),
    evidence: RequiredEvidence,
  })
  .strict();
export type RestrictedArea = z.infer<typeof RestrictedAreaSchema>;

export const SafeAreaSchema = z
  .object({
    areaId: z.string(),
    label: z.string().max(200),
    routes: z.array(z.string()),
    reason: z.string().max(500),
    evidence: RequiredEvidence,
  })
  .strict();
export type SafeArea = z.infer<typeof SafeAreaSchema>;

export const AuthBoundarySchema = z
  .object({
    route: z.string(),
    kind: z.enum(["login-link", "login-form", "redirect-to-login", "http-401", "http-403"]),
    evidence: RequiredEvidence,
  })
  .strict();
export type AuthBoundary = z.infer<typeof AuthBoundarySchema>;

export const DiscoveredEntitySchema = z
  .object({
    name: z.string().max(100),
    sourceKind: z.enum(["table-header", "card", "heading", "nav-label", "form"]),
    attributes: z.array(z.string().max(100)),
    routes: z.array(z.string()),
    confidence: Confidence,
    evidence: RequiredEvidence,
  })
  .strict();
export type DiscoveredEntity = z.infer<typeof DiscoveredEntitySchema>;

export const DiscoveredRelationshipSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    kind: z.enum(["list-detail", "navigates-to", "contains"]),
    evidence: RequiredEvidence,
  })
  .strict();
export type DiscoveredRelationship = z.infer<typeof DiscoveredRelationshipSchema>;

export const DomainTermSchema = z
  .object({ term: z.string().max(80), occurrences: z.number().int().min(1), routes: z.array(z.string()) })
  .strict();
export type DomainTerm = z.infer<typeof DomainTermSchema>;

export const ObservedDomainRuleSchema = z
  .object({
    ruleId: z.string(),
    description: z.string().max(500),
    routes: z.array(z.string()),
    /** Deterministically checkable form of the rule, when the observed data allows one. */
    assertion: z
      .object({
        kind: z.literal("same-value-on-routes"),
        label: z.string().max(100),
        value: z.string().max(100),
      })
      .strict()
      .optional(),
    evidence: RequiredEvidence,
  })
  .strict();
export type ObservedDomainRule = z.infer<typeof ObservedDomainRuleSchema>;

export const CandidateDomainRuleSchema = z
  .object({
    ruleId: z.string(),
    description: z.string().max(500),
    routes: z.array(z.string()),
    confidence: Confidence,
    verificationNeeded: z.string().max(500),
    evidence: RequiredEvidence,
  })
  .strict();
export type CandidateDomainRule = z.infer<typeof CandidateDomainRuleSchema>;

export const DiscoveredJourneySchema = z
  .object({
    journeyId: z.string(),
    name: z.string().max(200),
    kind: z.enum(["navigation", "browse", "list-detail", "search", "content", "pagination"]),
    routes: z.array(z.string()).min(1),
    steps: z.array(z.string().max(300)),
    readOnly: z.boolean(),
    confidence: Confidence,
    evidence: RequiredEvidence,
  })
  .strict();
export type DiscoveredJourney = z.infer<typeof DiscoveredJourneySchema>;

export const NavigationPatternSchema = z
  .object({
    kind: z.enum(["primary-nav", "footer", "breadcrumb", "sidebar", "menu", "inline-links"]),
    label: z.string().max(200),
    linkCount: z.number().int().min(0),
    routes: z.array(z.string()),
  })
  .strict();
export type NavigationPattern = z.infer<typeof NavigationPatternSchema>;

export const FormPurposeSchema = z.enum([
  "search",
  "filter",
  "login",
  "signup",
  "password-reset",
  "contact",
  "newsletter",
  "checkout",
  "upload",
  "generic",
]);

export const FormInventoryItemSchema = z
  .object({
    formId: z.string(),
    route: z.string(),
    name: z.string().max(200),
    method: z.enum(["get", "post", "dialog", "unknown"]),
    action: z.string().max(500),
    fields: z.array(
      z
        .object({
          name: z.string().max(100),
          type: z.string().max(40),
          label: z.string().max(200),
          required: z.boolean(),
        })
        .strict(),
    ),
    submitLabel: z.string().max(200),
    purpose: FormPurposeSchema,
    persistsData: z.boolean(),
    restricted: z.boolean(),
    evidence: RequiredEvidence,
  })
  .strict();
export type FormInventoryItem = z.infer<typeof FormInventoryItemSchema>;

export const TableInventoryItemSchema = z
  .object({
    tableId: z.string(),
    route: z.string(),
    caption: z.string().max(200),
    headers: z.array(z.string().max(100)),
    rowCount: z.number().int().min(0),
    evidence: RequiredEvidence,
  })
  .strict();
export type TableInventoryItem = z.infer<typeof TableInventoryItemSchema>;

export const SearchFilterInventoryItemSchema = z
  .object({
    id: z.string(),
    route: z.string(),
    kind: z.enum(["search", "filter", "sort"]),
    label: z.string().max(200),
    method: z.enum(["get", "post", "client", "unknown"]),
    action: z.string().max(500),
    paramName: z.string().max(100).optional(),
    locator: LocatorSchema.optional(),
    /** Read-only GET query URL exercised during discovery (relative path), when any. */
    exercisedUrl: z.string().optional(),
    resultsObserved: z.boolean(),
    evidence: RequiredEvidence,
  })
  .strict();
export type SearchFilterInventoryItem = z.infer<typeof SearchFilterInventoryItemSchema>;

export const InteractiveInventoryItemSchema = z
  .object({
    id: z.string(),
    route: z.string(),
    kind: z.enum([
      "tab",
      "accordion",
      "details",
      "menu",
      "modal",
      "pagination",
      "carousel",
      "toggle",
      "button",
      "link",
      "select",
    ]),
    label: z.string().max(200),
    locator: LocatorSchema.optional(),
    exercised: z.boolean(),
    evidence: RequiredEvidence,
  })
  .strict();
export type InteractiveInventoryItem = z.infer<typeof InteractiveInventoryItemSchema>;

export const RestrictedControlSchema = z
  .object({
    id: z.string(),
    route: z.string(),
    kind: z.enum(["button", "link", "input", "form", "select"]),
    label: z.string().max(200),
    category: z.string().max(60),
    reason: z.string().max(500),
    locator: LocatorSchema.optional(),
    evidence: RequiredEvidence,
  })
  .strict();
export type RestrictedControl = z.infer<typeof RestrictedControlSchema>;

export const DiscoveryAccessibilitySummarySchema = z
  .object({
    routesScanned: z.number().int().min(0),
    violationCount: z.number().int().min(0),
    byImpact: z.record(z.string(), z.number().int().min(0)),
    topRules: z.array(
      z
        .object({
          id: z.string(),
          impact: z.string(),
          help: z.string().max(300),
          count: z.number().int().min(0),
          routes: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export type DiscoveryAccessibilitySummary = z.infer<typeof DiscoveryAccessibilitySummarySchema>;

export const DiscoveryResponsiveSummarySchema = z
  .object({
    viewportsChecked: z.array(z.string()),
    routesChecked: z.number().int().min(0),
    concerns: z.array(
      z.object({ route: z.string(), viewport: z.string(), issue: z.string().max(300) }).strict(),
    ),
    mobileRelevant: z.boolean(),
  })
  .strict();
export type DiscoveryResponsiveSummary = z.infer<typeof DiscoveryResponsiveSummarySchema>;

export const ConsoleSummarySchema = z
  .object({
    errorCount: z.number().int().min(0),
    warningCount: z.number().int().min(0),
    samples: z.array(z.object({ route: z.string(), text: z.string().max(300) }).strict()),
  })
  .strict();
export type ConsoleSummary = z.infer<typeof ConsoleSummarySchema>;

export const NetworkSummarySchema = z
  .object({
    failedRequestCount: z.number().int().min(0),
    httpErrorCount: z.number().int().min(0),
    blockedExternalCount: z.number().int().min(0),
    blockedNonReadCount: z.number().int().min(0),
    samples: z.array(
      z
        .object({
          route: z.string(),
          url: z.string().max(500),
          status: z.number().int().optional(),
          failure: z.string().max(200).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type NetworkSummary = z.infer<typeof NetworkSummarySchema>;

export const VisibleErrorStateSchema = z
  .object({ route: z.string(), text: z.string().max(300), evidence: RequiredEvidence })
  .strict();
export type VisibleErrorState = z.infer<typeof VisibleErrorStateSchema>;

export const BrokenMediaObservationSchema = z
  .object({ route: z.string(), src: z.string().max(500), evidence: RequiredEvidence })
  .strict();
export type BrokenMediaObservation = z.infer<typeof BrokenMediaObservationSchema>;

export const RecommendedAgentRoleSchema = z
  .object({
    role: AgentRoleSchema,
    rationale: z.string().max(1000),
    routes: z.array(z.string()),
    evidence: RequiredEvidence,
  })
  .strict();
export type RecommendedAgentRole = z.infer<typeof RecommendedAgentRoleSchema>;

export const RecommendedScenarioSchema = z
  .object({
    scenarioId: z.string(),
    title: z.string().max(200),
    role: AgentRoleSchema,
    routes: z.array(z.string()),
    source: ScenarioSourceSchema,
    safetyClass: ScenarioSafetyClassSchema,
    priority: PrioritySchema,
    evidence: RequiredEvidence,
  })
  .strict();
export type RecommendedScenario = z.infer<typeof RecommendedScenarioSchema>;

export const ProfileExcludedScenarioSchema = z
  .object({
    id: z.string(),
    title: z.string().max(200),
    routes: z.array(z.string()),
    safetyClass: ScenarioSafetyClassSchema,
    reason: z.string().max(500),
    evidence: Evidence,
  })
  .strict();
export type ProfileExcludedScenario = z.infer<typeof ProfileExcludedScenarioSchema>;

export const BrowserMatrixRecommendationSchema = z
  .object({
    engine: z.string(),
    viewportName: z.string(),
    viewport: ViewportSizeSchema,
    rationale: z.string().max(300),
  })
  .strict();
export type BrowserMatrixRecommendation = z.infer<typeof BrowserMatrixRecommendationSchema>;

export const ArtifactManifestReferenceSchema = z
  .object({
    path: z.string(),
    entryCount: z.number().int().min(0),
    sha256: Sha256Schema.optional(),
  })
  .strict();
export type ArtifactManifestReference = z.infer<typeof ArtifactManifestReferenceSchema>;

export const DiscoveryStatsSchema = z
  .object({
    routesDiscovered: z.number().int().min(0),
    routesVisited: z.number().int().min(0),
    maxDepthReached: z.number().int().min(0),
    navigations: z.number().int().min(0),
    safeInteractions: z.number().int().min(0),
    screenshots: z.number().int().min(0),
    durationMs: z.number().int().min(0),
    agentInstances: z.number().int().min(1),
    handoffs: z.number().int().min(0),
    llmCalls: z.number().int().min(0),
    stopReason: z.string().max(500),
  })
  .strict();
export type DiscoveryStats = z.infer<typeof DiscoveryStatsSchema>;

export const WebsiteUnderstandingProfileSchema = z
  .object({
    version: z.literal(1),
    profileId: z.string(),
    runId: z.string(),
    targetUrl: z.string().url(),
    allowedDomains: z.array(z.string()).min(1),
    generatedAt: IsoDateSchema,
    discoveryStatus: z.enum(["completed", "partial", "blocked", "failed"]),
    applicationClassification: z
      .object({
        primaryCategory: ApplicationCategorySchema,
        secondaryCategories: z.array(z.string().max(60)),
        confidence: Confidence,
        evidence: Evidence,
        summary: z.string().max(1000),
      })
      .strict(),
    businessPurpose: z
      .object({
        inferredPurpose: z.string().max(1000),
        primaryUserGoals: z.array(z.string().max(300)),
        observedValuePropositions: z.array(z.string().max(300)),
        confidence: Confidence,
        evidence: Evidence,
      })
      .strict(),
    accessModel: z
      .object({
        publicRoutes: z.array(z.string()),
        authenticationObserved: z.boolean(),
        observedRoles: z.array(ObservedRoleSchema),
        restrictedAreas: z.array(RestrictedAreaSchema),
        authBoundaries: z.array(AuthBoundarySchema),
      })
      .strict(),
    routeGraph: z
      .object({
        routes: z.array(DiscoveredRouteSchema),
        edges: z.array(RouteEdgeSchema),
        entryRoutes: z.array(z.string()),
        unreachableOrBlockedRoutes: z.array(BlockedRouteSchema),
        externalLinks: z.array(ExternalLinkRecordSchema),
      })
      .strict(),
    domainModel: z
      .object({
        entities: z.array(DiscoveredEntitySchema),
        relationships: z.array(DiscoveredRelationshipSchema),
        terminology: z.array(DomainTermSchema),
        domainRulesObserved: z.array(ObservedDomainRuleSchema),
        domainRulesNeedingVerification: z.array(CandidateDomainRuleSchema),
      })
      .strict(),
    userJourneys: z.array(DiscoveredJourneySchema),
    uiInventory: z
      .object({
        navigationPatterns: z.array(NavigationPatternSchema),
        forms: z.array(FormInventoryItemSchema),
        tables: z.array(TableInventoryItemSchema),
        searchAndFilters: z.array(SearchFilterInventoryItemSchema),
        tabsAndAccordions: z.array(InteractiveInventoryItemSchema),
        modals: z.array(InteractiveInventoryItemSchema),
        pagination: z.array(InteractiveInventoryItemSchema),
        uploads: z.array(RestrictedControlSchema),
        downloads: z.array(RestrictedControlSchema),
        sideEffectingControls: z.array(RestrictedControlSchema),
        otherInteractiveControls: z.array(InteractiveInventoryItemSchema),
      })
      .strict(),
    qualitySurface: z
      .object({
        accessibility: DiscoveryAccessibilitySummarySchema,
        responsive: DiscoveryResponsiveSummarySchema,
        console: ConsoleSummarySchema,
        network: NetworkSummarySchema,
        visibleErrorStates: z.array(VisibleErrorStateSchema),
        brokenMedia: z.array(BrokenMediaObservationSchema),
      })
      .strict(),
    riskClassification: z
      .object({
        safeReadOnlyAreas: z.array(SafeAreaSchema),
        needsCredentials: z.array(RestrictedAreaSchema),
        needsTestData: z.array(RestrictedAreaSchema),
        needsExplicitRiskApproval: z.array(RestrictedAreaSchema),
        excludedByDefault: z.array(RestrictedAreaSchema),
      })
      .strict(),
    recommendedTestStrategy: z
      .object({
        recommendedAgentRoles: z.array(RecommendedAgentRoleSchema),
        recommendedScenarios: z.array(RecommendedScenarioSchema),
        excludedScenarios: z.array(ProfileExcludedScenarioSchema),
        recommendedConcurrency: z.number().int().min(1).max(64),
        recommendedBrowserMatrix: z.array(BrowserMatrixRecommendationSchema),
        recommendedLlmPolicy: LlmPolicySchema,
        recommendedContextPolicy: ContextPolicySchema,
      })
      .strict(),
    discoveryLimits: DiscoveryPolicySchema,
    discoveryStats: DiscoveryStatsSchema,
    limitations: z.array(z.string().max(500)),
    assumptions: z.array(z.string().max(500)),
    evidenceManifest: ArtifactManifestReferenceSchema,
    profileHash: Sha256Schema,
  })
  .strict()
  .superRefine((p, ctx) => {
    // A known category is an inference and must be backed by evidence; "unknown" is preserved as-is.
    if (
      p.applicationClassification.primaryCategory !== "unknown" &&
      !p.applicationClassification.evidence.length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicationClassification", "evidence"],
        message: "a classified category requires evidence",
      });
    const known = new Set(p.routeGraph.routes.map((r) => r.path));
    p.recommendedTestStrategy.recommendedScenarios.forEach((s, i) => {
      for (const route of s.routes)
        if (!known.has(route))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["recommendedTestStrategy", "recommendedScenarios", i, "routes"],
            message: `route ${route} is not in the discovered route graph`,
          });
    });
  });
export type WebsiteUnderstandingProfile = z.infer<typeof WebsiteUnderstandingProfileSchema>;

/** Summary document written next to the profile. The profile carries the details. */
export const DiscoveryReportSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    profileId: z.string(),
    profileHash: Sha256Schema,
    targetUrl: z.string().url(),
    allowedDomains: z.array(z.string()),
    generatedAt: IsoDateSchema,
    discoveryStatus: z.enum(["completed", "partial", "blocked", "failed"]),
    stats: DiscoveryStatsSchema,
    guarantees: z.array(z.string()),
    blockedRequests: z.array(
      z.object({ url: z.string().max(500), method: z.string(), reason: z.string().max(300) }).strict(),
    ),
    restrictedControlsNotUsed: z.number().int().min(0),
    artifacts: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();
export type DiscoveryReport = z.infer<typeof DiscoveryReportSchema>;
