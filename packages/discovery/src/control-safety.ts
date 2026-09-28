import { RISK_RULES } from "@browserswarm/policy-engine";

/**
 * Discovery-time control classification. The Discovery Lead Agent may only invoke controls classified as
 * safe; everything else is recorded as a restricted candidate and never clicked. Unknown controls default
 * to restricted: a false positive costs coverage, a false negative could change the site's state.
 */
export type ControlSafety =
  | { kind: "safe-navigation"; authPage: boolean }
  | { kind: "safe-toggle" }
  | { kind: "safe-pagination" }
  | { kind: "restricted"; category: string; reason: string };

export interface ControlDescriptor {
  tag: string;
  role?: string | null;
  type?: string | null;
  label: string;
  href?: string | null;
  download?: boolean;
  inForm?: boolean;
  ariaExpanded?: string | null;
  ariaControls?: boolean;
  ariaHasPopup?: string | null;
  inPagination?: boolean;
}

/** Verbs that indicate a state change, submission, transfer or irreversible action (discovery policy). */
export const DISCOVERY_RESTRICTED_RULES: { category: string; pattern: RegExp }[] = [
  { category: "authentication", pattern: /\b(log ?out|sign ?out|log ?off|sign ?off)\b/i },
  { category: "file_upload", pattern: /\b(upload|attach|import)\b/i },
  { category: "file_download", pattern: /\b(download|export|print)\b/i },
  {
    category: "purchase",
    pattern: /\b(add to (cart|bag|basket|wishlist)|buy|checkout|check out|order|purchase|pay)\b/i,
  },
  { category: "booking", pattern: /\b(book|reserve|reservation|enrol|enroll|register for|rsvp)\b/i },
  {
    category: "subscription",
    pattern:
      /\b(subscribe|unsubscribe|cancel( (subscription|plan|membership|order))?|renew|upgrade|downgrade)\b/i,
  },
  {
    category: "deletion",
    pattern: /\b(delete|remove|destroy|erase|purge|deactivate|trash|discard|clear all)\b/i,
  },
  { category: "invitation", pattern: /\b(invite|share)\b/i },
  { category: "email_sms_sending", pattern: /\b(send|resend|email me|text me|notify|contact us now)\b/i },
  {
    category: "social_posting",
    pattern: /\b(post|publish|tweet|comment|reply|review|rate|vote|like|follow|report|flag)\b/i,
  },
  {
    category: "data_modification",
    pattern:
      /\b(create|add|new|save|submit|edit|update|apply|confirm|approve|reject|accept|decline|archive|restore|claim|redeem|donate|transfer|start|stop|pause|resume|deploy|execute|run|launch|reset|change|set|assign|move|copy|duplicate|generate)\b/i,
  },
];

/** Links that open authentication pages. Visiting the page is a read-only GET; submitting is never allowed. */
const AUTH_PAGE =
  /\b(log ?in|sign ?in|sign ?up|register|create (an )?account|forgot( your)? password|reset password|join)\b/i;

/** Destinations that look like downloads rather than pages. */
const DOWNLOAD_EXT =
  /\.(pdf|zip|gz|tgz|rar|7z|csv|xlsx?|docx?|pptx?|exe|dmg|msi|apk|iso|mp4|mov|mp3|wav)(\?|$)/i;

/** Side-effect words inside a URL path or query (e.g. /cart/add, ?action=delete, /logout). */
const RESTRICTED_URL =
  /(^|[/?&=_-])(logout|log-out|signout|sign-out|delete|remove|destroy|unsubscribe|subscribe|cancel|checkout|cart\/add|add-to-cart|addtocart|purchase|pay|order\/(new|create|place)|confirm|approve|invite|upload|download|export|reset|deactivate|vote|like|follow)([/?&=_.-]|$)/i;

const PAGINATION_LABEL =
  /^(next|previous|prev|older|newer|first|last|load more|show more|more results|page \d+|\d{1,4}|[‹›«»<>]+)$/i;

function firstMatch(text: string, rules: { category: string; pattern: RegExp }[]) {
  for (const rule of rules) if (rule.pattern.test(text)) return rule;
  return undefined;
}

