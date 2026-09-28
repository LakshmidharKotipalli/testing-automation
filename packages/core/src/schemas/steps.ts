import { z } from "zod";

/**
 * Element locator. Resolution precedence (first present wins): role(+name), label, placeholder,
 * testId, text, css. CSS is an explicit fallback only; validation warns when it is the sole strategy.
 */
export const LocatorSchema = z
  .object({
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    exact: z.boolean().optional(),
    label: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
    testId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    css: z.string().min(1).optional(),
    nth: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((l) => Boolean(l.role || l.label || l.placeholder || l.testId || l.text || l.css), {
    message: "locator requires one of role, label, placeholder, testId, text, css",
  })
  .refine((l) => !(l.name && !l.role), { message: "locator.name requires locator.role" });
export type Locator = z.infer<typeof LocatorSchema>;

const base = {
  description: z.string().max(500).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
};

const withLocator = { ...base, locator: LocatorSchema };

const s = <A extends string, S extends z.ZodRawShape>(action: A, shape: S) =>
  z.object({ action: z.literal(action), ...shape }).strict();

export const NavigateStep = s("navigate", { ...base, url: z.string().min(1) });
export const GoBackStep = s("go_back", base);
export const ReloadStep = s("reload", base);

export const ClickStep = s("click", withLocator);
export const FillStep = s("fill", { ...withLocator, value: z.string() });
export const ClearStep = s("clear", withLocator);
export const SelectOptionStep = s("select_option", { ...withLocator, value: z.string().min(1) });
export const CheckStep = s("check", withLocator);
export const UncheckStep = s("uncheck", withLocator);
export const PressKeyStep = s("press_key", {
  ...base,
  key: z.string().min(1),
  locator: LocatorSchema.optional(),
});
export const ScrollStep = s("scroll", {
  ...base,
  locator: LocatorSchema.optional(),
  direction: z.enum(["down", "up"]).default("down"),
  amount: z.number().int().min(1).max(20_000).default(600),
});
export const WaitForStep = s("wait_for", {
  ...base,
  locator: LocatorSchema.optional(),
  state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
  urlContains: z.string().optional(),
});

export const AssertVisibleStep = s("assert_visible", withLocator);
export const AssertHiddenStep = s("assert_hidden", withLocator);
export const AssertTextContainsStep = s("assert_text_contains", { ...withLocator, text: z.string().min(1) });
export const AssertTextEqualsStep = s("assert_text_equals", { ...withLocator, text: z.string() });
export const AssertUrlContainsStep = s("assert_url_contains", { ...base, value: z.string().min(1) });
export const AssertUrlEqualsStep = s("assert_url_equals", { ...base, value: z.string().min(1) });
export const AssertEnabledStep = s("assert_enabled", withLocator);
export const AssertDisabledStep = s("assert_disabled", withLocator);
export const AssertCheckedStep = s("assert_checked", withLocator);
export const AssertCountStep = s("assert_count", { ...withLocator, count: z.number().int().min(0) });
export const AssertResponseStatusStep = s("assert_response_status", {
  ...base,
  urlContains: z.string().min(1),
  status: z.number().int().min(100).max(599),
});
export const AssertNoConsoleErrorsStep = s("assert_no_console_errors", base);
export const AssertNoNetworkFailuresStep = s("assert_no_network_failures", base);
export const AssertNoHorizontalOverflowStep = s("assert_no_horizontal_overflow", base);

export const ScreenshotStep = s("screenshot", {
  ...base,
  name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i),
  fullPage: z.boolean().default(false),
});
export const SnapshotDomStep = s("snapshot_dom", {
  ...base,
  name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i),
  locator: LocatorSchema.optional(),
});
export const RecordNoteStep = s("record_note", { ...base, note: z.string().min(1).max(1000) });

export const RunAccessibilityScanStep = s("run_accessibility_scan", {
  ...base,
  tags: z.array(z.string()).optional(),
  include: z.string().optional(),
});
export const InspectConsoleLogsStep = s("inspect_console_logs", base);
export const InspectNetworkFailuresStep = s("inspect_network_failures", base);
export const InspectAccessibilityTreeStep = s("inspect_accessibility_tree", {
  ...base,
  locator: LocatorSchema.optional(),
});

