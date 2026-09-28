import {
  DEFERRED_ACTIONS,
  type Evidence,
  type Locator,
  type TestStep,
  type WorkPacket,
} from "@browserswarm/core";
import { checkUrl } from "@browserswarm/policy-engine";
import { newId, padSequence, truncate, type Redactor } from "@browserswarm/shared";
import type { StorageAdapter } from "@browserswarm/storage";
import type { Page } from "playwright";
import { resolveLocator, resolveSingle } from "./locators.js";
import type { PageObservers } from "./observers.js";

export interface StepExecutionContext {
  page: Page;
  packet: WorkPacket;
  observers: PageObservers;
  storage: StorageAdapter;
  redactor: Redactor;
  /** Resolves {{testData.*}} / {{runId}} templates at the last moment; resolved values are never persisted. */
  resolveValue: (value: string) => string;
}

export interface StepOutcome {
  status: "passed" | "failed" | "skipped";
  summary: string;
  error?: string;
  expected?: string;
  actual?: string;
  evidence: string[];
  skipReason?: string;
  /** Locator-not-found style failures are the only ones eligible for a (future) LLM fallback. */
  failureKind?: "locator_not_found" | "assertion" | "navigation" | "policy" | "error";
}

class AssertionFailure extends Error {
  constructor(
    message: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(message);
  }
}

