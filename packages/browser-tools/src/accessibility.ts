import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { truncate, type Redactor } from "@browserswarm/shared";
import type { Page } from "playwright";

export interface AxeViolationSummary {
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  nodeCount: number;
  /** Bounded CSS target selectors of the first affected nodes (no element HTML, no text content). */
  targets: string[];
}

export interface AxeScanResult {
  url: string;
  violations: AxeViolationSummary[];
  passes: number;
  incomplete: number;
}

export interface AxeScanOptions {
  /** axe tags to run (e.g. ["wcag2a", "wcag2aa"]); all rules when omitted. */
  tags?: string[];
  /** CSS selector limiting the scan to a region. */
  include?: string;
  redactor?: Redactor;
}

let cachedSource: string | undefined;

/** The axe-core engine source, read once from the installed package (never fetched over the network). */
export function axeSource(): string {
  if (cachedSource === undefined) {
    const require = createRequire(import.meta.url);
    cachedSource = readFileSync(require.resolve("axe-core"), "utf8");
  }
  return cachedSource;
}

/**
 * Runs axe-core against the current page. Nonintrusive: axe only reads the DOM and computed styles. The
 * engine is injected by evaluation (like @axe-core/playwright), so page CSP does not block it and no
 * request leaves the browser. Results are reduced to rule ids, impacts and bounded selectors.
 */
export async function runAxe(page: Page, options: AxeScanOptions = {}): Promise<AxeScanResult> {
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  const loaded = await page.evaluate("typeof globalThis.axe === 'object'");
  if (!loaded) await page.evaluate(axeSource());
  const raw = await page.evaluate(
    async (opts: { tags?: string[]; include?: string }) => {
      type AxeNode = { target: unknown[] };
      type AxeRule = { id: string; impact?: string | null; help: string; helpUrl: string; nodes: AxeNode[] };
      type AxeApi = {
        run(
          context: unknown,
          options: Record<string, unknown>,
        ): Promise<{ violations: AxeRule[]; passes: unknown[]; incomplete: unknown[] }>;
      };
      const axe = (globalThis as unknown as { axe: AxeApi }).axe;
      const context = opts.include ? { include: [[opts.include]] } : document;
      const runOptions: Record<string, unknown> = { resultTypes: ["violations"] };
      if (opts.tags?.length) runOptions.runOnly = { type: "tag", values: opts.tags };
      const result = await axe.run(context, runOptions);
      return {
        violations: result.violations.map((v) => ({
          id: v.id,
          impact: v.impact ?? "unknown",
          help: v.help,
          helpUrl: v.helpUrl,
          nodeCount: v.nodes.length,
          targets: v.nodes.slice(0, 5).map((n) => n.target.map(String).join(" ")),
        })),
        passes: result.passes.length,
        incomplete: result.incomplete.length,
      };
    },
    {
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.include ? { include: options.include } : {}),
    },
  );
  const r = (s: string) => truncate(options.redactor ? options.redactor.redactString(s) : s, 300);
  return {
    url: r(page.url()),
    passes: raw.passes,
    incomplete: raw.incomplete,
    violations: raw.violations.map((v) => ({ ...v, help: r(v.help), targets: v.targets.map(r) })),
  };
}

export const SERIOUS_IMPACTS = new Set(["serious", "critical"]);

/**
 * Bounded accessibility-tree summary of the page (or a region) as Playwright's ARIA snapshot YAML. Redacted
 * and truncated; form values are not part of the snapshot's accessible names.
 */
export async function accessibilityTreeSummary(
  page: Page,
  selector?: string,
  redactor?: Redactor,
  maxChars = 8000,
): Promise<string> {
  const snapshot = await page
    .locator(selector ?? "body")
    .first()
    .ariaSnapshot({ timeout: 5000 });
  return truncate(redactor ? redactor.redactString(snapshot) : snapshot, maxChars);
}