export const TestStepSchema = z.discriminatedUnion("action", [
  NavigateStep,
  GoBackStep,
  ReloadStep,
  ClickStep,
  FillStep,
  ClearStep,
  SelectOptionStep,
  CheckStep,
  UncheckStep,
  PressKeyStep,
  ScrollStep,
  WaitForStep,
  AssertVisibleStep,
  AssertHiddenStep,
  AssertTextContainsStep,
  AssertTextEqualsStep,
  AssertUrlContainsStep,
  AssertUrlEqualsStep,
  AssertEnabledStep,
  AssertDisabledStep,
  AssertCheckedStep,
  AssertCountStep,
  AssertResponseStatusStep,
  AssertNoConsoleErrorsStep,
  AssertNoNetworkFailuresStep,
  AssertNoHorizontalOverflowStep,
  ScreenshotStep,
  SnapshotDomStep,
  RecordNoteStep,
  RunAccessibilityScanStep,
  InspectConsoleLogsStep,
  InspectNetworkFailuresStep,
  InspectAccessibilityTreeStep,
]);
export type TestStep = z.infer<typeof TestStepSchema>;
export type TestStepInput = z.input<typeof TestStepSchema>;
export type StepAction = TestStep["action"];

export const STEP_ACTIONS = TestStepSchema.options.map((o) => o.shape.action.value) as StepAction[];

export const ACTION_CATEGORY: Record<
  StepAction,
  "navigation" | "interaction" | "assertion" | "artifact" | "quality"
> = {
  navigate: "navigation",
  go_back: "navigation",
  reload: "navigation",
  click: "interaction",
  fill: "interaction",
  clear: "interaction",
  select_option: "interaction",
  check: "interaction",
  uncheck: "interaction",
  press_key: "interaction",
  scroll: "interaction",
  wait_for: "interaction",
  assert_visible: "assertion",
  assert_hidden: "assertion",
  assert_text_contains: "assertion",
  assert_text_equals: "assertion",
  assert_url_contains: "assertion",
  assert_url_equals: "assertion",
  assert_enabled: "assertion",
  assert_disabled: "assertion",
  assert_checked: "assertion",
  assert_count: "assertion",
  assert_response_status: "assertion",
  assert_no_console_errors: "assertion",
  assert_no_network_failures: "assertion",
  assert_no_horizontal_overflow: "assertion",
  screenshot: "artifact",
  snapshot_dom: "artifact",
  record_note: "artifact",
  run_accessibility_scan: "quality",
  inspect_console_logs: "quality",
  inspect_network_failures: "quality",
  inspect_accessibility_tree: "quality",
};

/** Actions that change page/session state; used for minimal deterministic replay after failed restoration. */
export function isStateChangingAction(action: StepAction): boolean {
  const category = ACTION_CATEGORY[action];
  return (
    category === "navigation" || (category === "interaction" && action !== "wait_for" && action !== "scroll")
  );
}

/** Short, human-readable, secret-free description of a step (templates are left unresolved). */
export function describeStep(step: TestStep): string {
  if (step.description) return step.description;
  const loc = "locator" in step && step.locator ? ` ${describeLocator(step.locator)}` : "";
  switch (step.action) {
    case "navigate":
      return `Navigate to ${step.url}`;
    case "fill":
      return `Fill${loc} with ${step.value.startsWith("{{") ? step.value : "provided value"}`;
    case "assert_text_contains":
      return `Assert${loc} contains "${step.text}"`;
    case "assert_text_equals":
      return `Assert${loc} equals "${step.text}"`;
    case "assert_url_contains":
      return `Assert URL contains ${step.value}`;
    case "assert_url_equals":
      return `Assert URL equals ${step.value}`;
    case "assert_count":
      return `Assert${loc} count is ${step.count}`;
    case "press_key":
      return `Press ${step.key}${loc}`;
    case "screenshot":
      return `Screenshot "${step.name}"`;
    case "record_note":
      return `Note: ${step.note}`;
    default:
      return `${step.action}${loc}`;
  }
}

export function describeLocator(locator: Locator): string {
  if (locator.role) return locator.name ? `${locator.role} "${locator.name}"` : `${locator.role}`;
  if (locator.label) return `label "${locator.label}"`;
  if (locator.placeholder) return `placeholder "${locator.placeholder}"`;
  if (locator.testId) return `testId "${locator.testId}"`;
  if (locator.text) return `text "${locator.text}"`;
  return `css "${locator.css ?? ""}"`;
}
