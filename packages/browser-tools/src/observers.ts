import type { Redactor } from "@browserswarm/shared";
import { truncate } from "@browserswarm/shared";
import type { BrowserContext, Page } from "playwright";
import { checkUrl, type DomainScope } from "@browserswarm/policy-engine";

export interface ConsoleEntry {
  type: string;
  text: string;
  url: string;
  at: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  failure?: string;
  resourceType: string;
  at: string;
}

export interface BlockedRequest {
  url: string;
  reason: string;
  isNavigation: boolean;
  at: string;
}

/** Collects console errors, page errors, failed requests and HTTP error responses for one page. */
export class PageObservers {
  readonly console: ConsoleEntry[] = [];
  readonly network: NetworkEntry[] = [];
  readonly responses: { url: string; status: number; at: string }[] = [];

  constructor(
    private readonly redactor: Redactor,
    private readonly maxEntries = 500,
  ) {}

  attach(page: Page): void {
    const now = () => new Date().toISOString();
    const r = (s: string) => truncate(this.redactor.redactString(s), 1000);
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        this.push(this.console, { type: msg.type(), text: r(msg.text()), url: r(page.url()), at: now() });
      }
    });
    page.on("pageerror", (err) =>
      this.push(this.console, { type: "pageerror", text: r(err.message), url: r(page.url()), at: now() }),
    );
    page.on("requestfailed", (req) =>
      this.push(this.network, {
        url: r(req.url()),
        method: req.method(),
        failure: req.failure()?.errorText ?? "failed",
        resourceType: req.resourceType(),
        at: now(),
      }),
    );
    page.on("response", (res) => {
      this.push(this.responses, { url: r(res.url()), status: res.status(), at: now() });
      if (res.status() >= 400) {
        this.push(this.network, {
          url: r(res.url()),
          method: res.request().method(),
          status: res.status(),
          resourceType: res.request().resourceType(),
          at: now(),
        });
      }
    });
  }

  consoleErrors(): ConsoleEntry[] {
    return this.console.filter((c) => c.type === "error" || c.type === "pageerror");
  }

  networkFailures(): NetworkEntry[] {
    return this.network;
  }

  private push<T>(list: T[], entry: T): void {
    if (list.length < this.maxEntries) list.push(entry);
  }
}

/**
 * Context-level network guard: every request (navigation, fetch, subresource) to a host outside the
 * allowed domains is aborted before it leaves the browser.
 */
export async function installDomainGuard(
  context: BrowserContext,
  scope: DomainScope,
  base: string,
  onBlocked: (b: BlockedRequest) => void,
): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const check = checkUrl(request.url(), base, scope);
    if (check.allowed) {
      await route.continue();
      return;
    }
    onBlocked({
      url: request.url(),
      reason: check.reason ?? "outside allowed domains",
      isNavigation: request.isNavigationRequest(),
      at: new Date().toISOString(),
    });
    await route.abort("blockedbyclient");
  });
}
