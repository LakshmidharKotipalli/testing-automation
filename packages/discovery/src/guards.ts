import { checkUrl, type DomainScope } from "@browserswarm/policy-engine";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright";

export interface DiscoveryBlockedRequest {
  url: string;
  method: string;
  reason: string;
  kind: "external" | "non-read-method" | "popup" | "dialog" | "download" | "file-chooser";
  isNavigation: boolean;
  at: string;
}

/** Browser-context options that make discovery read-only by construction. */
export const READ_ONLY_CONTEXT_OPTIONS: BrowserContextOptions = {
  acceptDownloads: false,
  serviceWorkers: "block",
  permissions: [],
};

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Context-level guard for the discovery phase. Every request is checked before it leaves the browser:
 * - hosts outside the allowed domains are aborted (external navigation is never followed);
 * - any non-GET/HEAD request (form posts, fetch/XHR writes, beacons, preflights) is aborted, so no
 *   discovered page can persist data even if a control is misclassified.
 * Popups are closed, dialogs dismissed and file choosers ignored. Every block is recorded.
 */
export async function installReadOnlyGuard(
  context: BrowserContext,
  scope: DomainScope,
  base: string,
  onBlocked: (b: DiscoveryBlockedRequest) => void,
  isMainPage: (p: Page) => boolean,
): Promise<void> {
  const now = () => new Date().toISOString();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const check = checkUrl(request.url(), base, scope);
    if (!check.allowed) {
      onBlocked({
        url: request.url(),
        method,
        reason: check.reason ?? "outside allowed domains",
        kind: "external",
        isNavigation: request.isNavigationRequest(),
        at: now(),
      });
      await route.abort("blockedbyclient");
      return;
    }
    if (!READ_METHODS.has(method)) {
      onBlocked({
        url: request.url(),
        method,
        reason: `${method} requests are blocked during read-only discovery`,
        kind: "non-read-method",
        isNavigation: request.isNavigationRequest(),
        at: now(),
      });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  context.on("page", (p) => {
    if (isMainPage(p)) return;
    onBlocked({
      url: p.url(),
      method: "GET",
      reason: "popup/new window closed",
      kind: "popup",
      isNavigation: true,
      at: now(),
    });
    void p.close().catch(() => undefined);
  });
}

/** Per-page handlers: dismiss dialogs (never accept), ignore file choosers and downloads. */
export function guardPage(page: Page, onBlocked: (b: DiscoveryBlockedRequest) => void): void {
  const now = () => new Date().toISOString();
  page.on("dialog", (dialog) => {
    onBlocked({
      url: page.url(),
      method: "-",
      reason: `dialog (${dialog.type()}) dismissed`,
      kind: "dialog",
      isNavigation: false,
      at: now(),
    });
    void dialog.dismiss().catch(() => undefined);
  });
  page.on("filechooser", () =>
    onBlocked({
      url: page.url(),
      method: "-",
      reason: "file chooser ignored",
      kind: "file-chooser",
      isNavigation: false,
      at: now(),
    }),
  );
  page.on("download", (download) => {
    onBlocked({
      url: download.url(),
      method: "GET",
      reason: "download cancelled",
      kind: "download",
      isNavigation: false,
      at: now(),
    });
    void download.cancel().catch(() => undefined);
  });
}