/** Normalized label for matching: separators become spaces so "delete_item" matches "delete". */
function norm(s: string | null | undefined): string {
  return (s ?? "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function classifyControl(c: ControlDescriptor): ControlSafety {
  const label = norm(c.label);
  const riskRule = RISK_RULES.find((r) => r.pattern.test(label));
  const tag = c.tag.toLowerCase();
  const role = (c.role ?? "").toLowerCase();

  if (tag === "input" && (c.type ?? "").toLowerCase() === "file")
    return {
      kind: "restricted",
      category: "file_upload",
      reason: "file input (uploads are never used during discovery)",
    };

  const isLink = tag === "a" || role === "link";
  if (isLink) {
    const href = c.href ?? "";
    if (!href || /^(javascript|mailto|tel|sms|data|blob):/i.test(href))
      return {
        kind: "restricted",
        category: "non-navigational-link",
        reason: `link target "${href.slice(0, 60)}" is not a page`,
      };
    if (c.download || DOWNLOAD_EXT.test(href))
      return { kind: "restricted", category: "file_download", reason: "link points to a file download" };
    const logout = DISCOVERY_RESTRICTED_RULES[0] as { category: string; pattern: RegExp };
    if (logout.pattern.test(label) || /log-?out|sign-?out/i.test(href))
      return { kind: "restricted", category: "authentication", reason: "logout link" };
    let pathAndQuery = href;
    try {
      const u = new URL(href);
      pathAndQuery = `${u.pathname}${u.search}`;
    } catch {
      /* relative or unparseable: match as-is */
    }
    if (RESTRICTED_URL.test(pathAndQuery))
      return {
        kind: "restricted",
        category: "side-effect-url",
        reason: `link URL suggests a state change (${pathAndQuery.slice(0, 80)})`,
      };
    if (AUTH_PAGE.test(label)) return { kind: "safe-navigation", authPage: true };
    if (c.inPagination || PAGINATION_LABEL.test(label)) return { kind: "safe-pagination" };
    const rule = firstMatch(label, DISCOVERY_RESTRICTED_RULES.slice(1));
    // Links rarely change state, but a link labelled "Add to cart" or "Delete" may be a GET with side effects.
    if (
      rule &&
      /purchase|deletion|subscription|booking|file_|invitation|email_sms|social_posting/.test(rule.category)
    )
      return {
        kind: "restricted",
        category: rule.category,
        reason: `link label "${label.slice(0, 60)}" indicates ${rule.category}`,
      };
    return { kind: "safe-navigation", authPage: false };
  }

  // Buttons and other controls.
  if (riskRule)
    return {
      kind: "restricted",
      category: riskRule.category,
      reason: `label "${label.slice(0, 60)}" indicates ${riskRule.category}`,
    };
  const rule = firstMatch(label, DISCOVERY_RESTRICTED_RULES);
  if (rule)
    return {
      kind: "restricted",
      category: rule.category,
      reason: `label "${label.slice(0, 60)}" indicates ${rule.category}`,
    };
  const type = (c.type ?? "").toLowerCase();
  if (
    type === "submit" ||
    type === "reset" ||
    (tag === "button" && !type && c.inForm) ||
    (tag === "input" && type === "image")
  )
    return { kind: "restricted", category: "form_submission", reason: "form submission control" };
  if (role === "tab") return { kind: "safe-toggle" };
  if (tag === "summary") return { kind: "safe-toggle" };
  if (c.ariaExpanded === "true" || c.ariaExpanded === "false") {
    // Disclosure/accordion/menu toggles only reveal content that is already on the page.
    return { kind: "safe-toggle" };
  }
  if (c.inPagination || (PAGINATION_LABEL.test(label) && label.length > 0))
    return { kind: "safe-pagination" };
  return {
    kind: "restricted",
    category: "unknown-effect",
    reason: "control effect cannot be determined safely",
  };
}

/** Labels of cookie-banner buttons that decline optional tracking. Accepting consent is never automated. */
export const COOKIE_DECLINE =
  /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|(use |allow )?(only )?(strictly )?(necessary|essential|required)( cookies)?( only)?|continue without accepting)$/i;

export function isCookieDeclineLabel(label: string): boolean {
  return COOKIE_DECLINE.test(norm(label));
}
