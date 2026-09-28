import { padSequence } from "@browserswarm/shared";

/** Canonical artifact layout (docs/reports.md). All paths are relative to the run directory. */
export const RunLayout = {
  metadata: {
    originalPrompt: "metadata/original-prompt.md",
    originalPromptHash: "metadata/original-prompt.sha256",
    compiledPlan: "metadata/compiled-plan.yaml",
    compiledPlanHash: "metadata/compiled-plan.sha256",
    executionPlan: "metadata/execution-plan.json",
    executionPlanHash: "metadata/execution-plan.sha256",
    approvalRecord: "metadata/approval-record.json",
    approvedExecutionPlan: "metadata/approved-execution-plan.json",
    run: "metadata/run.json",
  },
  events: "events/events.ndjson",
  reports: {
    json: "reports/report.json",
    markdown: "reports/report.md",
    html: "reports/report.html",
    junit: "reports/junit.xml",
  },
  packet(packetId: string) {
    const dir = `packets/${packetId}`;
    return {
      dir,
      workPacket: `${dir}/work-packet.json`,
      state: `${dir}/packet-state.json`,
      actions: `${dir}/actions.ndjson`,
      stepResults: `${dir}/step-results.json`,
      findings: `${dir}/findings.json`,
      console: `${dir}/console.json`,
      network: `${dir}/network.json`,
      manifest: `${dir}/artifact-manifest.json`,
      domDir: `${dir}/dom`,
      screenshotsDir: `${dir}/screenshots`,
      traceDir: `${dir}/trace`,
      trace: `${dir}/trace/trace.zip`,
      storageState: `${dir}/browser-state/storage-state.json`,
      checkpoint: (seq: number) => `${dir}/checkpoints/checkpoint-${padSequence(seq)}.json`,
      checkpointHash: (seq: number) => `${dir}/checkpoints/checkpoint-${padSequence(seq)}.sha256`,
      handoff: (seq: number) => `${dir}/handoffs/handoff-${padSequence(seq)}.json`,
      handoffMarkdown: (seq: number) => `${dir}/handoffs/handoff-${padSequence(seq)}.md`,
      handoffHash: (seq: number) => `${dir}/handoffs/handoff-${padSequence(seq)}.sha256`,
      agentInstance: (id: string) => `${dir}/agent-instances/${id}/instance.json`,
      agentContextUsage: (id: string) => `${dir}/agent-instances/${id}/context-usage.json`,
      agentResumeManifest: (id: string) => `${dir}/agent-instances/${id}/resume-context-manifest.json`,
    };
  },
  verification(verificationPacketId: string) {
    return { dir: `verification/${verificationPacketId}` };
  },
};

/** Paths inside a packet directory, as referenced from checkpoints and handoffs (packet-relative). */
export function packetRelative(fullRelPath: string, packetId: string): string {
  const prefix = `packets/${packetId}/`;
  return fullRelPath.startsWith(prefix) ? fullRelPath.slice(prefix.length) : fullRelPath;
}
