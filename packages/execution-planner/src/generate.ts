import {
  computeExecutionPlanHash,
  computePlanHash,
  computeRiskPlanHash,
  computeWorkPacketHash,
  AgentRoleSchema,
  ExecutionPlanSchema,
  MILESTONE_LIMITATIONS,
  ValidationError,
  type AgentRole,
  type ExecutionPlan,
  type ExecutionPlanSummary,
  type ModelRef,
  type TestPlan,
  type WorkPacket,
} from "@browserswarm/core";
import { validatePlan } from "@browserswarm/plan-compiler";
import { SENSITIVE_KEY_PATTERN, newId, newRunId, systemClock, type Clock } from "@browserswarm/shared";

export interface GenerateOptions {
  /** Overrides execution.maxConcurrentAgents. Part of the hashed plan, so changing it invalidates approval. */
  parallel?: number;
  runId?: string;
  clock?: Clock;
}

const ALL_ROLES: AgentRole[] = [...AgentRoleSchema.options];

export function modelForRole(plan: TestPlan, role: AgentRole): ModelRef | null {
  return plan.models.overrides[role] ?? plan.models.default ?? null;
}

/**
 * Deterministic expansion: scenario x role x viewport x browser project (one engine per plan in v1).
 * No packet is created beyond what the plan states. Packet ids are stable: {scenarioId}-{role}-{viewport}.
 */
export function generateExecutionPlan(plan: TestPlan, options: GenerateOptions = {}): ExecutionPlan {
  const report = validatePlan(plan);
  if (!report.valid)
    throw new ValidationError("Test plan is not valid; no execution plan generated", report.errors);

  const clock = options.clock ?? systemClock;
  const runId = options.runId ?? newRunId(new Date(clock.now()));
  const planHash = computePlanHash(plan);
  const packets: WorkPacket[] = [];

  for (const scenario of plan.scenarios) {
    const scenarioFlags = report.riskFlags.filter((f) => f.scenarioId === scenario.id);
    for (const role of scenario.roles) {
      for (const viewportName of scenario.viewports) {
        const viewport = plan.viewports[viewportName];
        if (!viewport) throw new ValidationError("unknown viewport", [viewportName]);
        const model = modelForRole(plan, role);
        const llmCapable =
          plan.llm.strategy !== "disabled" && model !== null && plan.llm.maxCallsPerWorkPacket > 0;
        const packetId = `${scenario.id}-${role}-${viewportName}`;
        const packet: Omit<WorkPacket, "workPacketHash"> = {
          version: 1,
          packetId,
          runId,
          planId: plan.id,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          objective: scenario.objective,
          priority: scenario.priority,
          role,
          viewportName,
          viewport,
          browser: plan.browser,
          targetUrl: plan.target.url,
          allowedDomains: plan.target.allowedDomains,
          allowSubdomains: plan.target.allowSubdomains,
          steps: scenario.steps,
          expectedOutcome: scenario.expectedOutcome,
          mode: llmCapable ? "llm-capable" : "deterministic",
          model,
          llmPolicy: plan.llm,
          contextPolicy: plan.contextLifecycle,
          safety: plan.safety,
          timeoutMs: plan.execution.agentTimeoutMs,
          actionBudget: plan.execution.maxActionsPerAgent,
          llmCallBudget: llmCapable ? plan.llm.maxCallsPerWorkPacket : 0,
          artifactDir: `packets/${packetId}`,
          planHash,
          riskFlags: scenarioFlags,
          requiresExplicitRiskApproval: scenarioFlags.length > 0,
          // Only present for planner-generated scenarios, so instruction-led packet hashes are unchanged.
          ...(scenario.rationale ? { rationale: scenario.rationale } : {}),
        };
        packets.push({ ...packet, workPacketHash: computeWorkPacketHash(packet) });
      }
    }
  }

  const concurrency = Math.max(
    1,
    Math.min(options.parallel ?? plan.execution.maxConcurrentAgents, packets.length),
  );
  const models: Record<string, ModelRef | null> = {};
  const usedRoles = new Set(plan.scenarios.flatMap((s) => s.roles));
  for (const role of ALL_ROLES)
    if (usedRoles.has(role) || role === "verifier") models[role] = modelForRole(plan, role);

  const executionPlanId = newId("xplan");
  const riskFlags = report.riskFlags;
  const base: Omit<ExecutionPlan, "executionPlanHash"> = {
    version: 1,
    executionPlanId,
    runId,
    createdAt: clock.iso(),
    planId: plan.id,
    planName: plan.name,
    planHash,
    mode: plan.mode,
    target: {
      url: plan.target.url,
      allowedDomains: plan.target.allowedDomains,
      allowSubdomains: plan.target.allowSubdomains,
    },
    concurrency: {
      maxConcurrentWorkPackets: concurrency,
      maxConcurrentBrowserContexts: concurrency,
      failFast: plan.execution.failFast,
      runTimeoutMs: plan.execution.runTimeoutMs,
    },
    models,
    llm: plan.llm,
    contextLifecycle: plan.contextLifecycle,
    safety: plan.safety,
    browser: plan.browser,
    reporting: plan.reporting,
    testData: plan.testData,
    workPackets: packets,
    summary: summarize(plan, packets, concurrency),
    riskFlags,
    riskPlanHash: riskFlags.length ? computeRiskPlanHash(riskFlags, executionPlanId) : null,
    requiresExplicitRiskApproval: riskFlags.length > 0,
    limitations: [...MILESTONE_LIMITATIONS],
    ...(plan.origin
      ? {
          origin: {
            mode: plan.origin.mode,
            ...(plan.origin.profileId ? { profileId: plan.origin.profileId } : {}),
            ...(plan.origin.profileHash
              ? { profileHash: plan.origin.profileHash as `sha256:${string}` }
              : {}),
            testPlanHash: planHash,
          },
        }
      : {}),
  };
  const executionPlan = { ...base, executionPlanHash: computeExecutionPlanHash(base) };
  return ExecutionPlanSchema.parse(executionPlan);
}

