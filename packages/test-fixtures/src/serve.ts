import { startFixtureServer } from "./server.js";

const port = Number(process.env.PORT ?? process.argv[2] ?? 4173);
const server = await startFixtureServer({ port });
console.log(`BrowserSwarm fixture site listening on ${server.url} (Ctrl+C to stop)`);
const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
