import type { RunReport } from "@browserswarm/core";
import { RunLayout, type StorageAdapter } from "@browserswarm/storage";
import { renderMarkdownReport } from "./markdown.js";

export interface WrittenReports {
  written: string[];
  deferred: string[];
}

/** Writes the requested report formats. JSON is always written; HTML/JUnit arrive in Milestone 2. */
export async function writeReports(
  storage: StorageAdapter,
  report: RunReport,
  formats: ("json" | "markdown" | "html" | "junit")[],
): Promise<WrittenReports> {
  const written: string[] = [];
  const deferred: string[] = [];
  await storage.writeJson(RunLayout.reports.json, report);
  written.push(RunLayout.reports.json);
  if (formats.includes("markdown")) {
    await storage.writeText(RunLayout.reports.markdown, renderMarkdownReport(report));
    written.push(RunLayout.reports.markdown);
  }
  for (const f of ["html", "junit"] as const) if (formats.includes(f)) deferred.push(`${f} (Milestone 2)`);
  return { written, deferred };
}
