import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { catalogItemPage, catalogPage, catalogSearchPage, flowPage, pages } from "./pages.js";

export interface FixtureServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
  /** Number of HTTP requests served; lets tests prove no browser activity happened. */
  requestCount(): number;
  /** Every request as METHOD + path (with query); lets tests prove discovery sent only GET/HEAD. */
  requestLog(): { method: string; path: string }[];
}

export const FLOW_STEPS = 6;

/** Starts the fixture site on 127.0.0.1. Port 0 picks a free port. No external network access. */
export async function startFixtureServer(
  options: { port?: number; host?: string } = {},
): Promise<FixtureServer> {
  const host = options.host ?? "127.0.0.1";
  let requests = 0;
  const log: { method: string; path: string }[] = [];
  const server: Server = createServer((req, res) => {
    requests++;
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    log.push({ method: req.method ?? "GET", path: `${path}${url.search}` });
    if (path === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (path.startsWith("/files/")) {
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment" });
      res.end("%PDF-1.4 fixture");
      return;
    }
    if (path === "/account" || path.startsWith("/account/")) {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    const flow = /^\/flow\/(\d+)$/.exec(path);
    const item = /^\/catalog\/item\/(\d+)$/.exec(path);
    let body: string | undefined;
    if (flow) {
      const n = Number(flow[1]);
      if (n >= 1 && n <= FLOW_STEPS) body = flowPage(n, FLOW_STEPS);
    } else if (item) {
      body = catalogItemPage(Number(item[1]));
    } else if (path === "/catalog") {
      body = catalogPage(url.searchParams.get("page") === "2" ? 2 : 1);
    } else if (path === "/catalog/search") {
      body = catalogSearchPage(url.searchParams.get("q") ?? "");
    } else {
      body = pages[path]?.();
    }
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    host,
    requestCount: () => requests,
    requestLog: () => [...log],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
