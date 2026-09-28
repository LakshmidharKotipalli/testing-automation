import { AgentEventSchema, type AgentEvent, type AgentEventInput } from "@browserswarm/core";
import { canonicalize, newId, systemClock, type Clock } from "@browserswarm/shared";
import type { StorageAdapter } from "./adapter.js";

export type EventListener = (event: AgentEvent) => void;

/**
 * Append-only NDJSON event store. Appends are serialized through a promise chain so concurrent packets
 * never interleave partial lines, and every event gets a monotonically increasing sequence number.
 */
export class EventStore {
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners: EventListener[] = [];
  private readonly buffer: AgentEvent[] = [];

  constructor(
    private readonly storage: StorageAdapter,
    private readonly runId: string,
    private readonly relPath = "events/events.ndjson",
    private readonly clock: Clock = systemClock,
  ) {}

  onEvent(listener: EventListener): void {
    this.listeners.push(listener);
  }

  emit(input: AgentEventInput): AgentEvent {
    const event = AgentEventSchema.parse({
      ...input,
      runId: input.runId ?? this.runId,
      eventId: newId("evt"),
      seq: ++this.seq,
      timestamp: this.clock.iso(),
      data: input.data ?? {},
    });
    this.buffer.push(event);
    this.chain = this.chain.then(() => this.storage.appendLine(this.relPath, canonicalize(event)));
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Resolves once every emitted event is durably appended. */
  async flush(): Promise<void> {
    await this.chain;
  }

  get events(): readonly AgentEvent[] {
    return this.buffer;
  }

  static async read(storage: StorageAdapter, relPath = "events/events.ndjson"): Promise<AgentEvent[]> {
    if (!(await storage.exists(relPath))) return [];
    const text = await storage.readText(relPath);
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => AgentEventSchema.parse(JSON.parse(l)));
  }
}
