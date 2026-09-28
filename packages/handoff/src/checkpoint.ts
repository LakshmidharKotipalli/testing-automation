import {
  AgentCheckpointSchema,
  BrowserSwarmError,
  computeCheckpointHash,
  formatZodIssues,
  IntegrityError,
  type AgentCheckpoint,
} from "@browserswarm/core";
import { canonicalize, padSequence } from "@browserswarm/shared";
import { RunLayout, type StorageAdapter } from "@browserswarm/storage";

export type CheckpointDraft = Omit<AgentCheckpoint, "integrityHash" | "checkpointId" | "version">;

export function createCheckpoint(draft: CheckpointDraft): AgentCheckpoint {
  const base = { version: 1 as const, checkpointId: `checkpoint-${padSequence(draft.sequence)}`, ...draft };
  const cp = { ...base, integrityHash: computeCheckpointHash(base) };
  const parsed = AgentCheckpointSchema.safeParse(cp);
  if (!parsed.success)
    throw new IntegrityError("checkpoint failed schema validation", {
      issues: formatZodIssues(parsed.error),
    });
  return cp;
}

export function verifyCheckpoint(raw: unknown): AgentCheckpoint {
  const parsed = AgentCheckpointSchema.safeParse(raw);
  if (!parsed.success)
    throw new IntegrityError("checkpoint failed schema validation", {
      issues: formatZodIssues(parsed.error),
    });
  if (computeCheckpointHash(parsed.data) !== parsed.data.integrityHash) {
    throw new IntegrityError(`checkpoint ${parsed.data.checkpointId} integrity hash mismatch`);
  }
  return parsed.data;
}

/**
 * Persists checkpoint JSON and its .sha256 atomically. Failure is surfaced as
 * CHECKPOINT_PERSISTENCE_FAILED so the caller blocks the packet instead of continuing without a checkpoint.
 */
export async function persistCheckpoint(storage: StorageAdapter, cp: AgentCheckpoint): Promise<string> {
  const layout = RunLayout.packet(cp.workPacketId);
  const rel = layout.checkpoint(cp.sequence);
  try {
    await storage.writeText(rel, `${JSON.stringify(JSON.parse(canonicalize(cp)), null, 2)}\n`);
    await storage.writeText(layout.checkpointHash(cp.sequence), `${cp.integrityHash}\n`);
  } catch (error) {
    throw new BrowserSwarmError(
      "CHECKPOINT_PERSISTENCE_FAILED",
      `failed to persist ${cp.checkpointId}: ${(error as Error).message}`,
      {
        checkpointId: cp.checkpointId,
      },
    );
  }
  return rel;
}

export async function loadCheckpoint(
  storage: StorageAdapter,
  packetId: string,
  sequence: number,
): Promise<AgentCheckpoint> {
  const layout = RunLayout.packet(packetId);
  const cp = verifyCheckpoint(await storage.readJson(layout.checkpoint(sequence)));
  const sidecar = (await storage.readText(layout.checkpointHash(sequence))).trim();
  if (sidecar !== cp.integrityHash)
    throw new IntegrityError(`checkpoint ${cp.checkpointId} sidecar hash mismatch`);
  return cp;
}
