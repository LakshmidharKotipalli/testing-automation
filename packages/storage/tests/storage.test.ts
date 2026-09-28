import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore, FilesystemStorage, RunLayout } from "../src/index.js";

describe("FilesystemStorage", () => {
  it("writes, reads and lists within its root only", async () => {
    const s = new FilesystemStorage(await mkdtemp(path.join(tmpdir(), "bs-store-")));
    await s.writeJson("a/b.json", { z: 1, a: 2 });
    expect(await s.readText("a/b.json")).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
    expect(await s.list("a")).toEqual(["b.json"]);
    expect(() => s.resolve("../escape")).toThrow();
    expect(() => s.resolve("/etc/passwd")).toThrow();
  });
});

describe("EventStore", () => {
  it("appends ordered NDJSON events without interleaving", async () => {
    const s = new FilesystemStorage(await mkdtemp(path.join(tmpdir(), "bs-events-")));
    const events = new EventStore(s, "run-1");
    const seen: string[] = [];
    events.onEvent((e) => seen.push(e.type));
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() =>
          events.emit({ type: "packet.step.completed", packetId: `p${i % 4}`, data: { i } }),
        ),
      ),
    );
    events.emit({ type: "run.completed", data: {} });
    await events.flush();
    const read = await EventStore.read(s, RunLayout.events);
    expect(read).toHaveLength(51);
    expect(read.map((e) => e.seq)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    expect(seen.at(-1)).toBe("run.completed");
  });

  it("rejects unknown event types", () => {
    const events = new EventStore(new FilesystemStorage(tmpdir()), "run-1");
    expect(() => events.emit({ type: "made.up" as never, data: {} })).toThrow();
  });
});

describe("RunLayout", () => {
  it("matches the documented artifact hierarchy", () => {
    const p = RunLayout.packet("pkt");
    expect(p.checkpoint(2)).toBe("packets/pkt/checkpoints/checkpoint-0002.json");
    expect(p.handoffMarkdown(1)).toBe("packets/pkt/handoffs/handoff-0001.md");
    expect(p.agentResumeManifest("agent-1")).toBe(
      "packets/pkt/agent-instances/agent-1/resume-context-manifest.json",
    );
    expect(RunLayout.metadata.approvedExecutionPlan).toBe("metadata/approved-execution-plan.json");
  });
});