function summarize(plan: TestPlan, packets: WorkPacket[], concurrency: number): ExecutionPlanSummary {
  const cp = plan.contextLifecycle;
  let maxInstances = 0;
  let handoffs = 0;
  let checkpoints = 0;
  for (const p of packets) {
    const perInstance = cp.maxActionsPerAgentInstance ?? Number.POSITIVE_INFINITY;
    let rotations = cp.enabled ? Math.max(0, Math.ceil(p.steps.length / perInstance) - 1) : 0;
    if (cp.enabled && p.mode === "llm-capable")
      rotations = Math.max(rotations, Math.min(1, cp.maxHandoffsPerWorkPacket));
    rotations = Math.min(rotations, cp.maxHandoffsPerWorkPacket);
    maxInstances += 1 + rotations;
    handoffs += rotations;
    checkpoints += (cp.checkpointAfterEveryStep ? p.steps.length : 1) + rotations;
  }
  const waves = Math.ceil(packets.length / concurrency);
  const longest = Math.max(...packets.map((p) => p.steps.length));
  const maxLlmCalls = packets.reduce((n, p) => n + p.llmCallBudget, 0);
  const testDataCategories = Object.entries(plan.testData).map(([key, v]) => {
    const envName = typeof v === "string" ? undefined : v.fromEnv;
    const secret =
      (typeof v !== "string" && v.secret) || envName !== undefined || SENSITIVE_KEY_PATTERN.test(key);
    const category = typeof v !== "string" && v.category ? v.category : secret ? "secret" : "test-value";
    return `${key} (${category}${envName ? `, from env ${envName}` : ""}, redacted in artifacts)`;
  });
  return {
    scenarioCount: plan.scenarios.length,
    workPacketCount: packets.length,
    deterministicPackets: packets.filter((p) => p.mode === "deterministic").length,
    llmCapablePackets: packets.filter((p) => p.mode === "llm-capable").length,
    maxConcurrentWorkPackets: concurrency,
    maxConcurrentBrowserContexts: concurrency,
    maxBrowserActions: packets.reduce((n, p) => n + p.actionBudget, 0),
    maxLlmCalls,
    estimatedMaxTokens: maxLlmCalls * plan.llm.maxTokensPerCall,
    estimatedMaxAgentInstances: maxInstances,
    estimatedContextHandoffs: handoffs,
    estimatedCheckpoints: checkpoints,
    estimatedRuntimeMs: {
      min: waves * longest * 250,
      max: Math.min(plan.execution.runTimeoutMs, waves * plan.execution.agentTimeoutMs),
    },
    testDataCategories,
    browserMatrix: [...new Set(packets.map((p) => p.viewportName))].map((viewportName) => ({
      engine: plan.browser.engine,
      viewportName,
      viewport: plan.viewports[viewportName] as { width: number; height: number },
    })),
  };
}
