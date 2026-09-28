import {
  computeProfileHash,
  TestPlanSchema,
  ValidationError,
  type ExcludedScenario,
  type TestPlan,
  type WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import type { ScopeSelection } from "@browserswarm/plan-compiler";

/**
 * Removes scenarios from an existing (exported, possibly hand-edited) plan by id, route, role or category.
 * Removed scenarios are listed under excludedScenarios. The result has a new plan hash, so any earlier
 * execution plan and approval no longer match: regenerate and re-approve.
 */
export function applyScopeExclusions(
  plan: TestPlan,
  selection: Partial<ScopeSelection>,
): {
  plan: TestPlan;
  removed: string[];
} {
  const removed: ExcludedScenario[] = [];
  const keep = plan.scenarios.filter((s) => {
    const routes = s.routes ?? [];
    const tags = new Set([...(s.tags ?? []), ...s.roles, ...(s.source ? [s.source] : [])]);
    let reason: string | undefined;
    if (selection.excludeScenarios?.includes(s.id)) reason = "scenario excluded by user";
    else if (s.roles.some((r) => selection.excludeRoles?.includes(r))) reason = "role excluded by user";
    else if (selection.excludeCategories?.some((c) => tags.has(c))) reason = "category excluded by user";
    else if (
      selection.excludeRoutes?.some((p) => {
        const pat = p.replace(/\*+$/, "").replace(/\/+$/, "") || "/";
        return routes.some(
          (r) =>
            r === p || r === pat || (pat !== "/" && (r.startsWith(`${pat}/`) || r.startsWith(`${pat}?`))),
        );
      })
    )
      reason = "route excluded by user";
    else if (selection.onlyRoles?.length && !s.roles.some((r) => selection.onlyRoles?.includes(r)))
      reason = "outside the user's selected roles";
    if (!reason) return true;
    removed.push({ id: s.id, title: s.title, routes, reason, evidence: s.evidence ?? [] });
    return false;
  });
  if (!keep.length)
    throw new ValidationError("Scope exclusions removed every scenario", ["nothing would be tested"]);
  const next = TestPlanSchema.parse({
    ...plan,
    scenarios: keep,
    excludedScenarios: [...(plan.excludedScenarios ?? []), ...removed],
  });
  return { plan: next, removed: removed.map((r) => r.id) };
}

/**
 * Checks that an autonomous plan still matches its profile: the profile is intact, the plan is bound to it,
 * and every discovery-sourced scenario only uses discovered routes (edits may remove, never invent).
 */
export function validatePlanAgainstProfile(plan: TestPlan, profile: WebsiteUnderstandingProfile): string[] {
  const errors: string[] = [];
  if (computeProfileHash(profile) !== profile.profileHash)
    errors.push("profile was modified after generation (hash mismatch)");
  if (plan.origin?.mode !== "autonomous") return errors;
  if (plan.origin.profileHash && plan.origin.profileHash !== profile.profileHash)
    errors.push(`plan is bound to profile ${plan.origin.profileHash}, not ${profile.profileHash}`);
  if (plan.target.url !== profile.targetUrl) errors.push("plan target differs from the discovered target");
  const known = new Set(profile.routeGraph.routes.map((r) => r.path));
  const knownPaths = new Set([...known].map((k) => k.split("?")[0]));
  for (const s of plan.scenarios) {
    if (!s.source || s.source === "user-instruction") continue;
    for (const r of s.routes ?? [])
      if (!known.has(r)) errors.push(`scenario ${s.id}: route ${r} was not discovered`);
    for (const step of s.steps)
      if (step.action === "navigate") {
        const p = step.url.split("#")[0] as string;
        if (!known.has(p) && !knownPaths.has(p.split("?")[0]))
          errors.push(`scenario ${s.id}: navigates to undiscovered ${p}`);
      }
  }
  return errors;
}
