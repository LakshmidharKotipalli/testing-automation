import type { BrowserLauncher } from "@browserswarm/browser-tools";
import type {
  DiscoveryAuthorizationRecord,
  DiscoveryReport,
  DiscoveryWorkPacket,
  WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import type { Clock, Redactor } from "@browserswarm/shared";
import type { EventStore, StorageAdapter } from "@browserswarm/storage";
import { DiscoveryLeadAgent } from "./crawler.js";
import { buildWebsiteUnderstandingProfile, type ProfileOptions } from "./profile.js";
import { buildDiscoveryReport, writeDiscoveryOutputs } from "./render.js";
import type { DiscoveryRunResult } from "./types.js";

export interface DiscoveryPhaseInput {
  packet: DiscoveryWorkPacket;
  authorization: DiscoveryAuthorizationRecord;
  storage: StorageAdapter;
  events: EventStore;
  redactor: Redactor;
  launcher?: BrowserLauncher;
  clock?: Clock;
  signal?: AbortSignal;
  llm?: ProfileOptions["llm"];
  userIntent?: string;
  /** Called after the browser work ends and before the profile is built (run state bookkeeping). */
  onDiscoveryCompleted?: (result: DiscoveryRunResult) => void;
}

export interface DiscoveryPhaseResult {
  result: DiscoveryRunResult;
  profile: WebsiteUnderstandingProfile;
  report: DiscoveryReport;
  files: string[];
}

/**
 * Runs the discovery phase end to end: the single Discovery Lead Agent, then the Website Understanding
 * Profile and every discovery output file. No test work packet is created or started here.
 */
export async function runDiscoveryPhase(input: DiscoveryPhaseInput): Promise<DiscoveryPhaseResult> {
  const agent = new DiscoveryLeadAgent(input.packet, {
    storage: input.storage,
    events: input.events,
    redactor: input.redactor,
    ...(input.launcher ? { launcher: input.launcher } : {}),
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const result = await agent.run(input.authorization);
  input.onDiscoveryCompleted?.(result);
  const profile = await buildWebsiteUnderstandingProfile(result, {
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.llm ? { llm: input.llm } : {}),
    ...(input.userIntent ? { userIntent: input.userIntent } : {}),
  });
  input.events.emit({
    type: "profile.generated",
    data: {
      profileId: profile.profileId,
      profileHash: profile.profileHash,
      category: profile.applicationClassification.primaryCategory,
    },
  });
  const report = buildDiscoveryReport(profile, result, input.clock);
  const files = await writeDiscoveryOutputs(input.storage, profile, report);
  await input.events.flush();
  return { result, profile, report, files };
}