async function poll(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return true;
    } catch {
      /* element may be detached mid-poll; retry */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function packetPath(packet: WorkPacket, rel: string): string {
  return `${packet.artifactDir}/${rel}`;
}

/**
 * Executes exactly one approved, typed step against the page. There is no generic "evaluate JavaScript"
 * action: the only page evaluation is the fixed horizontal-overflow measurement below.
 */
export async function executeStep(
  ctx: StepExecutionContext,
  step: TestStep,
  index: number,
): Promise<StepOutcome> {
  const { page, packet } = ctx;
  const timeout = step.timeoutMs ?? packet.browser.actionTimeoutMs;
  const r = (s: string) => ctx.redactor.redactString(s);
  const single = (l: Locator) => resolveSingle(page, l);
  const evidence: string[] = [];

  const deferred = DEFERRED_ACTIONS[step.action];
  if (deferred) {
    return {
      status: "skipped",
      summary: `${step.action} is scheduled for Milestone ${deferred}`,
      skipReason: `not_implemented_in_milestone_1 (available in Milestone ${deferred})`,
      evidence,
    };
  }

  try {
    switch (step.action) {
      case "navigate": {
        const target = checkUrl(ctx.resolveValue(step.url), packet.targetUrl, packet);
        if (!target.allowed || !target.url) {
          return {
            status: "failed",
            summary: `Navigation blocked`,
            error: target.reason,
            evidence,
            failureKind: "policy",
          };
        }
        await page.goto(target.url, { timeout: packet.browser.navigationTimeoutMs, waitUntil: "load" });
        return { status: "passed", summary: `Opened ${r(new URL(page.url()).pathname)}`, evidence };
      }
      case "go_back":
        await page.goBack({ timeout: packet.browser.navigationTimeoutMs });
        return { status: "passed", summary: "Navigated back", evidence };
      case "reload":
        await page.reload({ timeout: packet.browser.navigationTimeoutMs });
        return { status: "passed", summary: "Reloaded page", evidence };
      case "click":
        await single(step.locator).click({ timeout });
        return { status: "passed", summary: `Clicked ${describe(step.locator)}`, evidence };
      case "fill":
        await single(step.locator).fill(ctx.resolveValue(step.value), { timeout });
        return {
          status: "passed",
          summary: `Filled ${describe(step.locator)} with ${step.value.includes("{{") ? "approved test value (redacted)" : "literal value"}`,
          evidence,
        };
      case "clear":
        await single(step.locator).clear({ timeout });
        return { status: "passed", summary: `Cleared ${describe(step.locator)}`, evidence };
      case "select_option":
        await single(step.locator).selectOption(ctx.resolveValue(step.value), { timeout });
        return { status: "passed", summary: `Selected option in ${describe(step.locator)}`, evidence };
      case "check":
        await single(step.locator).check({ timeout });
        return { status: "passed", summary: `Checked ${describe(step.locator)}`, evidence };
      case "uncheck":
        await single(step.locator).uncheck({ timeout });
        return { status: "passed", summary: `Unchecked ${describe(step.locator)}`, evidence };
      case "press_key":
        if (step.locator) await single(step.locator).press(step.key, { timeout });
        else await page.keyboard.press(step.key);
        return { status: "passed", summary: `Pressed ${step.key}`, evidence };
      case "scroll": {
        const delta = step.direction === "up" ? -step.amount : step.amount;
        if (step.locator) await single(step.locator).scrollIntoViewIfNeeded({ timeout });
        else await page.mouse.wheel(0, delta);
        return {
          status: "passed",
          summary: step.locator ? `Scrolled to ${describe(step.locator)}` : `Scrolled ${step.direction}`,
          evidence,
        };
      }
      case "wait_for": {
        if (step.urlContains) {
          const needle = ctx.resolveValue(step.urlContains);
          const ok = await poll(async () => page.url().includes(needle), timeout);
          if (!ok)
            throw new AssertionFailure("URL condition not met", `URL containing ${needle}`, r(page.url()));
        }
        if (step.locator) await single(step.locator).waitFor({ state: step.state, timeout });
        return { status: "passed", summary: "Wait condition met", evidence };
      }
      case "assert_visible":
        await single(step.locator).waitFor({ state: "visible", timeout });
        return { status: "passed", summary: `${describe(step.locator)} is visible`, evidence };
      case "assert_hidden":
        await single(step.locator).waitFor({ state: "hidden", timeout });
        return { status: "passed", summary: `${describe(step.locator)} is hidden`, evidence };
      case "assert_text_contains":
      case "assert_text_equals": {
        const expected = ctx.resolveValue(step.text);
        const loc = single(step.locator);
        await loc.waitFor({ state: "attached", timeout });
        let actual = "";
        const ok = await poll(async () => {
          actual = (await loc.innerText({ timeout: 1000 })).trim();
          return step.action === "assert_text_contains"
            ? actual.includes(expected)
            : actual === expected.trim();
        }, timeout);
        if (!ok) {
          throw new AssertionFailure(
            `${describe(step.locator)} text ${step.action === "assert_text_contains" ? "does not contain" : "does not equal"} expected`,
            r(expected),
            truncate(r(actual), 300),
          );
        }
        return {
          status: "passed",
          summary: `${describe(step.locator)} text matches "${r(expected)}"`,
          evidence,
        };
      }
      case "assert_url_contains":
      case "assert_url_equals": {
        const expected = ctx.resolveValue(step.value);
        const ok = await poll(
          async () =>
            step.action === "assert_url_contains"
              ? page.url().includes(expected)
              : page.url() === new URL(expected, packet.targetUrl).toString(),
          timeout,
        );
        if (!ok) throw new AssertionFailure("URL assertion failed", r(expected), r(page.url()));
        return {
          status: "passed",
          summary: `URL ${step.action === "assert_url_contains" ? "contains" : "equals"} ${r(expected)}`,
          evidence,
        };
      }
      case "assert_enabled":
      case "assert_disabled":
      case "assert_checked": {
        const loc = single(step.locator);
        await loc.waitFor({ state: "attached", timeout });
        const ok = await poll(async () => {
          if (step.action === "assert_checked") return loc.isChecked();
          const enabled = await loc.isEnabled();
          return step.action === "assert_enabled" ? enabled : !enabled;
        }, timeout);
        const want = step.action.replace("assert_", "");
        if (!ok) throw new AssertionFailure(`${describe(step.locator)} is not ${want}`, want, `not ${want}`);
        return { status: "passed", summary: `${describe(step.locator)} is ${want}`, evidence };
      }
      case "assert_count": {
        const loc = resolveLocator(page, step.locator);
        let actual = -1;
        const ok = await poll(async () => {
          actual = await loc.count();
          return actual === step.count;
        }, timeout);
        if (!ok)
          throw new AssertionFailure(
            `${describe(step.locator)} count mismatch`,
            String(step.count),
            String(actual),
          );
        return { status: "passed", summary: `${describe(step.locator)} count is ${step.count}`, evidence };
      }
      case "assert_response_status": {
        const needle = ctx.resolveValue(step.urlContains);
        const ok = await poll(
          async () => ctx.observers.responses.some((x) => x.url.includes(needle) && x.status === step.status),
          timeout,
        );
        if (!ok) {
          const seen = ctx.observers.responses.filter((x) => x.url.includes(needle)).map((x) => x.status);
          throw new AssertionFailure(
            `no response matching ${needle} with status ${step.status}`,
            String(step.status),
            seen.length ? seen.join(",") : "no matching response",
          );
        }
        return { status: "passed", summary: `Response ${needle} returned ${step.status}`, evidence };
      }
      case "assert_no_console_errors": {
        const errors = ctx.observers.consoleErrors();
        if (errors.length)
          throw new AssertionFailure(
            "console errors present",
            "0 console errors",
            errors
              .slice(0, 5)
              .map((e) => e.text)
              .join(" | "),
          );
        return { status: "passed", summary: "No console errors", evidence };
      }
      case "assert_no_network_failures": {
        const failures = ctx.observers.networkFailures();
        if (failures.length) {
          throw new AssertionFailure(
            "network failures present",
            "0 failed requests",
            failures
              .slice(0, 5)
              .map((f) => `${f.status ?? f.failure} ${f.url}`)
              .join(" | "),
          );
        }
        return { status: "passed", summary: "No network failures", evidence };
      }
      case "assert_no_horizontal_overflow": {
        const m = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        if (m.scrollWidth > m.clientWidth + 1) {
          const shot = packetPath(packet, `screenshots/step-${padSequence(index, 3)}-overflow.png`);
          await page.screenshot({ path: ctx.storage.resolve(shot), fullPage: true });
          throw new AssertionFailureWithEvidence(
            "horizontal overflow detected",
            `scrollWidth <= ${m.clientWidth}`,
            `scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}`,
            [shot],
          );
        }
        return {
          status: "passed",
          summary: `No horizontal overflow (${m.scrollWidth}px <= ${m.clientWidth}px)`,
          evidence,
        };
      }
      case "screenshot": {
        const rel = packetPath(packet, `screenshots/step-${padSequence(index, 3)}-${step.name}.png`);
        await page.screenshot({ path: ctx.storage.resolve(rel), fullPage: step.fullPage });
        evidence.push(rel);
        return { status: "passed", summary: `Captured screenshot ${step.name}`, evidence };
      }
      case "snapshot_dom": {
        const html = step.locator
          ? await single(step.locator).evaluate((el) => el.outerHTML)
          : await page.content();
        const rel = packetPath(packet, `dom/step-${padSequence(index, 3)}-${step.name}.html`);
        await ctx.storage.writeText(rel, truncate(r(html), 50_000));
        evidence.push(rel);
        return {
          status: "passed",
          summary: `Captured DOM snapshot ${step.name} (bounded, redacted)`,
          evidence,
        };
      }
      case "record_note":
        return { status: "passed", summary: truncate(r(step.note), 400), evidence };
      case "inspect_console_logs": {
        const rel = packetPath(packet, `dom/step-${padSequence(index, 3)}-console.json`);
        await ctx.storage.writeJson(rel, ctx.observers.console);
        evidence.push(rel);
        return {
          status: "passed",
          summary: `${ctx.observers.consoleErrors().length} console error(s) observed`,
          evidence,
        };
      }
      case "inspect_network_failures": {
        const rel = packetPath(packet, `dom/step-${padSequence(index, 3)}-network.json`);
        await ctx.storage.writeJson(rel, ctx.observers.network);
        evidence.push(rel);
        return {
          status: "passed",
          summary: `${ctx.observers.networkFailures().length} network failure(s) observed`,
          evidence,
        };
      }
      case "run_accessibility_scan":
      case "inspect_accessibility_tree":
        return {
          status: "skipped",
          summary: `${step.action} unavailable`,
          skipReason: "not_implemented",
          evidence,
        };
    }
    return {
      status: "failed",
      summary: "unsupported action",
      error: "unsupported action",
      evidence,
      failureKind: "policy",
    };
  } catch (error) {
    if (error instanceof AssertionFailureWithEvidence) {
      return {
        status: "failed",
        summary: error.message,
        error: error.message,
        expected: error.expected,
        actual: error.actual,
        evidence: [...evidence, ...error.paths],
        failureKind: "assertion",
      };
    }
    if (error instanceof AssertionFailure) {
      return {
        status: "failed",
        summary: error.message,
        error: error.message,
        expected: error.expected,
        actual: error.actual,
        evidence,
        failureKind: "assertion",
      };
    }
    const message = r((error as Error).message ?? String(error)).split("\n")[0] ?? "error";
    const kind =
      /Timeout .* exceeded/i.test(message) && "locator" in step
        ? "locator_not_found"
        : /net::|NS_ERROR|navigation/i.test(message)
          ? "navigation"
          : "error";
    return {
      status: "failed",
      summary: truncate(message, 300),
      error: truncate(message, 1000),
      evidence,
      failureKind: kind,
    };
  }
}

class AssertionFailureWithEvidence extends AssertionFailure {
  constructor(
    message: string,
    expected: string,
    actual: string,
    readonly paths: string[],
  ) {
    super(message, expected, actual);
  }
}

function describe(l: Locator): string {
  if (l.role) return l.name ? `${l.role} "${l.name}"` : l.role;
  if (l.label) return `field "${l.label}"`;
  if (l.placeholder) return `placeholder "${l.placeholder}"`;
  if (l.testId) return `testId "${l.testId}"`;
  if (l.text) return `text "${l.text}"`;
  return `css "${l.css}"`;
}

/**
 * Failure evidence: screenshot, URL, bounded redacted DOM (the target element when resolvable, else the
 * body), recent console errors and network failures.
 */
export async function captureFailureEvidence(
  ctx: StepExecutionContext,
  step: TestStep,
  index: number,
  now: () => string,
): Promise<Evidence[]> {
  const { page, packet, storage } = ctx;
  const out: Evidence[] = [];
  const r = (s: string) => ctx.redactor.redactString(s);
  const tag = `step-${padSequence(index, 3)}-failure`;
  if (packet.browser.screenshot !== "off") {
    const shot = packetPath(packet, `screenshots/${tag}.png`);
    try {
      await page.screenshot({ path: storage.resolve(shot), fullPage: true, timeout: 5000 });
      out.push({
        evidenceId: newId("ev"),
        type: "screenshot",
        path: shot,
        summary: "Screenshot at failure",
        createdAt: now(),
      });
    } catch {
      /* page may be closed or crashed; other evidence still recorded */
    }
  }
  out.push({
    evidenceId: newId("ev"),
    type: "url",
    summary: `URL at failure: ${r(page.url())}`,
    createdAt: now(),
  });
  try {
    let html = "";
    if ("locator" in step && step.locator) {
      const loc = resolveSingle(page, step.locator);
      if ((await loc.count()) > 0)
        html = await loc.evaluate((el) => el.outerHTML, undefined, { timeout: 1000 });
    }
    if (!html) html = await page.locator("body").innerHTML({ timeout: 2000 });
    const domRel = packetPath(packet, `dom/${tag}.html`);
    await storage.writeText(domRel, truncate(r(html), 4000));
    out.push({
      evidenceId: newId("ev"),
      type: "dom",
      path: domRel,
      summary: "Bounded, redacted DOM excerpt at failure",
      createdAt: now(),
    });
  } catch {
    /* DOM unavailable */
  }
  const errors = ctx.observers.consoleErrors();
  if (errors.length) {
    out.push({
      evidenceId: newId("ev"),
      type: "console",
      path: packetPath(packet, "console.json"),
      summary: truncate(
        `${errors.length} console error(s): ${errors
          .slice(-3)
          .map((e) => e.text)
          .join(" | ")}`,
        1000,
      ),
      createdAt: now(),
    });
  }
  const failures = ctx.observers.networkFailures();
  if (failures.length) {
    out.push({
      evidenceId: newId("ev"),
      type: "network",
      path: packetPath(packet, "network.json"),
      summary: truncate(
        `${failures.length} failed request(s): ${failures
          .slice(-3)
          .map((f) => `${f.status ?? f.failure} ${f.url}`)
          .join(" | ")}`,
        1000,
      ),
      createdAt: now(),
    });
  }
  return out;
}
