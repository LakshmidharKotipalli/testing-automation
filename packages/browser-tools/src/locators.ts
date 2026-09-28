import type { Locator } from "@browserswarm/core";
import type { Locator as PwLocator, Page } from "playwright";

type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Resolves a BrowserSwarm locator to a Playwright locator. Precedence (first present wins):
 * role(+name) > label > placeholder > testId > text > css. CSS is an explicit fallback only.
 */
export function resolveLocator(page: Page, locator: Locator): PwLocator {
  const exact = locator.exact ?? false;
  let loc: PwLocator;
  if (locator.role) {
    loc = page.getByRole(locator.role as AriaRole, locator.name ? { name: locator.name, exact } : {});
  } else if (locator.label) {
    loc = page.getByLabel(locator.label, { exact });
  } else if (locator.placeholder) {
    loc = page.getByPlaceholder(locator.placeholder, { exact });
  } else if (locator.testId) {
    loc = page.getByTestId(locator.testId);
  } else if (locator.text) {
    loc = page.getByText(locator.text, { exact });
  } else if (locator.css) {
    loc = page.locator(locator.css);
  } else {
    throw new Error("locator has no strategy");
  }
  return locator.nth !== undefined ? loc.nth(locator.nth) : loc;
}

/** Locator used for single-element actions: explicit nth, otherwise the first match. */
export function resolveSingle(page: Page, locator: Locator): PwLocator {
  const loc = resolveLocator(page, locator);
  return locator.nth !== undefined ? loc : loc.first();
}
