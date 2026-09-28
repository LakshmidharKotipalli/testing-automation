import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ApprovalDecision, ExecutionPlan } from "@browserswarm/core";

export interface PromptIO {
  input: Readable;
  output: Writable;
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
