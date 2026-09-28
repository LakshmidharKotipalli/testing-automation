import {
  ContextPolicySchema,
  LlmPolicySchema,
  TestPlanSchema,
  ValidationError,
  type AgentRole,
  type ExcludedScenario,
  type ExecutionPlan,
  type Priority,
  type ScopeResolutionRecord,
  type TestPlan,
  type TestPlanInput,
  type WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { validatePlan, type ScopeSelection } from "@browserswarm/plan-compiler";
import { slugify, type Clock } from "@browserswarm/shared";
import {
  buildScenarioCandidates,
  evidenceMap,
  type CandidateScenario,
  type ProfileFacts,
} from "./scenarios.js";
import { renderPlanSummaryMarkdown } from "./review.js";

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const DEFAULT_MAX_SCENARIOS = 40;
export const DEFAULT_ACTIONS_PER_INSTANCE = 50;

/** The recommendation block of the profile: derived from the same candidate builder the generator uses. */
export function recommendStrategy(
  facts: ProfileFacts,
): WebsiteUnderstandingProfile["recommendedTestStrategy"] {
  const viewports = Object.keys(facts.discoveryLimits.viewports);
  const c = buildScenarioCandidates(facts, { viewports });
  const used = new Set(c.scenarios.flatMap((s) => s.viewports));
  return {
    recommendedAgentRoles: c.roles,
    recommendedScenarios: c.scenarios.map((s) => ({
      scenarioId: s.id,
      title: s.title.slice(0, 200),
      role: s.role,
      routes: s.routes,
      source: s.source,
      safetyClass: s.safetyClass,
      priority: s.priority,
      evidence: s.evidence,
    })),
    excludedScenarios: [
      ...c.deferred.map((d) => ({
        id: d.id,
        title: d.title,
        routes: d.routes,
        safetyClass: d.safetyClass,
        reason: d.reason.slice(0, 500),
        evidence: d.evidence,
      })),
      ...c.excluded.map((e) => ({
        id: e.id,
        title: e.title,
        routes: e.routes,
        safetyClass: "excluded" as const,
        reason: e.reason.slice(0, 500),
        evidence: e.evidence,
      })),
    ],
    recommendedConcurrency: Math.max(1, Math.min(4, Math.ceil(c.scenarios.length / 3))),
    recommendedBrowserMatrix: Object.entries(facts.discoveryLimits.viewports)
      .filter(([name]) => used.has(name) || name === viewports[0])
      .map(([name, size]) => ({
        engine: "chromium",
        viewportName: name,
        viewport: size,
        rationale:
          name === viewports[0]
            ? "primary viewport used during discovery"
            : "inspected during discovery for layout issues",
      })),
    recommendedLlmPolicy: LlmPolicySchema.parse({}),
    recommendedContextPolicy: ContextPolicySchema.parse({
      maxActionsPerAgentInstance: DEFAULT_ACTIONS_PER_INSTANCE,
    }),
  };
}

export interface AutonomousPlanInput {
  profile: WebsiteUnderstandingProfile;
  selection?: Partial<ScopeSelection>;
  scopeRecord?: ScopeResolutionRecord;
  userIntent?: string;
  /** Plan-level configuration (models, llm, browser, ...). Safety defaults stay deny-all unless supplied. */
  config?: Partial<
    Pick<
      TestPlanInput,
      "models" | "llm" | "browser" | "safety" | "contextLifecycle" | "execution" | "reporting"
    >
  >;
  parallel?: number;
  runId?: string;
  clock?: Clock;
  maxScenarios?: number;
}

export interface AutonomousPlanResult {
  testPlan: TestPlan;
  executionPlan: ExecutionPlan;
  summaryMarkdown: string;
  evidenceMap: ReturnType<typeof evidenceMap>;
  droppedByScope: string[];
  droppedBySafety: string[];
}

function routeExcluded(routes: string[], patterns: string[]): boolean {
  return routes.some((r) =>
    patterns.some((p) => {
      const pat = p.replace(/\*+$/, "").replace(/\/+$/, "") || "/";
      return r === p || r === pat || (pat !== "/" && (r.startsWith(`${pat}/`) || r.startsWith(`${pat}?`)));
    }),
  );
}

/** Applies user scope choices to candidates. Removed items are returned so they appear as excluded. */
export function applySelection(
  candidates: CandidateScenario[],
  selection: Partial<ScopeSelection> = {},
): { kept: CandidateScenario[]; removed: { scenario: CandidateScenario; reason: string }[] } {
  const kept: CandidateScenario[] = [];
  const removed: { scenario: CandidateScenario; reason: string }[] = [];
  const only = new Set<AgentRole>(selection.onlyRoles ?? []);
  for (const s of candidates) {
    let reason: string | undefined;
    if (selection.excludeScenarios?.includes(s.id)) reason = "scenario excluded by user";
    else if (selection.excludeRoles?.includes(s.role)) reason = `role ${s.role} excluded by user`;
    else if (selection.excludeCategories?.some((c) => c === s.category || c === s.role || c === s.source))
      reason = `category ${s.category} excluded by user`;
    else if (selection.excludeRoutes?.length && routeExcluded(s.routes, selection.excludeRoutes))
      reason = "route excluded by user";
    else if (only.size && !only.has(s.role)) reason = `user limited scope to ${[...only].join(", ")}`;
    if (reason) removed.push({ scenario: s, reason });
    else kept.push(s);
  }
  return { kept, removed };
}

/**
 * AutonomousTestPlanGenerator: turns a Website Understanding Profile into an editable TestPlan and its exact
 * ExecutionPlan. Only discovered routes and observed locators are used; every scenario is safe-read-only,
 * carries evidence, and is re-checked by the regular plan validator and risk classifier. Scenarios the
 * policy engine flags are dropped (never "fixed" by relaxing policy).
 */
export class AutonomousTestPlanGenerator {
  generate(input: AutonomousPlanInput): AutonomousPlanResult {
    const { profile } = input;
    const facts: ProfileFacts = profile;
    const viewportNames = Object.keys(profile.discoveryLimits.viewports);
    const candidates = buildScenarioCandidates(facts, { viewports: viewportNames });
    const { kept, removed } = applySelection(candidates.scenarios, input.selection);
    const excluded: ExcludedScenario[] = [...candidates.excluded];
    for (const r of removed)
      excluded.push({
        id: r.scenario.id,
        title: r.scenario.title,
        routes: r.scenario.routes,
        reason: r.reason,
        evidence: r.scenario.evidence,
      });

    const max = input.maxScenarios ?? DEFAULT_MAX_SCENARIOS;
    const ordered = [...kept].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    const selected = ordered.slice(0, max);
    for (const s of ordered.slice(max))
      excluded.push({
        id: s.id,
        title: s.title,
        routes: s.routes,
        reason: `scenario budget (${max}) reached; lower priority`,
        evidence: s.evidence,
      });

    const host = new URL(profile.targetUrl).hostname;
    const actionsPerInstance = DEFAULT_ACTIONS_PER_INSTANCE;
    const build = (scenarios: CandidateScenario[]): TestPlan => {
      const usedViewports = new Set(scenarios.flatMap((s) => s.viewports));
      const viewports = Object.fromEntries(
        Object.entries(profile.discoveryLimits.viewports).filter(([n]) => usedViewports.has(n)),
      );
      const raw: TestPlanInput = {
        version: 1,
        id: `autonomous-${slugify(host) || "site"}`,
        name: `Autonomous safe QA plan for ${host}`,
        description:
          `Generated from Website Understanding Profile ${profile.profileId} (${profile.applicationClassification.primaryCategory}, ` +
          `confidence ${Math.round(profile.applicationClassification.confidence * 100)}%). Safe read-only scenarios only; edit freely and re-approve.`,
        mode: "scripted",
        target: { url: profile.targetUrl, allowedDomains: profile.allowedDomains, allowSubdomains: false },
        browser: input.config?.browser ?? {},
        execution: {
          maxConcurrentAgents:
            input.selection?.maxConcurrency ?? profile.recommendedTestStrategy.recommendedConcurrency,
          ...(input.config?.execution ?? {}),
        },
        models: input.config?.models ?? {},
        llm: input.config?.llm ?? {},
        contextLifecycle: input.config?.contextLifecycle ?? {
          maxActionsPerAgentInstance: actionsPerInstance,
        },
        safety: input.config?.safety ?? {},
        testData: {},
        viewports,
        scenarios: scenarios.map((s) => ({
          id: s.id,
          title: s.title.slice(0, 200),
          objective: s.objective.slice(0, 1000),
          priority: s.priority,
          roles: [s.role],
          viewports: s.viewports,
          expectedOutcome: s.expectedOutcome.slice(0, 1000),
          tags: [s.category, s.role],
          steps: s.steps,
          source: s.source,
          safetyClass: s.safetyClass,
          evidence: s.evidence,
          routes: s.routes,
          preconditions: s.preconditions,
          requiredData: [],
          executableWithoutLlm: true,
          rationale: s.rationale.slice(0, 1000),
        })),
        reporting: input.config?.reporting ?? {},
        origin: {
          mode: "autonomous",
          profileId: profile.profileId,
          profileHash: profile.profileHash,
          discoveryRunId: profile.runId,
          ...(input.userIntent ? { userIntent: input.userIntent.slice(0, 2000) } : {}),
          ...(input.scopeRecord ? { scopeResolution: input.scopeRecord } : {}),
        },
        deferredScenarios: candidates.deferred,
        excludedScenarios: excluded,
      };
      return TestPlanSchema.parse(raw);
    };

    let scenarios = selected;
    const droppedBySafety: string[] = [];
    if (!scenarios.length)
      throw new ValidationError("No safe scenarios could be planned from the discovery evidence", [
        "discovery found no public, evidence-backed routes within scope; see the discovery report limitations",
      ]);
    let plan = build(scenarios);
    // Safety net: anything the regular validator or risk classifier rejects is dropped, never relaxed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const report = validatePlan(plan);
      const bad = new Set<string>(report.riskFlags.map((f) => f.scenarioId));
      for (const e of report.errors) {
        const m = /scenario ([^\s:]+)/.exec(e);
        if (m) bad.add(m[1] as string);
      }
      if (!bad.size && report.valid) break;
      if (!bad.size) throw new ValidationError("Generated plan is invalid", report.errors);
      for (const id of bad) {
        const s = scenarios.find((x) => x.id === id);
        if (!s) continue;
        droppedBySafety.push(id);
        excluded.push({
          id: s.id,
          title: s.title,
          routes: s.routes,
          reason: "dropped: flagged by the plan validator or risk classifier",
          evidence: s.evidence,
        });
      }
      scenarios = scenarios.filter((s) => !bad.has(s.id));
      if (!scenarios.length)
        throw new ValidationError(
          "Every generated scenario was rejected by the safety policy",
          report.errors,
        );
      plan = build(scenarios);
    }

    const executionPlan = generateExecutionPlan(plan, {
      ...(input.parallel ? { parallel: input.parallel } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.clock ? { clock: input.clock } : {}),
    });
    const map = evidenceMap(plan.scenarios);
    return {
      testPlan: plan,
      executionPlan,
      summaryMarkdown: renderPlanSummaryMarkdown(profile, plan, executionPlan),
      evidenceMap: map,
      droppedByScope: removed.map((r) => r.scenario.id),
      droppedBySafety,
    };
  }
}
