import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ApprovalDecision, ExecutionPlan } from "@browserswarm/core";

export interface PromptIO {
  input: Readable;
  output: Writable;
  /**
   * Shared line iterator over `input`. Flows that ask several questions pass one iterator so buffered
   * input is not lost between prompts; when omitted each prompt reads `input` on its own.
   */
  lines?: AsyncIterator<string>;
}

/** Opens a line reader, or reuses the shared one (which the caller closes). */
function openLines(io: PromptIO): { lines: AsyncIterator<string>; close: () => void } {
  if (io.lines) return { lines: io.lines, close: () => undefined };
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  return { lines: rl[Symbol.asyncIterator](), close: () => rl.close() };
}

export interface InteractiveDecision {
  decision: ApprovalDecision;
  riskAcceptance?: { accepted: boolean; riskPlanHash?: string };
}

/** The exact phrase a user must type to accept risk: binds the acceptance to this risk plan. */
export function riskConfirmationPhrase(ep: ExecutionPlan): string {
  return `accept-risk ${(ep.riskPlanHash ?? "").slice("sha256:".length, "sha256:".length + 12)}`;
}

/**
 * Interactive approval prompt. Unknown answers are re-asked; EOF counts as reject. Risky plans need a
 * second, typed confirmation that includes a prefix of the risk plan hash.
 */
export async function promptForDecision(ep: ExecutionPlan, io: PromptIO): Promise<InteractiveDecision> {
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string | undefined> => {
    io.output.write(question);
    const next = await lines.next();
    return next.done ? undefined : String(next.value).trim().toLowerCase();
  };
  try {
    for (let attempts = 0; attempts < 5; attempts++) {
      const answer = await ask("> ");
      if (answer === undefined) return { decision: "reject" };
      if (answer === "approve" || answer === "reject" || answer === "export" || answer === "edit") {
        if (answer !== "approve" || !ep.requiresExplicitRiskApproval) return { decision: answer };
        const phrase = riskConfirmationPhrase(ep);
        io.output.write(
          `\nThis plan contains ${ep.riskFlags.length} risky step(s). To accept this exact risk plan, type:\n  ${phrase}\n`,
        );
        const confirm = await ask("> ");
        if (confirm === phrase)
          return {
            decision: "approve",
            riskAcceptance: { accepted: true, riskPlanHash: ep.riskPlanHash ?? undefined },
          };
        io.output.write("Risk confirmation did not match. Treating as reject.\n");
        return { decision: "reject" };
      }
      io.output.write("Please type one of: approve / reject / export / edit\n");
    }
    return { decision: "reject" };
  } finally {
    rl.close();
  }
}

export const EDIT_INSTRUCTIONS = [
  "Edit the test plan file, then regenerate and re-approve:",
  "  pnpm browserswarm validate --plan <plan.yaml>",
  "  pnpm browserswarm preview --plan <plan.yaml> --write <execution-plan.json>",
  "  pnpm browserswarm approve --plan <plan.yaml> --execution-plan <execution-plan.json>",
  "Any change to the plan or its configuration invalidates previous approvals.",
].join("\n");

/** Choices shown at the autonomous discovery review, mapped onto the standard approval decisions. */
export const AUTONOMOUS_CHOICES = {
  "approve-safe-plan": "approve",
  "export-and-edit": "export",
  reject: "reject",
} as const satisfies Record<string, ApprovalDecision>;

/**
 * Interactive decision for an autonomous plan: approve-safe-plan / export-and-edit / reject. EOF or
 * repeated unknown answers count as reject. A plan with risky steps still needs the typed risk phrase.
 */
export async function promptForAutonomousDecision(
  ep: ExecutionPlan,
  io: PromptIO,
): Promise<InteractiveDecision> {
  const { lines, close } = openLines(io);
  const ask = async (question: string): Promise<string | undefined> => {
    io.output.write(question);
    const next = await lines.next();
    return next.done ? undefined : String(next.value).trim().toLowerCase();
  };
  try {
    for (let attempts = 0; attempts < 5; attempts++) {
      const answer = await ask("> ");
      if (answer === undefined) return { decision: "reject" };
      const mapped = (AUTONOMOUS_CHOICES as Record<string, ApprovalDecision>)[answer];
      if (!mapped) {
        io.output.write("Please type one of: approve-safe-plan / export-and-edit / reject\n");
        continue;
      }
      if (mapped !== "approve" || !ep.requiresExplicitRiskApproval) return { decision: mapped };
      const phrase = riskConfirmationPhrase(ep);
      io.output.write(
        `\nThis plan contains ${ep.riskFlags.length} risky step(s). To accept this exact risk plan, type:\n  ${phrase}\n`,
      );
      const confirm = await ask("> ");
      if (confirm === phrase)
        return {
          decision: "approve",
          riskAcceptance: { accepted: true, riskPlanHash: ep.riskPlanHash ?? undefined },
        };
      io.output.write("Risk confirmation did not match. Treating as reject.\n");
      return { decision: "reject" };
    }
    return { decision: "reject" };
  } finally {
    close();
  }
}

/** Asks a yes/no question (discovery authorization). EOF or anything but "yes"/"y" is "no". */
export async function promptYesNo(question: string, io: PromptIO): Promise<boolean> {
  const { lines, close } = openLines(io);
  try {
    io.output.write(question);
    const next = await lines.next();
    if (next.done) return false;
    return /^(y|yes)$/i.test(String(next.value).trim());
  } finally {
    close();
  }
}

export const AUTONOMOUS_EDIT_INSTRUCTIONS = [
  "Edit the exported autonomous plan (remove scenarios, routes, roles or categories), then regenerate and re-approve:",
  "  pnpm browserswarm preview --plan <autonomous-plan.yaml> --profile <website-understanding-profile.json> --write <execution-plan.json>",
  "  pnpm browserswarm approve --plan <autonomous-plan.yaml> --profile <website-understanding-profile.json> --execution-plan <execution-plan.json>",
  "Or regenerate from the saved profile with exclusions (no new discovery):",
  "  pnpm browserswarm autonomous-plan --profile <website-understanding-profile.json> --exclude-route /blog --exclude-role responsive --output <autonomous-plan.yaml>",
  "Any edit changes the plan hash and requires a fresh approval.",
].join("\n");
