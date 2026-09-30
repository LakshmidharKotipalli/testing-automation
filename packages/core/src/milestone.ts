import type { StepAction } from "./schemas/steps.js";

/** Current implementation milestone. Capabilities not yet available are reported, never silently skipped. */
export const IMPLEMENTED_MILESTONE = 1;

/** Step actions validated by the schema whose execution arrives in a later milestone. */
export const DEFERRED_ACTIONS: Partial<Record<StepAction, number>> = {};

export const MILESTONE_LIMITATIONS: string[] = [
  "Execution uses guarded Playwright MCP. Unsupported scripted checks and locators are BLOCKED; axe and layout evaluation require capabilities not enabled by default.",
  "Agentic packets require OpenRouter native tool calls or a verified isolated OpenCode adapter. Missing usage, configuration isolation or restoration prevents execution or resume.",
  "HTML and JUnit reports are deferred; JSON and Markdown are generated.",
  "Conditional verifier packets and MCP discovery are Phase 2 capabilities; verification currently remains pending.",
];
