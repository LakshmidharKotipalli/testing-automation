import type { StepAction } from "./schemas/steps.js";

/** Current implementation milestone. Capabilities not yet available are reported, never silently skipped. */
export const IMPLEMENTED_MILESTONE = 1;

/** Step actions validated by the schema whose execution arrives in a later milestone. */
export const DEFERRED_ACTIONS: Partial<Record<StepAction, number>> = {};

export const MILESTONE_LIMITATIONS: string[] = [
  "Milestone 1: role-specific checks beyond the approved steps (overflow/screenshot matrix for responsive, visual review) arrive in Milestone 2; every role executes its approved scripted steps deterministically. run_accessibility_scan (axe-core) and inspect_accessibility_tree are available.",
  "Milestone 1: LLM fallback is not wired into execution; llm-capable packets run deterministically with zero LLM calls.",
  "Milestone 1: automatic replacement agents arrive in Milestone 3; when a lifecycle limit is reached the packet is checkpointed, a handoff is written, and the packet is BLOCKED (never silently continued).",
  "Milestone 1: HTML and JUnit reports arrive in Milestone 2; JSON and Markdown are generated.",
  "Milestone 1: verifier work packets arrive in Milestone 4; findings at or above the verification threshold are marked verification 'pending'.",
];
