import type { Locator, TestStep } from "@browserswarm/core";
import { GatewayBlocked, toolText, type GuardedBrowserSession } from "./index.js";
export interface ScriptedOutcome {
  status: "passed" | "failed" | "blocked";
  summary: string;
  evidence: string[];
  error?: string;
  expected?: string;
  actual?: string;
}
export async function executeScriptedStep(
  g: GuardedBrowserSession,
  step: TestStep,
  resolve: (s: string) => string,
): Promise<ScriptedOutcome> {
  const start = g.evidence.length;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await g.callTool(name, args, false);
    if (r.isError) throw new Error(toolText(r));
    return toolText(r);
  };
  const targets = (l: Locator) => {
    if (l.css || l.testId || l.placeholder) throw new GatewayBlocked("unsupported_scripted_locator");
    const text = l.name ?? l.label ?? l.text;
    return [...g.elements.values()].filter(
      (e) =>
        (!l.role || e.role === l.role) &&
        (!text || (l.exact ? e.name === resolve(text) : e.name.includes(resolve(text)))),
    );
  };
  const target = (l: Locator) => {
    const list = targets(l),
      item = list[l.nth ?? 0];
    if (!item || (l.nth === undefined && list.length > 1)) throw new Error("locator not found or ambiguous");
    return item;
  };
  let expected: string | undefined;
  let actual: string | undefined;
  const assert = (ok: boolean) => {
    if (!ok) throw new Error(`assertion failed: ${step.action}`);
  };
  try {
    if (!["navigate", "record_note"].includes(step.action)) await call("browser_snapshot");
    switch (step.action) {
      case "navigate":
        await call("browser_navigate", { url: resolve(step.url) });
        break;
      case "go_back":
        await call("browser_navigate_back");
        break;

      case "fill":
      case "clear": {
        const t = target(step.locator);
        await call("browser_type", {
          ref: t.ref,
          element: t.name,
          text: step.action === "fill" ? resolve(step.value) : "",
        });
        break;
      }
      case "click": {
        const t = target(step.locator);
        await call("browser_click", { ref: t.ref, element: t.name });
        break;
      }
      case "select_option": {
        const t = target(step.locator);
        await call("browser_select_option", { ref: t.ref, element: t.name, values: [resolve(step.value)] });
        break;
      }
      case "check":
      case "uncheck": {
        const t = target(step.locator);
        const checked = t.text.includes("[checked]");
        if (checked !== (step.action === "check"))
          await call("browser_click", { ref: t.ref, element: t.name });
        break;
      }
      case "assert_visible":
        assert(!!target(step.locator));
        break;
      case "assert_hidden":
        assert(targets(step.locator).length === 0);
        break;
      case "assert_count":
        assert(targets(step.locator).length === step.count);
        break;
      case "assert_enabled":
        assert(!target(step.locator).text.includes("[disabled]"));
        break;
      case "assert_disabled":
        assert(target(step.locator).text.includes("[disabled]"));
        break;
      case "assert_checked":
        assert(target(step.locator).text.includes("[checked]"));
        break;
      case "assert_text_contains":
      case "assert_text_equals": {
        const element = target(step.locator);
        expected = resolve(step.text);
        actual =
          element.name ||
          element.text
            .split("\n")
            .flatMap((line) => {
              const content =
                line.match(/\[ref=[^\]]+\](?: \[[^\]]+\])*:\s*(.*)$/)?.[1] ??
                line.match(/- text:\s*(.*)$/)?.[1];
              return content === undefined ? [] : [content.replace(/^"(.*)"$/, "$1")];
            })
            .join(" ");
        assert(step.action === "assert_text_equals" ? actual === expected : actual.includes(expected));
        break;
      }
      case "assert_url_contains":
        assert(g.url.includes(resolve(step.value)));
        break;
      case "assert_url_equals":
        assert(g.url === new URL(resolve(step.value), g.options.packet.targetUrl).href);
        break;
      case "screenshot":
        await call("browser_take_screenshot", {
          filename: `${step.name}.png`,
          type: "png",
          fullPage: step.fullPage,
        });
        break;
      case "snapshot_dom":
      case "inspect_accessibility_tree":
        await call("browser_snapshot");
        break;
      case "inspect_console_logs":
        await call("browser_console_messages");
        break;
      case "inspect_network_failures":
        await call("browser_network_requests");
        break;
      case "assert_no_console_errors":
        actual = await call("browser_console_messages", { level: "error" });
        expected = "No console errors";
        assert(!/\[ERROR\]|Error:|Refused to/i.test(actual));
        break;
      case "assert_no_network_failures":
        actual = await call("browser_network_requests");
        expected = "No network failures";
        assert(!/FAILED|net::|=>\s*(?:4|5)\d\d/i.test(actual));
        break;
      case "record_note":
        await g.persistEvidence("note", resolve(step.note));
        break;
      default:
        throw new GatewayBlocked(`unsupported_scripted_check: ${step.action}`);
    }
    return {
      status: "passed",
      summary: step.action,
      evidence: g.evidence.slice(start).map((e) => e.path ?? e.evidenceId),
    };
  } catch (e) {
    await g.captureFailure().catch(() => undefined);
    const message = g.options.redactor.redactString((e as Error).message);
    return {
      status: e instanceof GatewayBlocked ? "blocked" : "failed",
      summary: message,
      error: message,
      expected,
      actual,
      evidence: g.evidence.slice(start).map((e) => e.path ?? e.evidenceId),
    };
  }
}
