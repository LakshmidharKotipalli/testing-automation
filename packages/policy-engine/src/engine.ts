import {
  computeWorkPacketHash,
  type HandoffDocument,
  type ResumeContext,
  type RiskFlag,
  type TestPlan,
  type TestStep,
  type WorkPacket,
} from "@browserswarm/core";
import { canonicalize, type Redactor } from "@browserswarm/shared";
import { checkUrl } from "./domains.js";
import { classifyStep } from "./risk.js";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  riskFlags: RiskFlag[];
}

export interface PlanPolicyResult {
  errors: string[];
  warnings: string[];
  riskFlags: RiskFlag[];
}

/**
 * Plan-time policy evaluation (runs during validation and execution-plan generation).
 * - A risky step the safety policy does not allow is an error: the plan cannot be approved.
 * - A risky step the policy allows is a risk flag that needs separate, typed risk approval.
 */
export function evaluatePlanPolicy(plan: TestPlan): PlanPolicyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const riskFlags: RiskFlag[] = [];
  const scope = { allowedDomains: plan.target.allowedDomains, allowSubdomains: plan.target.allowSubdomains };

  const targetCheck = checkUrl(plan.target.url, plan.target.url, scope);
  if (!targetCheck.allowed) errors.push(`target.url: ${targetCheck.reason}`);
  if (plan.safety.allowExternalNavigation) {
    errors.push(
      "safety.allowExternalNavigation: navigation is always limited to target.allowedDomains; add the domain explicitly instead",
    );
  }
  if (!plan.safety.redactSensitiveData) {
    warnings.push(
      "safety.redactSensitiveData is false: secrets are still never sent to models, but logs may contain test data",
    );
  }

  for (const scenario of plan.scenarios) {
    if (scenario.roles.includes("security-smoke") && !plan.safety.allowSecuritySmoke) {
      errors.push(`scenario ${scenario.id}: role security-smoke requires safety.allowSecuritySmoke: true`);
    }
    if (scenario.roles.includes("verifier")) {
      errors.push(`scenario ${scenario.id}: role verifier is assigned by the framework, not by scenarios`);
    }
    scenario.steps.forEach((step, index) => {
      for (const flag of classifyStep(step, index, {
        ...scope,
        scenarioId: scenario.id,
        targetUrl: plan.target.url,
        safety: plan.safety,
      })) {
        riskFlags.push(flag);
        if (!flag.allowedByPolicy) {
          errors.push(
            `scenario ${scenario.id} step ${index} (${step.action}) blocked by safety policy: ${flag.category} (${flag.reason})`,
          );
        }
      }
      if (
        "locator" in step &&
        step.locator?.css &&
        !step.locator.role &&
        !step.locator.label &&
        !step.locator.testId
      ) {
        warnings.push(
          `scenario ${scenario.id} step ${index}: CSS-only locator; prefer role, label or testId`,
        );
      }
    });
  }
  return { errors, warnings, riskFlags };
}

export interface ActionContext {
  packet: WorkPacket;
  currentUrl: string | undefined;
  /** True only when the approval record accepted this packet's risk flags. */
  riskApproved: boolean;
}

/** Runtime check executed immediately before every browser action (scripted, fallback, replay or resumed). */
export function checkAction(step: TestStep, stepIndex: number, ctx: ActionContext): PolicyDecision {
  const { packet } = ctx;
  const scope = { allowedDomains: packet.allowedDomains, allowSubdomains: packet.allowSubdomains };
  const approvedStep = packet.steps[stepIndex];
  if (!approvedStep) {
    return {
      allowed: false,
      reason: `step ${stepIndex} is not part of the approved work packet`,
      riskFlags: [],
    };
  }
  if (canonicalize(approvedStep) !== canonicalize(step)) {
    return { allowed: false, reason: `step ${stepIndex} differs from the approved step`, riskFlags: [] };
  }
  if (ctx.currentUrl) {
    const here = checkUrl(ctx.currentUrl, packet.targetUrl, scope);
    if (!here.allowed)
      return { allowed: false, reason: `current page is out of scope: ${here.reason}`, riskFlags: [] };
  }
  const flags = classifyStep(step, stepIndex, {
    ...scope,
    scenarioId: packet.scenarioId,
    targetUrl: packet.targetUrl,
    safety: packet.safety,
  });
  for (const flag of flags) {
    if (!flag.allowedByPolicy) {
      return { allowed: false, reason: `${flag.category} blocked by safety policy`, riskFlags: flags };
    }
    const approved = packet.riskFlags.some((f) => f.stepIndex === stepIndex && f.category === flag.category);
    if (!approved || !ctx.riskApproved) {
      return { allowed: false, reason: `${flag.category} requires explicit risk approval`, riskFlags: flags };
    }
  }
  return { allowed: true, riskFlags: flags };
}

/**
 * LLM fallback proposals may only re-target the approved step (e.g. a better locator); they may not change
 * the action, the value, the URL, or add steps. The resulting step still goes through checkAction.
 */
