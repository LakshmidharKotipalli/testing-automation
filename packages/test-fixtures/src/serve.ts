import path from "node:path";
import { ENV, loadDotEnv } from "@browserswarm/shared";
import { startFixtureServer } from "./server.js";

// Same central configuration as the CLI: the fixture listens where BROWSERSWARM_TARGET_URL points.
loadDotEnv(process.env[ENV.ENV_FILE] ?? path.resolve(process.cwd(), ".env"));

function portFromTargetUrl(): number | undefined {
  const raw = process.env[ENV.TARGET_URL];
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return undefined;
    return url.port ? Number(url.port) : undefined;
  } catch {
    return undefined;
  }
}

const port = Number(process.env.PORT ?? process.argv[2] ?? portFromTargetUrl() ?? 4173);
const server = await startFixtureServer({ port });
console.log(`BrowserSwarm fixture site listening on ${server.url} (Ctrl+C to stop)`);
const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
