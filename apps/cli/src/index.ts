#!/usr/bin/env node
import { BrowserSwarmError, ValidationError } from "@browserswarm/core";
import { Command, InvalidArgumentError } from "commander";
import {
  cmdApprove,
  cmdPlan,
  cmdPreview,
  cmdReport,
  cmdRun,
  cmdValidate,
  EXIT,
  type CliIO,
} from "./commands.js";

const io: CliIO = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
};

const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
};
const collect = (v: string, prev: string[] = []) => [
  ...prev,
  ...v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  process.stderr.write("\nCancelling: checkpointing active packets (Ctrl+C again to force)...\n");
  controller.abort("SIGINT");
});

async function main(argv: string[]): Promise<number> {
  let code: number = EXIT.OK;
  const program = new Command()
    .name("browserswarm")
    .description(
      "Approval-first, deterministic-by-default browser testing. Only test sites you are authorized to test.",
    )
    .showHelpAfterError();

  program
    .command("plan")
    .description(
      "Compile a natural-language prompt (or normalize a YAML/JSON plan) into an editable YAML test plan",
    )
    .option("--url <url>", "target URL (required with --prompt)")
    .option("--prompt <file>", "natural-language testing request (Markdown)")
    .option("--plan <file>", "existing YAML/JSON plan to normalize")
    .option("--allowed-domain <domains>", "allowed domain(s), comma separated", collect)
    .requiredOption("--output <file>", "where to write the YAML plan")
    .action(async (o) => {
      code = await cmdPlan(io, o);
    });

  program
    .command("validate")
    .description("Validate a test plan (schema, references, safety policy)")
    .requiredOption("--plan <file>")
    .action(async (o) => {
      code = await cmdValidate(io, o);
    });

  program
    .command("preview")
    .description("Generate the exact execution plan and show the approval review (starts no browser)")
    .requiredOption("--plan <file>")
    .option("--parallel <n>", "maximum concurrent work packets", positiveInt)
    .option("--write <file>", "write the execution plan JSON")
    .option("--run-id <id>", "explicit run id")
    .action(async (o) => {
      code = await cmdPreview(io, o);
    });

  program
    .command("approve")
    .description("Approve, reject, export or edit an exact execution plan")
    .requiredOption("--plan <file>")
    .requiredOption("--execution-plan <file>")
    .option("--output <file>", "approved plan path (default: next to the execution plan)")
    .option("--yes", "noninteractive approval (CI)")
    .option("--accept-risk", "accept the plan's risky steps (requires --risk-plan-hash)")
    .option("--risk-plan-hash <hash>", "the exact risk plan hash shown in the review")
    .option("--operator <name>", "operator recorded in the approval record")
    .action(async (o) => {
      code = await cmdApprove(io, o);
    });

  program
    .command("run")
    .description("Run an approved plan, or plan+approve+run interactively from --prompt/--plan")
    .option("--approved-plan <file>", "approved execution plan JSON")
    .option(
      "--plan <file>",
      "YAML/JSON plan (interactive shortcut, or approval re-check with --approved-plan)",
    )
    .option("--prompt <file>", "natural-language testing request (interactive shortcut)")
    .option("--url <url>", "target URL (with --prompt)")
    .option("--allowed-domain <domains>", "allowed domain(s), comma separated", collect)
    .option("--parallel <n>", "maximum concurrent work packets", positiveInt)
    .option("--output <dir>", "run artifact directory (default artifacts/<runId>)")
    .option("--yes", "noninteractive approval (CI)")
    .option("--accept-risk", "accept the plan's risky steps (requires --risk-plan-hash)")
    .option("--risk-plan-hash <hash>")
    .option("--operator <name>")
    .action(async (o) => {
      code = await cmdRun(io, o, controller.signal);
    });

  program
    .command("report")
    .description("Re-render the Markdown report of a run directory")
    .requiredOption("--run <dir>")
    .action(async (o) => {
      code = await cmdReport(io, o);
    });

  await program.parseAsync(argv);
  return code;
}

main(process.argv).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(EXIT.INVALID);
    }
    if (error instanceof BrowserSwarmError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exit(error.code === "VALIDATION_FAILED" ? EXIT.INVALID : EXIT.APPROVAL);
    }
    process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
    process.exit(EXIT.TEST_FAILURES);
  },
);
