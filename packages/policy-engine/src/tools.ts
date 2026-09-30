import { AgentPolicySchema, type ToolClass, type WorkPacket, type RiskCategory } from "@browserswarm/core";
import { checkUrl } from "./domains.js";
import { RISK_RULES, isCategoryAllowed } from "./risk.js";

/** Classification is a permission table, not a substitute for runtime tools/list discovery. */
export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = Object.freeze({
  browser_snapshot: "read",
  browser_take_screenshot: "read",
  browser_console_messages: "read",
  browser_network_requests: "read",
  browser_wait_for: "read",
  browser_navigate: "navigate",
  browser_navigate_back: "navigate",
  browser_navigate_forward: "navigate",
  browser_reload: "navigate",
  browser_click: "interact",
  browser_hover: "interact",
  browser_drag: "interact",
  browser_type: "interact",
  browser_fill_form: "interact",
  browser_select_option: "interact",
  browser_press_key: "interact",
  browser_handle_dialog: "interact",
  browser_evaluate: "evaluate",
  browser_run_code: "evaluate",
  browser_file_upload: "upload",
  browser_pdf_save: "download",
  browser_install: "admin",
  browser_close: "admin",
  browser_resize: "admin",
  browser_tabs: "admin",
  browser_storage_state: "admin",
  browser_set_storage_state: "admin",
  browser_route: "admin",
  browser_unroute: "admin",
});
export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  text: string;
}
export interface SnapshotContext {
  url?: string;
  elements: Map<string, SnapshotElement>;
  riskApproved: boolean;
}
export function parseSnapshot(text: string): Map<string, SnapshotElement> {
  const elements = new Map<string, SnapshotElement>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
    if (!ref) continue;
    const match = line.match(/- (\w+)(?: "([^"]*)")?/);
    const indent = line.search(/\S/);
    const subtree = [line];
    for (let j = index + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() && next.search(/\S/) <= indent) break;
      subtree.push(next);
    }
    elements.set(ref, { ref, role: match?.[1] ?? "", name: match?.[2] ?? "", text: subtree.join("\n") });
  }
  return elements;
}
export function checkToolCall(
  name: string,
  args: Record<string, unknown>,
  snapshot: SnapshotContext,
  packet: WorkPacket,
): { allowed: boolean; reason?: string } {
  const deny = (reason: string) => ({ allowed: false, reason });
  const kind = TOOL_CLASSES[name];
  if (!kind || !AgentPolicySchema.parse(packet.agent ?? {}).allowedTools.includes(kind))
    return deny(`tool_class_blocked: ${name}`);
  if (["evaluate", "admin", "upload", "download"].includes(kind)) {
    const category: RiskCategory =
      kind === "evaluate"
        ? "tool_evaluate"
        : kind === "admin"
          ? "tool_admin"
          : kind === "upload"
            ? "file_upload"
            : "file_download";
    if (!snapshot.riskApproved || !packet.riskFlags.some((f) => f.category === category && f.allowedByPolicy))
      return deny(`${category} requires explicit risk approval`);
  }
  // Session/storage/route mutation could remove the guard or disclose authentication material.
  if (
    [
      "browser_storage_state",
      "browser_set_storage_state",
      "browser_route",
      "browser_unroute",
      "browser_install",
      "browser_resize",
      "browser_close",
      "browser_tabs",
    ].includes(name)
  )
    return deny("internal_lifecycle_tool");
  if (
    snapshot.url &&
    snapshot.url !== "about:blank" &&
    !checkUrl(snapshot.url, packet.targetUrl, packet).allowed
  )
    return deny("scope_exit");
  if (name === "browser_navigate") {
    if (typeof args.url !== "string") return deny("navigation URL required");
    const u = checkUrl(
      args.url,
      snapshot.url && snapshot.url !== "about:blank" ? snapshot.url : packet.targetUrl,
      packet,
    );
    if (!u.allowed || !/^https?:/.test(u.url ?? "")) return deny(u.reason ?? "unsupported navigation scheme");
  }
  if (kind === "interact") {
    if (name === "browser_handle_dialog" || name === "browser_press_key")
      return deny("interaction_target_unresolved");
    const refs: string[] = [];
    for (const key of ["ref", "startRef", "endRef"])
      if (typeof args[key] === "string") refs.push(args[key] as string);
    if (Array.isArray(args.fields))
      for (const field of args.fields)
        if (field && typeof field === "object" && typeof field.ref === "string") refs.push(field.ref);
    if (!refs.length) return deny("interaction_target_unresolved");
    for (const ref of refs) {
      const target = snapshot.elements.get(ref);
      if (!target) return deny("stale_or_unknown_element_reference");
      for (const rule of RISK_RULES)
        if (rule.pattern.test(target.name + " " + target.text)) {
          if (
            !isCategoryAllowed(rule.category, packet.safety) ||
            !snapshot.riskApproved ||
            !packet.riskFlags.some((f) => f.category === rule.category && f.allowedByPolicy)
          )
            return deny(`${rule.category} blocked by safety policy`);
        }
    }
  }
  return { allowed: true };
}
