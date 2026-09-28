import {
  computeDiscoveryAuthorizationHash,
  computeDiscoveryPacketHash,
  DiscoveryRequestSchema,
  DiscoveryWorkPacketSchema,
  IntegrityError,
  type DiscoveryAuthorizationRecord,
  type DiscoveryRequest,
  type DiscoveryWorkPacket,
} from "@browserswarm/core";
import { newId, systemClock, type Clock } from "@browserswarm/shared";

/** Read-only guarantees enforced by the discovery guards; shown before discovery and stored in the packet. */
export const DISCOVERY_GUARANTEES: string[] = [
  "Exactly one Discovery Lead Agent in one isolated browser context; no test subagents run during discovery.",
  "Only GET/HEAD requests leave the browser; every POST/PUT/PATCH/DELETE (form submits, fetch writes, beacons) is aborted.",
  "Requests to hosts outside the allowed domains are aborted; external links are recorded, never opened.",
  "No form is submitted, no text is typed into any field, no login/registration/password reset is attempted.",
  "Controls that look state-changing (create, save, submit, send, pay, order, book, delete, cancel, invite, upload, download, logout, ...) are recorded as restricted candidates and never clicked.",
  "Only safe interactions: internal links, tabs/accordions/disclosures, read-only pagination, read-only GET search/filter URLs, scrolling, viewport changes.",
  "Cookie banners are dismissed only with a reject/necessary-only control; optional tracking consent is never granted.",
  "Downloads, file choosers, popups and dialogs are blocked or dismissed; service workers are blocked.",
  "No CAPTCHA solving, fuzzing, scanning, injection, credential attempts, bypasses or load generation.",
  "robots.txt is not treated as authorization; your authorization statement is required and recorded.",
  "Secrets, cookies, tokens and form values are never sent to a model and are redacted from every artifact.",
];

export function createDiscoveryPacket(requestInput: unknown, runId: string): DiscoveryWorkPacket {
  const request: DiscoveryRequest = DiscoveryRequestSchema.parse(requestInput);
  const base: Omit<DiscoveryWorkPacket, "packetHash"> = {
    version: 1,
    packetId: "discovery-lead",
    runId,
    role: "discovery-lead",
    request,
    artifactDir: "discovery/lead",
    guarantees: DISCOVERY_GUARANTEES,
  };
  return DiscoveryWorkPacketSchema.parse({ ...base, packetHash: computeDiscoveryPacketHash(base) });
}

export function verifyDiscoveryPacket(packet: DiscoveryWorkPacket): void {
  const parsed = DiscoveryWorkPacketSchema.safeParse(packet);
  if (!parsed.success) throw new IntegrityError("discovery packet failed schema validation");
  if (computeDiscoveryPacketHash(packet) !== packet.packetHash)
    throw new IntegrityError("discovery packet was modified (hash mismatch)");
}

export const AUTHORIZATION_STATEMENT =
  "I own or am explicitly authorized to test this target, and I authorize bounded, read-only discovery of the allowed domains.";

export function recordDiscoveryAuthorization(input: {
  packet: DiscoveryWorkPacket;
  operator: string;
  mode: "interactive" | "noninteractive";
  clock?: Clock;
}): DiscoveryAuthorizationRecord {
  verifyDiscoveryPacket(input.packet);
  const base: Omit<DiscoveryAuthorizationRecord, "recordHash"> = {
    version: 1,
    authorizationId: newId("dauth"),
    runId: input.packet.runId,
    operator: input.operator,
    mode: input.mode,
    targetUrl: input.packet.request.targetUrl,
    allowedDomains: input.packet.request.allowedDomains,
    discoveryPacketHash: input.packet.packetHash,
    statement: AUTHORIZATION_STATEMENT,
    authorizedAt: (input.clock ?? systemClock).iso(),
  };
  return { ...base, recordHash: computeDiscoveryAuthorizationHash(base) };
}

/** Verifies that an authorization record belongs to this exact packet. Discovery refuses to start otherwise. */
export function verifyDiscoveryAuthorization(
  record: DiscoveryAuthorizationRecord,
  packet: DiscoveryWorkPacket,
): void {
  if (computeDiscoveryAuthorizationHash(record) !== record.recordHash)
    throw new IntegrityError("discovery authorization record was modified");
  if (record.discoveryPacketHash !== packet.packetHash || record.runId !== packet.runId)
    throw new IntegrityError("discovery authorization does not match this discovery packet");
}

/** What discovery will do, shown before the browser starts (the operator must authorize it). */
export function renderDiscoveryPreflight(packet: DiscoveryWorkPacket): string {
  const r = packet.request;
  const p = r.discoveryPolicy;
  const lines = [
    "------------------------------------------------",
    "BrowserSwarm Autonomous Discovery: Preflight",
    "------------------------------------------------",
    "",
    "Target:",
    `  ${r.targetUrl}`,
    "",
    "Allowed domains:",
    `  ${r.allowedDomains.join(", ")}${r.allowSubdomains ? " (and subdomains)" : ""}`,
    "",
    ...(r.userIntent ? ["User intent:", `  ${r.userIntent}`, ""] : []),
    "Discovery Lead Agent (1 agent, 1 browser context, read-only):",
    `  - Routes: discover up to ${p.maxRoutesDiscovered}, visit up to ${p.maxRoutesVisited}, depth <= ${p.maxNavigationDepth}`,
    `  - Navigations <= ${p.maxNavigations}, safe interactions <= ${p.maxSafeInteractions}, screenshots <= ${p.maxScreenshots}`,
    `  - Duration <= ${Math.round(p.maxDurationMs / 1000)}s; stops after ${p.stopWhenNoNewRoutesAfter} routes without new routes`,
    `  - Search/filters: ${p.allowSearchAndFilters ? "read-only GET only" : "inventory only"}; tabs/accordions: ${p.allowNonPersistentTabsAndAccordions ? "yes" : "no"}; pagination: ${p.allowReadOnlyPagination ? "yes" : "no"}; cookie banner: ${p.allowCookieBannerDismissal ? "reject/necessary only" : "left as is"}`,
    `  - Viewports: ${Object.keys(p.viewports).join(", ")}; accessibility scan (axe-core): ${p.runAccessibilityScan ? "yes" : "no"}`,
    `  - Model: ${r.model ? `${r.model.provider}:${r.model.model} (classification only, redacted structure)` : "none (deterministic classification)"}`,
    "",
    "Guarantees:",
    ...packet.guarantees.map((g) => `  - ${g}`),
    "",
    "No test subagent runs until you approve the generated test plan.",
    `Discovery packet hash: ${packet.packetHash}`,
    "",
    "Authorize read-only discovery of this target? Type: yes / no",
    "------------------------------------------------",
  ];
  return lines.join("\n");
}
