import {
  computePlanHash,
  TestPlanSchema,
  type AgentRole,
  type Locator,
  type ModelRef,
  type TestPlan,
  type TestPlanInput,
  type TestStepInput,
} from "@browserswarm/core";
import { generateStructured, type LLMClient } from "@browserswarm/opencode-adapter";
import { createRedactor, sha256, slugify } from "@browserswarm/shared";
import { z } from "zod";

export interface CompileResult {
  plan: TestPlan;
  assumptions: string[];
  ambiguities: string[];
  restrictions: string[];
  droppedSteps: string[];
  planHash: string;
}

export interface CompileOptions {
  promptText: string;
  url: string;
  allowedDomains?: string[];
}

const KNOWN_VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

const ROLES = [
  "button",
  "link",
  "heading",
  "alert",
  "textbox",
  "checkbox",
  "radio",
  "tab",
  "dialog",
  "navigation",
  "img",
  "combobox",
  "listitem",
  "menuitem",
  "status",
  "main",
  "banner",
  "form",
] as const;
const ROLE_RE = ROLES.join("|");
const AGENT_ROLES: AgentRole[] = [
  "functional",
  "forms",
  "accessibility",
  "responsive",
  "visual",
  "performance-smoke",
];

const RISKY_PERMISSION_HINTS: { re: RegExp; label: string }[] = [
  { re: /\ballow (purchases?|payments?)\b/i, label: "purchases/payments" },
  { re: /\ballow (account creation|sign ?ups?)\b/i, label: "account creation" },
  { re: /\ballow (deletes?|deletion|destructive)\b/i, label: "destructive actions" },
  { re: /\ballow (uploads?|downloads?)\b/i, label: "file transfer" },
  { re: /\ballow (emails?|sms)\b/i, label: "email/SMS sending" },
];

