import type { Locator, RiskCategory, RiskFlag, SafetyPolicy, TestStep } from "@browserswarm/core";
import { checkUrl, type DomainScope } from "./domains.js";

/**
 * Keyword rules applied to the accessible name / label / text / testId / css of the element a step
 * interacts with. Conservative by design: a false positive only requires an explicit policy opt-in.
 */
export const RISK_RULES: { category: RiskCategory; pattern: RegExp }[] = [
  { category: "deletion", pattern: /\b(delete|remove|destroy|erase|purge|deactivate|close account)\b/i },
  { category: "payment", pattern: /\b(pay|payment|pay now|submit payment|add card)\b/i },
  {
    category: "purchase",
    pattern: /\b(buy|purchase|place order|complete order|confirm order|subscribe|checkout now)\b/i,
  },
  { category: "account_creation", pattern: /\b(sign ?up|register|create (an )?account|join now)\b/i },
  { category: "file_upload", pattern: /\b(upload|attach file|choose file)\b/i },
  { category: "file_download", pattern: /\b(download|export (csv|pdf|file))\b/i },
  { category: "invitation", pattern: /\b(invite|send invitation)\b/i },
  {
    category: "email_sms_sending",
    pattern: /\b(send( (email|sms|message|code|link))?|resend|email me|text me)\b/i,
  },
  { category: "password_change", pattern: /\b(change|reset|update|set new) password\b/i },
  { category: "social_posting", pattern: /\b(post|publish|tweet|share to)\b/i },
  { category: "data_modification", pattern: /\b(save changes|update profile|overwrite|transfer)\b/i },
  { category: "irreversible", pattern: /\b(irreversible|permanently|cannot be undone)\b/i },
];

/** Actions that can trigger a side effect on the element they target. */
const EFFECTFUL_ACTIONS = new Set<TestStep["action"]>([
  "click",
  "press_key",
  "check",
  "uncheck",
  "select_option",
]);

function locatorText(locator: Locator | undefined): string {
  if (!locator) return "";
  return [locator.name, locator.label, locator.text, locator.testId, locator.placeholder, locator.css]
    .filter(Boolean)
    .join(" ")
    .replace(/[-_]/g, " ");
}

export function isCategoryAllowed(category: RiskCategory, safety: SafetyPolicy): boolean {
  const destructiveOk = safety.destructiveActions === "allow-with-approval";
  switch (category) {
    case "account_creation":
      return safety.allowAccountCreation;
    case "purchase":
    case "payment":
      return safety.allowPurchases;
    case "file_upload":
      return safety.allowUploads;
    case "file_download":
      return safety.allowFileDownloads;
    case "email_sms_sending":
      return safety.allowEmailSending;
    case "password_change":
      return safety.allowPasswordChanges && destructiveOk;
    case "invitation":
      return safety.allowInvitations;
    case "social_posting":
      return safety.allowSocialPosting;
    case "authentication":
      return safety.allowAuthentication;
    case "deletion":
    case "data_modification":
    case "irreversible":
      return destructiveOk;
    case "tool_evaluate":
    case "tool_admin":
      return true;
    case "external_navigation":
      // Navigation is always constrained to allowedDomains; there is no opt-out.
      return false;
  }
  return false;
}

export interface ClassifyContext extends DomainScope {
  scenarioId: string;
  targetUrl: string;
  safety: SafetyPolicy;
}

/** Static risk classification of a single approved step. */
export function classifyStep(step: TestStep, stepIndex: number, ctx: ClassifyContext): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const push = (category: RiskCategory, reason: string) =>
    flags.push({
      scenarioId: ctx.scenarioId,
      stepIndex,
      action: step.action,
      category,
      reason,
      allowedByPolicy: isCategoryAllowed(category, ctx.safety),
    });

  if (step.action === "navigate") {
    const check = checkUrl(step.url, ctx.targetUrl, ctx);
    if (!check.allowed) push("external_navigation", check.reason ?? "navigation outside allowed domains");
    return flags;
  }

  if (EFFECTFUL_ACTIONS.has(step.action)) {
    const text = locatorText("locator" in step ? step.locator : undefined);
    const seen = new Set<RiskCategory>();
    for (const rule of RISK_RULES) {
      if (!seen.has(rule.category) && rule.pattern.test(text)) {
        seen.add(rule.category);
        push(
          rule.category,
          `${step.action} on element matching "${text.trim()}" looks like ${rule.category}`,
        );
      }
    }
  }
  return flags;
}

export function summarizeSafety(safety: SafetyPolicy): string[] {
  const s: string[] = [];
  s.push("External navigation: blocked (allowed domains only)");
  s.push(`Account creation: ${safety.allowAccountCreation ? "allowed with risk approval" : "blocked"}`);
  s.push(`Purchases/payment: ${safety.allowPurchases ? "allowed with risk approval" : "blocked"}`);
  s.push(
    `File upload/download: ${safety.allowUploads || safety.allowFileDownloads ? "partially allowed with risk approval" : "blocked"}`,
  );
  s.push(`Email/SMS sending: ${safety.allowEmailSending ? "allowed with risk approval" : "blocked"}`);
  s.push(
    `Destructive actions: ${safety.destructiveActions === "allow-with-approval" ? "allowed with risk approval" : "blocked"}`,
  );
  s.push(`Authentication: ${safety.allowAuthentication ? "allowed" : "no successful sign-in expected"}`);
  s.push(`Active security testing: ${safety.allowSecuritySmoke ? "passive smoke only" : "blocked"}`);
  s.push(`Sensitive-data redaction: ${safety.redactSensitiveData ? "enabled" : "DISABLED"}`);
  return s;
}
