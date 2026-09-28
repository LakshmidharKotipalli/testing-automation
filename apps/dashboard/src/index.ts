import { AgentEventSchema, RunReportSchema, type AgentEvent, type RunReport } from "@browserswarm/core";
import { EventStore, FilesystemStorage, RunLayout } from "@browserswarm/storage";

/**
 * Data access for the dashboard (the UI itself arrives in Milestone 5). Reads a run directory's validated
 * report and event log; never mutates artifacts.
 */
export interface RunSnapshot {
  report?: RunReport;
  events: AgentEvent[];
}

export async function readRunSnapshot(runDir: string): Promise<RunSnapshot> {
  const storage = new FilesystemStorage(runDir);
  const events = (await EventStore.read(storage, RunLayout.events)).map((e) => AgentEventSchema.parse(e));
  const report = (await storage.exists(RunLayout.reports.json))
    ? RunReportSchema.parse(await storage.readJson(RunLayout.reports.json))
    : undefined;
  return report ? { report, events } : { events };
}