export function checkLlmProposal(
  proposal: TestStep,
  stepIndex: number,
  ctx: ActionContext,
): PolicyDecision & { effectiveStep?: TestStep } {
  const approved = ctx.packet.steps[stepIndex];
  if (!approved) return { allowed: false, reason: "no approved step at this index", riskFlags: [] };
  if (proposal.action !== approved.action) {
    return {
      allowed: false,
      reason: `LLM proposed ${proposal.action} but approved step is ${approved.action}`,
      riskFlags: [],
    };
  }
  const strip = (s: TestStep) => {
    const { locator: _l, description: _d, timeoutMs: _t, ...rest } = s as TestStep & { locator?: unknown };
    return canonicalize(rest);
  };
  if (strip(proposal) !== strip(approved)) {
    return {
      allowed: false,
      reason: "LLM proposal changes approved values, URL or expectations",
      riskFlags: [],
    };
  }
  // Classify the proposal with its new locator; the approved step's identity is retained for checkAction.
  const flags = classifyStep(proposal, stepIndex, {
    allowedDomains: ctx.packet.allowedDomains,
    allowSubdomains: ctx.packet.allowSubdomains,
    scenarioId: ctx.packet.scenarioId,
    targetUrl: ctx.packet.targetUrl,
    safety: ctx.packet.safety,
  });
  const newRisk = flags.find(
    (f) => !ctx.packet.riskFlags.some((a) => a.stepIndex === stepIndex && a.category === f.category),
  );
  if (newRisk)
    return {
      allowed: false,
      reason: `LLM proposal introduces unapproved risk ${newRisk.category}`,
      riskFlags: flags,
    };
  const base = checkAction(approved, stepIndex, ctx);
  return base.allowed ? { ...base, effectiveStep: proposal } : base;
}

export interface HandoffPolicyInput {
  handoff: HandoffDocument;
  packet: WorkPacket;
  approvedExecutionPlanHash: string;
  redactor: Redactor;
}

/** Runs before every handoff is persisted and before every replacement-agent launch. */
export function checkHandoff({
  handoff,
  packet,
  approvedExecutionPlanHash,
  redactor,
}: HandoffPolicyInput): PolicyDecision {
  const problems: string[] = [];
  if (computeWorkPacketHash(packet) !== packet.workPacketHash)
    problems.push("work packet was modified after approval");
  if (handoff.immutableWorkPacketHash !== packet.workPacketHash)
    problems.push("handoff work-packet hash mismatch");
  if (handoff.approvedExecutionPlanHash !== approvedExecutionPlanHash)
    problems.push("handoff execution-plan hash mismatch");
  if (handoff.workPacketId !== packet.packetId) problems.push("handoff belongs to a different work packet");
  if (
    canonicalize([...handoff.mission.allowedDomains].sort()) !==
    canonicalize([...packet.allowedDomains].sort())
  ) {
    problems.push("handoff changes allowed domains");
  }
  if (handoff.mission.scenarioId !== packet.scenarioId || handoff.mission.role !== packet.role) {
    problems.push("handoff changes the mission");
  }
  if (handoff.continuationInstructions.resumeFromStepIndex > packet.steps.length) {
    problems.push("handoff resume index is outside the approved steps");
  }
  const serialized = canonicalize(handoff);
  if (redactor.containsSecret(serialized)) problems.push("handoff contains an unredacted secret value");
  if (/"(cookies|origins)"\s*:/.test(serialized)) problems.push("handoff embeds raw storage state");
  return problems.length
    ? { allowed: false, reason: problems.join("; "), riskFlags: [] }
    : { allowed: true, riskFlags: [] };
}

/** Runs before a replacement agent consumes its resume context. */
export function checkResumeContext(
  ctx: ResumeContext,
  packet: WorkPacket,
  redactor: Redactor,
): PolicyDecision {
  const handoffDecision = checkHandoff({
    handoff: ctx.handoff,
    packet,
    approvedExecutionPlanHash: ctx.approvedExecutionPlanHash,
    redactor,
  });
  if (!handoffDecision.allowed) return handoffDecision;
  if (canonicalize(ctx.workPacket) !== canonicalize(packet)) {
    return {
      allowed: false,
      reason: "resume context work packet differs from the approved packet",
      riskFlags: [],
    };
  }
  if (canonicalize(ctx.safetyPolicy) !== canonicalize(packet.safety)) {
    return { allowed: false, reason: "resume context changes the safety policy", riskFlags: [] };
  }
  if (ctx.nextStep && canonicalize(packet.steps[ctx.nextStep.index]) !== canonicalize(ctx.nextStep.step)) {
    return {
      allowed: false,
      reason: "resume context next step differs from the approved step",
      riskFlags: [],
    };
  }
  if (redactor.containsSecret(canonicalize(ctx))) {
    return { allowed: false, reason: "resume context contains an unredacted secret value", riskFlags: [] };
  }
  return { allowed: true, riskFlags: [] };
}
