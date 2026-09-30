import type { CallToolResult } from "@browserswarm/mcp-browser";

export class GatewayBlocked extends Error {}

export function toolText(result: CallToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const CHALLENGE = new RegExp(
  [
    "just a moment",
    "verify (?:that )?you are human",
    "checking your browser",
    "performing security verification",
    "cf-chl-",
  ].join("|"),
  "i",
);

export function detectChallenge(title: string, snapshot: string): boolean {
  return CHALLENGE.test(title + "\n" + snapshot);
}
