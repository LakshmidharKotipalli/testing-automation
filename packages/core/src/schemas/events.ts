import { z } from "zod";
import { IsoDateSchema } from "./common.js";

export const EVENT_TYPES = [
  "run.state.changed",
  "run.approved",
  "run.rejected",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "approval.recorded",
  "packet.state.changed",
  "packet.queued",
  "packet.started",
  "packet.step.started",
  "packet.step.completed",
  "packet.step.failed",
  "packet.step.skipped",
  "packet.checkpoint.created",
  "packet.handoff.required",
  "packet.handoff.created",
  "packet.handoff.validated",
  "packet.completed",
  "packet.failed",
  "packet.blocked",
  "packet.cancelled",
  "policy.blocked",
  "agent.state.changed",
  "agent.context.warning",
  "agent.context.limit_reached",
  "agent.checkpointing",
  "agent.terminated",
  "agent.replacement.created",
  "agent.resume.started",
  "agent.resume.validated",
  "agent.resume.completed",
  "resume_context_compacted",
  "finding.created",
  "finding.deduplicated",
  "verification.queued",
  "verification.completed",
  "replay.hit",
  "replay.mismatch",
  "replay.completed",
  "replay.stored",
  "discovery.planned",
  "discovery.authorized",
  "discovery.started",
  "discovery.route.visited",
  "discovery.interaction",
  "discovery.control.restricted",
  "discovery.request.blocked",
  "discovery.checkpoint.created",
  "discovery.handoff.created",
  "discovery.completed",
  "discovery.failed",
  "profile.generated",
  "plan.generated",
] as const;

export const AgentEventTypeSchema = z.enum(EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const AgentEventSchema = z
  .object({
    eventId: z.string(),
    seq: z.number().int().min(1),
    type: AgentEventTypeSchema,
    timestamp: IsoDateSchema,
    runId: z.string(),
    packetId: z.string().optional(),
    agentInstanceId: z.string().optional(),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventInput = Omit<AgentEvent, "eventId" | "seq" | "timestamp" | "runId"> & {
  runId?: string;
};
