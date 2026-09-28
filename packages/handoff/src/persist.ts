import {
  BrowserSwarmError,
  computeHandoffHash,
  formatZodIssues,
  HandoffDocumentSchema,
  IntegrityError,
  type HandoffDocument,
} from "@browserswarm/core";
import { stableStringify } from "@browserswarm/shared";
import { RunLayout, type StorageAdapter } from "@browserswarm/storage";
import { renderHandoffMarkdown } from "./writer.js";

export function handoffSequenceOf(handoffId: string): number {
  const m = /^handoff-(\d+)$/.exec(handoffId);
  if (!m) throw new IntegrityError(`malformed handoff id ${handoffId}`);
  return Number(m[1]);
}

/** Writes handoff JSON, Markdown and .sha256 atomically. The JSON is always written before the agent terminates. */
export async function persistHandoff(storage: StorageAdapter, handoff: HandoffDocument): Promise<string> {
  const seq = handoffSequenceOf(handoff.handoffId);
  const layout = RunLayout.packet(handoff.workPacketId);
  try {
    await storage.writeText(layout.handoff(seq), `${stableStringify(handoff)}\n`);
    await storage.writeText(layout.handoffMarkdown(seq), renderHandoffMarkdown(handoff));
    await storage.writeText(layout.handoffHash(seq), `${handoff.integrityHash}\n`);
  } catch (error) {
    throw new BrowserSwarmError(
      "CHECKPOINT_PERSISTENCE_FAILED",
      `failed to persist ${handoff.handoffId}: ${(error as Error).message}`,
    );
  }
  return layout.handoff(seq);
}

export function verifyHandoff(raw: unknown): HandoffDocument {
  const parsed = HandoffDocumentSchema.safeParse(raw);
  if (!parsed.success)
    throw new IntegrityError("handoff failed schema validation", { issues: formatZodIssues(parsed.error) });
  if (computeHandoffHash(parsed.data) !== parsed.data.integrityHash) {
    throw new IntegrityError(`handoff ${parsed.data.handoffId} integrity hash mismatch`);
  }
  return parsed.data;
}

export async function loadHandoff(
  storage: StorageAdapter,
  packetId: string,
  sequence: number,
): Promise<HandoffDocument> {
  const layout = RunLayout.packet(packetId);
  const doc = verifyHandoff(await storage.readJson(layout.handoff(sequence)));
  const sidecar = (await storage.readText(layout.handoffHash(sequence))).trim();
  if (sidecar !== doc.integrityHash)
    throw new IntegrityError(`handoff ${doc.handoffId} sidecar hash mismatch`);
  return doc;
}
