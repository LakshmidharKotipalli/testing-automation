import type { AgentRole, RunMode, ScopeResolutionRecord } from "@browserswarm/core";
import { parseStepLine } from "./prompt-compiler.js";

export interface ModeInput {
  /** `--mode` on the command line; always wins. */
  explicitMode?: RunMode;
  /** A structured YAML/JSON plan was supplied. */
  planProvided?: boolean;
  /** Natural-language request (from --prompt or --prompt-text). */
  promptText?: string;
}

export interface ModeResolution {
  mode: RunMode;
  reasons: string[];
}

const BROAD_REQUEST =
  /\b(test (this|the|my|our) (whole |entire |full )?(web ?site|site|app|application|web ?app)|figure (it |this )?out|explore( and test)?|safe qa|perform (a )?(safe )?qa|qa (this|the)|test everything|(whole|entire|full) (web ?site|site|app)|test it|understand (this|the) (web ?site|site|app))\b/i;

const EXPLICIT_MARKERS =
  /\b(scenarios?\s*[:\d]|steps?\s*:|expected( outcome| result)?\s*:|acceptance criteria|given\b.+\bwhen\b.+\bthen\b|verify that|assert(ion)?s?\b|should (see|display|show|redirect|return))/i;

const ONLY_SCOPE = /\b(only|just) (test|check|verify|cover)\b|\btest only\b/i;
const ROUTE_TOKEN = /(^|\s)\/[a-z0-9][\w\-./]*/i;

/**
 * Decides the run mode. Priority: explicit --mode, then a structured plan (instruction-led), then the
 * prompt's content: explicit scenarios/steps/routes or an "only test X" scope -> instruction-led; a broad
 * request ("test this website") or no prompt at all -> autonomous. Anything else stays instruction-led so
 * the user's words, not discovery, define the scope.
 */
export function resolveRunMode(input: ModeInput): ModeResolution {
  if (input.explicitMode)
    return { mode: input.explicitMode, reasons: [`--mode ${input.explicitMode} given explicitly`] };
  if (input.planProvided)
    return { mode: "instruction-led", reasons: ["a structured test plan was supplied"] };
  const text = input.promptText?.trim() ?? "";
  if (!text) return { mode: "autonomous", reasons: ["only a target URL was provided"] };
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  const stepLines = lines.filter((l) => parseStepLine(l) !== undefined);
  const reasons: string[] = [];
  if (stepLines.length) reasons.push(`${stepLines.length} executable step line(s) found`);
  if (EXPLICIT_MARKERS.test(text)) reasons.push("explicit scenario, step or expected-outcome markers found");
  if (ONLY_SCOPE.test(text)) reasons.push('prompt limits the scope ("only test ...")');
  if (ROUTE_TOKEN.test(text) && !BROAD_REQUEST.test(text)) reasons.push("specific routes are listed");
  if (reasons.length) return { mode: "instruction-led", reasons };
  if (BROAD_REQUEST.test(text))
    return { mode: "autonomous", reasons: ["prompt is a broad testing request without explicit scenarios"] };
  return {
    mode: "instruction-led",
    reasons: [
      "prompt is not a broad testing request; its instructions define the scope (use --mode autonomous to explore)",
    ],
  };
}

/** User-controlled scope selection applied to the autonomous plan (CLI flags plus prompt-derived items). */
export interface ScopeSelection {
  excludeScenarios: string[];
  excludeRoutes: string[];
  excludeRoles: AgentRole[];
  excludeCategories: string[];
  /** When non-empty, only these roles are planned ("only test accessibility"). */
  onlyRoles: AgentRole[];
  maxConcurrency?: number;
}

export interface ScopeResolution {
  record: ScopeResolutionRecord;
  selection: ScopeSelection;
  /** State-changing actions the user asked for: shown separately as requires-risk-approval, never planned. */
  riskRequests: string[];
}

const ROLE_WORDS: { re: RegExp; roles: AgentRole[]; category: string }[] = [
  { re: /\baccessibility|a11y|wcag\b/i, roles: ["accessibility"], category: "accessibility" },
  { re: /\bresponsive|mobile|viewport/i, roles: ["responsive"], category: "responsive" },
  { re: /\bforms?\b/i, roles: ["forms-read-only"], category: "forms" },
  { re: /\bsearch|filters?\b/i, roles: ["search-filter"], category: "search" },
  { re: /\btables?|data grid/i, roles: ["table-data", "dashboard"], category: "data" },
  { re: /\bnavigation|menus?|links?\b/i, roles: ["navigation"], category: "navigation" },
  { re: /\bcontent|articles?|blog\b/i, roles: ["content"], category: "content" },
  { re: /\bconsole|network|errors?\b/i, roles: ["console-network"], category: "console-network" },
  { re: /\btabs?|accordions?|pagination\b/i, roles: ["functional-ui"], category: "interaction" },
];

const RISK_REQUESTS: { re: RegExp; label: string }[] = [
  { re: /\b(log ?in|sign ?in|authenticate)\b/i, label: "authentication (requires credentials)" },
  { re: /\b(sign ?up|register|create (an )?account)\b/i, label: "account creation" },
  { re: /\b(submit|send) (the )?(form|message|contact)/i, label: "form submission" },
  { re: /\b(checkout|purchase|buy|pay|place (an )?order)\b/i, label: "purchase/payment" },
  { re: /\b(delete|remove|destroy)\b/i, label: "deletion" },
  { re: /\b(book|reserve)\b/i, label: "booking/reservation" },
  { re: /\bupload\b/i, label: "file upload" },
  {
    re: /\b(pen(etration)? ?test|fuzz|inject|sql injection|xss|brute ?force|scan for vulnerabilities|bypass|captcha|load test|ddos|stress test)\b/i,
    label: "active security/load testing (always blocked)",
  },
];