/** Parses a quoted string or a bare token. */
function unquote(s: string): string {
  const t = s.trim();
  const m = /^["“'](.*)["”']$/.exec(t);
  return (m ? m[1] : t) ?? t;
}

function targetLocator(text: string): Locator | undefined {
  const t = text.trim().replace(/^the\s+/i, "");
  let m = new RegExp(`^(${ROLE_RE})\\s+["“'](.+?)["”']$`, "i").exec(t);
  if (m) return { role: (m[1] as string).toLowerCase(), name: m[2] as string };
  m = new RegExp(`^["“'](.+?)["”']\\s+(${ROLE_RE})$`, "i").exec(t);
  if (m) return { role: (m[2] as string).toLowerCase(), name: m[1] as string };
  m = new RegExp(`^(${ROLE_RE})$`, "i").exec(t);
  if (m) return { role: (m[1] as string).toLowerCase() };
  m = /^["“'](.+?)["”']\s+(field|input|dropdown|select|checkbox)$/i.exec(t);
  if (m) return { label: m[1] as string };
  m = /^test ?id\s+["“'](.+?)["”']$/i.exec(t);
  if (m) return { testId: m[1] as string };
  m = /^["“'](.+?)["”']$/.exec(t);
  if (m) return { text: m[1] as string };
  return undefined;
}

function fieldLocator(text: string): Locator | undefined {
  const t = text.trim().replace(/^the\s+/i, "");
  const m = /^["“'](.+?)["”'](\s+(field|input|dropdown|select|checkbox|box))?$/i.exec(t);
  if (m) return { label: m[1] as string };
  return targetLocator(t);
}

/**
 * Deterministic step grammar (documented in docs/test-plan-format.md). Returns undefined for anything it
 * does not understand; the caller records it as an ambiguity instead of guessing.
 */
export function parseStepLine(line: string): TestStepInput | undefined {
  const s = line.trim().replace(/\.$/, "");
  let m: RegExpExecArray | null;

  if ((m = /^(?:navigate to|go to|open|visit)\s+(\S+)$/i.exec(s)))
    return { action: "navigate", url: unquote(m[1] as string) };
  if (/^go back$/i.test(s)) return { action: "go_back" };
  if (/^(reload|refresh)( the page)?$/i.test(s)) return { action: "reload" };

  if ((m = /^click(?: on)?\s+(.+)$/i.exec(s))) {
    const locator = targetLocator(m[1] as string);
    return locator ? { action: "click", locator } : undefined;
  }
  if ((m = /^(?:fill|enter)\s+(.+?)\s+with\s+(.+)$/i.exec(s))) {
    const locator = fieldLocator(m[1] as string);
    return locator ? { action: "fill", locator, value: unquote(m[2] as string) } : undefined;
  }
  if ((m = /^type\s+(.+?)\s+into\s+(.+)$/i.exec(s))) {
    const locator = fieldLocator(m[2] as string);
    return locator ? { action: "fill", locator, value: unquote(m[1] as string) } : undefined;
  }
  if ((m = /^clear\s+(.+)$/i.exec(s))) {
    const locator = fieldLocator(m[1] as string);
    return locator ? { action: "clear", locator } : undefined;
  }
  if ((m = /^select\s+(.+?)\s+(?:in|from)\s+(.+)$/i.exec(s))) {
    const locator = fieldLocator(m[2] as string);
    return locator ? { action: "select_option", locator, value: unquote(m[1] as string) } : undefined;
  }
  if ((m = /^(check|uncheck)\s+(.+)$/i.exec(s)) && !/^check that/i.test(s)) {
    const locator = fieldLocator(m[2] as string);
    const action = (m[1] as string).toLowerCase() as "check" | "uncheck";
    return locator ? { action, locator } : undefined;
  }
  if ((m = /^press\s+(?:the\s+)?(\S+?)(?:\s+key)?$/i.exec(s)))
    return { action: "press_key", key: unquote(m[1] as string) };
  if ((m = /^wait for\s+(.+?)(?:\s+to (?:be visible|appear))?$/i.exec(s))) {
    const locator = targetLocator(m[1] as string);
    return locator ? { action: "wait_for", locator } : undefined;
  }
  if (
    (m =
      /^(?:take|capture)\s+(?:a\s+)?screenshot(?:\s+(?:named|called))?\s*["“']?([a-z0-9][a-z0-9-_]*)?["”']?$/i.exec(
        s,
      ))
  ) {
    return { action: "screenshot", name: m[1] ?? "screenshot" };
  }
  if ((m = /^note:\s*(.+)$/i.exec(s))) return { action: "record_note", note: m[1] as string };

  const assertion = /^(?:verify|expect|assert|check|ensure|confirm)(?: that)?\s+(.+)$/i.exec(s);
  if (assertion) return parseAssertion(assertion[1] as string);
  return undefined;
}

function parseAssertion(body: string): TestStepInput | undefined {
  const b = body.trim();
  let m: RegExpExecArray | null;
  if (/^(there are )?no console errors$/i.test(b)) return { action: "assert_no_console_errors" };
  if (/^(there are )?no (network|request) failures$/i.test(b))
    return { action: "assert_no_network_failures" };
  if (/^(there is )?no horizontal overflow$/i.test(b)) return { action: "assert_no_horizontal_overflow" };
  if ((m = /^(?:the )?url contains\s+(.+)$/i.exec(b)))
    return { action: "assert_url_contains", value: unquote(m[1] as string) };
  if ((m = /^(?:the )?url (?:is|equals)\s+(.+)$/i.exec(b)))
    return { action: "assert_url_equals", value: unquote(m[1] as string) };
  if ((m = /^(.+?)\s+(?:contains|shows|displays)\s+["“'](.+)["”']$/i.exec(b))) {
    const locator = targetLocator(m[1] as string);
    return locator ? { action: "assert_text_contains", locator, text: m[2] as string } : undefined;
  }
  if ((m = /^(.+?)\s+(?:text )?(?:equals|reads)\s+["“'](.+)["”']$/i.exec(b))) {
    const locator = targetLocator(m[1] as string);
    return locator ? { action: "assert_text_equals", locator, text: m[2] as string } : undefined;
  }
  const stateMap: Record<
    string,
    "assert_visible" | "assert_hidden" | "assert_enabled" | "assert_disabled" | "assert_checked"
  > = {
    visible: "assert_visible",
    shown: "assert_visible",
    displayed: "assert_visible",
    hidden: "assert_hidden",
    "not visible": "assert_hidden",
    enabled: "assert_enabled",
    disabled: "assert_disabled",
    checked: "assert_checked",
  };
  if ((m = /^(.+?)\s+is\s+(visible|shown|displayed|hidden|not visible|enabled|disabled|checked)$/i.exec(b))) {
    const locator = fieldOrTarget(m[1] as string);
    const action = stateMap[(m[2] as string).toLowerCase()];
    return locator && action ? { action, locator } : undefined;
  }
  return undefined;
}

function fieldOrTarget(text: string): Locator | undefined {
  return /\b(field|input|dropdown|select|checkbox)$/i.test(text.trim())
    ? fieldLocator(text)
    : targetLocator(text);
}

interface DraftScenario {
  title: string;
  objective?: string;
  priority?: string;
  roles?: string[];
  viewports?: string[];
  expected?: string;
  steps: TestStepInput[];
}

/**
 * Deterministic natural-language compiler. It preserves the user's scope, steps, expectations and
 * restrictions, reports assumptions and ambiguities, and never invents accounts, credentials, routes,
 * scenarios, expected outcomes or risky permissions. The output is an editable TestPlan.
 */
export function compilePrompt(options: CompileOptions): CompileResult {
  const assumptions: string[] = [];
  const ambiguities: string[] = [];
  const restrictions: string[] = [];
  const droppedSteps: string[] = [];
  const lines = options.promptText.split(/\r?\n/);

  let name = "";
  let declaredDomains: string[] | undefined;
  const testData: Record<string, string | { value: string; secret: boolean }> = {};
  const scenarios: DraftScenario[] = [];
  let section: "none" | "testdata" | "scenario" | "restrictions" = "none";
  let current: DraftScenario | undefined;
  let inSteps = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^#\s+(.+)$/.exec(line))) {
      name = (m[1] as string).trim();
      continue;
    }
    if ((m = /^##\s+(.+)$/.exec(line))) {
      const heading = (m[1] as string).trim();
      inSteps = false;
      if (/^test data$/i.test(heading)) section = "testdata";
      else if (/^(restrictions|constraints|out of scope)$/i.test(heading)) section = "restrictions";
      else if ((m = /^scenario:?\s*(.+)$/i.exec(heading))) {
        section = "scenario";
        current = { title: (m[1] as string).trim(), steps: [] };
        scenarios.push(current);
      } else section = "none";
      continue;
    }
    if ((m = /^allowed domains?:\s*(.+)$/i.exec(line))) {
      declaredDomains = (m[1] as string)
        .split(/[,\s]+/)
        .map((d) => d.trim())
        .filter(Boolean);
      continue;
    }
    for (const hint of RISKY_PERMISSION_HINTS) {
      if (hint.re.test(line)) {
        ambiguities.push(
          `Prompt mentions allowing ${hint.label}; the compiler never grants risky permissions. Edit safety policy explicitly if intended.`,
        );
      }
    }
    if (/^(do not|don't|never|avoid)\b/i.test(line.replace(/^[-*]\s*/, ""))) {
      restrictions.push(line.replace(/^[-*]\s*/, ""));
      if (section === "restrictions") continue;
    }
    if (section === "restrictions") {
      restrictions.push(line.replace(/^[-*]\s*/, ""));
      continue;
    }
    if (section === "testdata") {
      if ((m = /^[-*]\s*([A-Za-z][A-Za-z0-9_]*)\s*(\((secret)\))?\s*:\s*(.+)$/.exec(line))) {
        const key = m[1] as string;
        const value = unquote(m[4] as string);
        testData[key] = m[3] ? { value, secret: true } : value;
      } else ambiguities.push(`Unrecognized test data line: "${line}"`);
      continue;
    }
    if (section === "scenario" && current) {
      if ((m = /^objective:\s*(.+)$/i.exec(line))) current.objective = m[1] as string;
      else if ((m = /^priority:\s*(.+)$/i.exec(line)))
        current.priority = (m[1] as string).trim().toLowerCase();
      else if ((m = /^roles?:\s*(.+)$/i.exec(line)))
        current.roles = (m[1] as string).split(/[,\s]+/).filter(Boolean);
      else if ((m = /^viewports?:\s*(.+)$/i.exec(line)))
        current.viewports = (m[1] as string).split(/[,\s]+/).filter(Boolean);
      else if ((m = /^(?:expected(?: outcome| result)?):\s*(.+)$/i.exec(line)))
        current.expected = m[1] as string;
      else if (/^steps:?$/i.test(line)) inSteps = true;
      else if ((m = /^(?:\d+[.)]|[-*])\s+(.+)$/.exec(line))) {
        inSteps = true;
        const step = parseStepLine(m[1] as string);
        if (step) current.steps.push(step);
        else {
          droppedSteps.push(`${current.title}: ${m[1]}`);
          ambiguities.push(`Scenario "${current.title}": step not understood and NOT included: "${m[1]}"`);
        }
      } else if (!inSteps) {
        current.objective = current.objective ? `${current.objective} ${line}` : line;
      } else ambiguities.push(`Scenario "${current.title}": ignored line "${line}"`);
    }
  }

  const url = new URL(options.url);
  const allowedDomains = options.allowedDomains?.length ? options.allowedDomains : declaredDomains;
  if (!allowedDomains?.length)
    assumptions.push(`allowedDomains defaulted to the target host only: ${url.hostname}`);
  if (!name) {
    name = `Test plan for ${url.hostname}`;
    assumptions.push(`plan name defaulted to "${name}"`);
  }

  const usedViewports = new Set<string>();
  const planScenarios = scenarios
    .map((sc) => {
      if (sc.steps.length === 0) {
        ambiguities.push(`Scenario "${sc.title}" has no understood steps and was not included`);
        return undefined;
      }
      if (!sc.expected)
        ambiguities.push(
          `Scenario "${sc.title}" has no "Expected:" line; expected outcome left as a review marker`,
        );
      if (!sc.objective) assumptions.push(`Scenario "${sc.title}": objective defaulted to the title`);
      let roles = (sc.roles ?? [])
        .map((r) => r.toLowerCase())
        .filter((r): r is AgentRole => {
          const ok = (AGENT_ROLES as string[]).includes(r);
          if (!ok) ambiguities.push(`Scenario "${sc.title}": unsupported role "${r}" ignored`);
          return ok;
        });
      if (roles.length === 0) {
        roles = ["functional"];
        assumptions.push(`Scenario "${sc.title}": roles defaulted to [functional]`);
      }
      let viewports = (sc.viewports ?? [])
        .map((v) => v.toLowerCase())
        .filter((v) => {
          const ok = v in KNOWN_VIEWPORTS;
          if (!ok)
            ambiguities.push(
              `Scenario "${sc.title}": unknown viewport "${v}" ignored (known: ${Object.keys(KNOWN_VIEWPORTS).join(", ")})`,
            );
          return ok;
        });
      if (viewports.length === 0) {
        viewports = ["desktop"];
        assumptions.push(`Scenario "${sc.title}": viewports defaulted to [desktop]`);
      }
      viewports.forEach((v) => usedViewports.add(v));
      const priority = ["critical", "high", "medium", "low"].includes(sc.priority ?? "")
        ? sc.priority
        : "medium";
      return {
        id: slugify(sc.title) || "scenario",
        title: sc.title,
        objective: sc.objective ?? sc.title,
        priority,
        roles,
        viewports,
        expectedOutcome: sc.expected ?? "REVIEW REQUIRED: no expected outcome was stated in the prompt",
        steps: sc.steps,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  if (planScenarios.length === 0) {
    throw new Error(
      "No scenarios could be compiled from the prompt. Use '## Scenario: <title>' headings with numbered steps (see docs/test-plan-format.md).",
    );
  }

  const viewports: Record<string, { width: number; height: number }> = {};
  for (const v of usedViewports) viewports[v] = KNOWN_VIEWPORTS[v] as { width: number; height: number };

  const input: TestPlanInput = {
    version: 1,
    id: slugify(name) || "compiled-plan",
    name,
    mode: "scripted",
    target: { url: options.url, allowedDomains: allowedDomains?.length ? allowedDomains : [url.hostname] },
    llm: { strategy: "disabled" },
    testData,
    viewports,
    scenarios: planScenarios as TestPlanInput["scenarios"],
    compilation: {
      compiledFrom: "natural-language",
      compiler: "heuristic",
      promptSha256: sha256(options.promptText),
      assumptions,
      ambiguities,
      restrictions,
      needsReview: ambiguities.length > 0,
    },
  };
  const plan = TestPlanSchema.parse(input);
  return { plan, assumptions, ambiguities, restrictions, droppedSteps, planHash: computePlanHash(plan) };
}

const LlmPlanDraftSchema = z
  .object({
    name: z.string(),
    scenarios: TestPlanSchema.shape.scenarios,
    testDataKeys: z.array(z.string()).default([]),
    ambiguities: z.array(z.string()).default([]),
  })
  .strict();

/**
 * Optional LLM-assisted compiler (used when a model is configured). The model may only structure what
 * the prompt says: target, domains, safety, budgets and test-data values are set by BrowserSwarm, never
 * by the model; every referenced test-data key must exist in the prompt's test data. The result is
 * always marked needsReview.
 */
export async function compilePromptWithLlm(
  options: CompileOptions & { client: LLMClient; model?: ModelRef; maxRepairAttempts?: number },
): Promise<CompileResult> {
  const base = (() => {
    try {
      return compilePrompt(options);
    } catch {
      return undefined;
    }
  })();
  // Test-data values (credentials, emails, ...) never reach the model: they are replaced by their key names.
  const redactor = createRedactor(
    Object.entries(base?.plan.testData ?? {}).map(([key, v]) => ({
      label: `testData.${key}`,
      value: (typeof v === "string" ? v : v.value) ?? "",
    })),
  );
  const system =
    "You convert a user's website testing request into BrowserSwarm scenarios. Output strict JSON only. " +
    "Include only scenarios, steps and expected outcomes the user explicitly wrote. Never invent routes, credentials, " +
    "accounts, scenarios or expected outcomes. Reference test data only as {{testData.<key>}}. List anything unclear in ambiguities.";
  const result = await generateStructured(
    options.client,
    {
      system,
      prompt: `Target URL: ${options.url}\n\nUser request:\n${redactor.redactString(options.promptText)}`,
      ...(options.model ? { model: options.model } : {}),
      metadata: { purpose: "plan_compilation" },
    },
    LlmPlanDraftSchema,
    options.maxRepairAttempts ?? 1,
  );
  const draft = result.value;
  const testData = base?.plan.testData ?? {};
  const ambiguities = [...(base?.ambiguities ?? []), ...draft.ambiguities];
  for (const key of draft.testDataKeys) {
    if (!(key in testData)) ambiguities.push(`Model referenced unknown test data "${key}"; it was not added`);
  }
  const url = new URL(options.url);
  const viewports: Record<string, { width: number; height: number }> = {};
  for (const sc of draft.scenarios)
    for (const v of sc.viewports) viewports[v] = KNOWN_VIEWPORTS[v] ?? { width: 1440, height: 900 };
  const plan = TestPlanSchema.parse({
    version: 1,
    id: slugify(draft.name) || "compiled-plan",
    name: draft.name,
    mode: "scripted",
    target: {
      url: options.url,
      allowedDomains: options.allowedDomains?.length
        ? options.allowedDomains
        : (base?.plan.target.allowedDomains ?? [url.hostname]),
    },
    llm: { strategy: "disabled" },
    testData,
    viewports,
    scenarios: draft.scenarios,
    compilation: {
      compiledFrom: "natural-language",
      compiler: "llm",
      promptSha256: sha256(options.promptText),
      assumptions: base?.assumptions ?? [],
      ambiguities,
      restrictions: base?.restrictions ?? [],
      needsReview: true,
    },
  } satisfies TestPlanInput);
  return {
    plan,
    assumptions: base?.assumptions ?? [],
    ambiguities,
    restrictions: base?.restrictions ?? [],
    droppedSteps: base?.droppedSteps ?? [],
    planHash: computePlanHash(plan),
  };
}
