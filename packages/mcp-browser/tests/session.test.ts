import { describe, it, expect } from "vitest";
import { guardSource } from "../src/request-guard.js";
import { TestPlanSchema } from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import vm from "node:vm";
describe("request guard", () => {
  it("checks each paused redirect request before forwarding and blocks discovery writes", async () => {
    const p = generateExecutionPlan(
      TestPlanSchema.parse({
        version: 1,
        id: "guard",
        name: "guard",
        target: { url: "https://owned.test", allowedDomains: ["owned.test"] },
        scenarios: [
          {
            id: "s",
            title: "s",
            objective: "s",
            roles: ["functional"],
            viewports: ["desktop"],
            expectedOutcome: "s",
            steps: [{ action: "navigate", url: "/" }],
          },
        ],
      }),
    ).workPackets[0]!;
    let paused: (event: unknown) => Promise<void> = async () => {};
    const calls: string[] = [];
    const writes: string[] = [];
    const cdp = {
      on: (_: string, fn: typeof paused) => {
        paused = fn;
      },
      send: async (method: string) => {
        calls.push(method);
      },
    };
    const context = { on: () => {}, newCDPSession: async () => cdp };
    const mod = { default: undefined as unknown };
    vm.runInNewContext(guardSource(p, "/ready", true), {
      module: mod,
      exports: mod,
      URL,
      require: () => ({ writeFileSync: () => {}, appendFileSync: (_: string, s: string) => writes.push(s) }),
    });
    await (mod.default as (o: unknown) => Promise<void>)({
      page: { context: () => context, on: () => {}, close: async () => {} },
    });
    await paused({
      requestId: "1",
      request: { url: "https://owned.test/", method: "GET" },
      resourceType: "Document",
    });
    await paused({
      requestId: "2",
      request: { url: "https://outside.test/", method: "GET" },
      resourceType: "Document",
    });
    await paused({
      requestId: "3",
      request: { url: "https://owned.test/", method: "POST" },
      resourceType: "XHR",
    });
    expect(calls).toEqual([
      "Fetch.enable",
      "Fetch.continueRequest",
      "Fetch.failRequest",
      "Fetch.failRequest",
    ]);
    expect(writes).toHaveLength(2);
  });
});