export interface ScopeInput {
  mode: ModeResolution;
  promptText?: string;
  cli?: Partial<ScopeSelection>;
}

/**
 * ScopeResolutionPolicy. Priority order:
 * 1. explicit user safety restrictions; 2. explicit user scenarios and expected outcomes; 3. explicit user
 * exclusions; 4. explicit agent/model/concurrency preferences; 5. discovery evidence; 6. the framework's
 * default safe QA policy. Safety always wins: a requested state-changing action is reported as a conflict
 * and classified requires-risk-approval (or requires-credentials), never planned autonomously.
 */
export function resolveScope(input: ScopeInput): ScopeResolution {
  const text = input.promptText ?? "";
  const safetyRestrictions: string[] = [];
  const exclusions: string[] = [];
  const preferences: string[] = [];
  const conflicts: string[] = [];
  const selection: ScopeSelection = {
    excludeScenarios: [...(input.cli?.excludeScenarios ?? [])],
    excludeRoutes: [...(input.cli?.excludeRoutes ?? [])],
    excludeRoles: [...(input.cli?.excludeRoles ?? [])],
    excludeCategories: [...(input.cli?.excludeCategories ?? [])],
    onlyRoles: [...(input.cli?.onlyRoles ?? [])],
    ...(input.cli?.maxConcurrency ? { maxConcurrency: input.cli.maxConcurrency } : {}),
  };
  const riskRequests: string[] = [];

  for (const raw of text.split(/\r?\n|(?<=[.;])\s+/)) {
    const line = raw.trim();
    if (!line) continue;
    // 1. Safety restrictions ("do not submit forms", "never log in").
    if (
      /\b(do not|don't|never|must not|avoid|no)\b/i.test(line) &&
      /\b(submit|log ?in|sign|purchase|buy|pay|delete|post|send|upload|download|create|modify|change)\b/i.test(
        line,
      )
    )
      safetyRestrictions.push(line.slice(0, 500));
    // 3. Exclusions ("skip /admin", "exclude accessibility", "don't test the blog").
    const ex = /\b(?:skip|exclude|ignore|do not test|don't test|except)\s+(.+)$/i.exec(line);
    if (ex) {
      const what = (ex[1] as string).trim();
      exclusions.push(what.slice(0, 500));
      for (const m of what.matchAll(/\/[a-z0-9][\w\-./]*/gi))
        selection.excludeRoutes.push(m[0].replace(/[.,;]+$/, ""));
      for (const w of ROLE_WORDS) if (w.re.test(what)) selection.excludeRoles.push(...w.roles);
    }
    // 4. Preferences ("only test accessibility", "use 2 agents").
    const only = /\b(?:only|just) (?:test|check|verify|cover)\s+(.+)$/i.exec(line);
    if (only && input.mode.mode === "autonomous") {
      for (const w of ROLE_WORDS) if (w.re.test(only[1] as string)) selection.onlyRoles.push(...w.roles);
      preferences.push(line.slice(0, 500));
    }
    const conc = /\b(\d{1,2})\s+(?:agents?|parallel|concurrent|workers?)\b/i.exec(line);
    if (conc) {
      selection.maxConcurrency = Math.max(1, Math.min(64, Number(conc[1])));
      preferences.push(`concurrency ${selection.maxConcurrency}`);
    }
    if (/\b(use|with) (the )?model\b/i.test(line)) preferences.push(line.slice(0, 500));
    // Requested state-changing actions: never planned; shown separately.
    if (!/\b(do not|don't|never|must not|avoid)\b/i.test(line))
      for (const r of RISK_REQUESTS)
        if (r.re.test(line) && !riskRequests.includes(r.label)) {
          riskRequests.push(r.label);
          conflicts.push(
            `requested ${r.label}: blocked by the default safety policy; classified ${/credentials/.test(r.label) ? "requires-credentials" : "requires-risk-approval"} and not planned`,
          );
        }
  }

  const dedupe = <T>(xs: T[]) => [...new Set(xs)];
  selection.excludeRoutes = dedupe(selection.excludeRoutes);
  selection.excludeRoles = dedupe(selection.excludeRoles);
  selection.onlyRoles = dedupe(selection.onlyRoles);
  for (const r of selection.excludeRoutes)
    if (!exclusions.includes(`route ${r}`)) exclusions.push(`route ${r}`);
  for (const r of selection.excludeRoles) exclusions.push(`role ${r}`);
  for (const c of selection.excludeCategories) exclusions.push(`category ${c}`);
  for (const s of selection.excludeScenarios) exclusions.push(`scenario ${s}`);
  if (selection.onlyRoles.length) preferences.push(`only roles: ${selection.onlyRoles.join(", ")}`);

  const reasons = [
    ...input.mode.reasons,
    "priority: safety restrictions > user scenarios > user exclusions > user preferences > discovery evidence > default safe QA policy",
  ];
  if (input.mode.mode === "instruction-led")
    reasons.push("user instructions are authoritative; discovery does not broaden scope");
  return {
    record: {
      mode: input.mode.mode,
      reasons: reasons.map((r) => r.slice(0, 500)),
      safetyRestrictions: dedupe(safetyRestrictions),
      exclusions: dedupe(exclusions).map((e) => e.slice(0, 500)),
      preferences: dedupe(preferences),
      conflicts: dedupe(conflicts),
    },
    selection,
    riskRequests,
  };
}
