import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TestPlanSchema } from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { McpBrowserSession } from "../../src/index.js";
it("starts the real pinned MCP, navigates, snapshots and closes", async () => {
  const server = createServer((_q, r) => r.end("<html><title>Fixture</title><h1>Ready</h1></html>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const packet = generateExecutionPlan(
    TestPlanSchema.parse({
      version: 1,
      id: "real",
      name: "real",
      target: { url: `http://127.0.0.1:${address.port}`, allowedDomains: ["127.0.0.1"] },
      scenarios: [
        {
          id: "s",
          title: "s",
          objective: "s",
          roles: ["functional"],
          viewports: ["desktop"],
          expectedOutcome: "Ready",
          steps: [{ action: "navigate", url: "/" }],
        },
      ],
    }),
  ).workPackets[0]!;
  const dir = await mkdtemp(path.join(os.tmpdir(), "bs-mcp-real-"));
  const session = new McpBrowserSession({ packet, artifactDir: dir, signal: new AbortController().signal });
  try {
    await session.start();
    expect(session.tools.some((t) => t.name === "browser_navigate")).toBe(true);
    const response = await session.callTool("browser_navigate", { url: packet.targetUrl });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response)).toContain("Ready");
  } finally {
    await session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60000);
