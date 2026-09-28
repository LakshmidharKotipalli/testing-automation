#!/usr/bin/env node
import { BrowserSwarmError, ValidationError } from "@browserswarm/core";
import path from "node:path";
import { ENV, loadDotEnv } from "@browserswarm/shared";
import { Command, InvalidArgumentError } from "commander";
import {
  cmdApprove,
  cmdAutonomousPlan,
  cmdDiscover,
  cmdPlan,
  cmdPreview,
  cmdReport,
  cmdRun,
  cmdValidate,
  EXIT,
  type CliIO,
} from "./commands.js";

// Central configuration (target website, LLM API key, secrets): ./.env or $BROWSERSWARM_ENV_FILE.
// Variables already exported in the shell take precedence over the file.
loadDotEnv(process.env[ENV.ENV_FILE] ?? path.resolve(process.cwd(), ".env"));

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

const mode = (v: string) => {
  if (v !== "instruction-led" && v !== "autonomous")
    throw new InvalidArgumentError("must be instruction-led or autonomous");
  return v;
};

/** Scope flags shared by run, discover and autonomous-plan (autonomous plans only). */
function scopeOptions(cmd: Command): Command {
  return cmd
    .option("--exclude-scenario <ids>", "autonomous: remove scenario id(s) from the plan", collect)
    .option("--exclude-route <routes>", "autonomous: remove scenarios touching route(s), e.g. /blog", collect)
    .option("--exclude-role <roles>", "autonomous: remove agent role(s), e.g. responsive", collect)
    .option("--exclude-category <categories>", "autonomous: remove categories, e.g. forms,search", collect)
    .option("--only-role <roles>", "autonomous: plan only these agent role(s)", collect);
}

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
    .option("--url <url>", "target URL (default: BROWSERSWARM_TARGET_URL from .env)")
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
    .option(
      "--profile <file>",
      "autonomous plans: website-understanding-profile.json to check the plan against",
    )
    .action(async (o) => {
      code = await cmdPreview(io, o);
    });

  program
    .command("approve")
    .description("Approve, reject, export or edit an exact execution plan")
    .requiredOption("--plan <file>")
    .requiredOption("--execution-plan <file>")
    .option("--profile <file>", "autonomous plans: bind the approval to this discovery profile")
    .option("--output <file>", "approved plan path (default: next to the execution plan)")
    .option("--yes", "noninteractive approval (CI)")
    .option("--accept-risk", "accept the plan's risky steps (requires --risk-plan-hash)")
    .option("--risk-plan-hash <hash>", "the exact risk plan hash shown in the review")
    .option("--operator <name>", "operator recorded in the approval record")
    .action(async (o) => {
      code = await cmdApprove(io, o);
    });

  scopeOptions(
    program
      .command("run")
      .description(
        "Run an approved plan; or plan+approve+run from --plan/--prompt (instruction-led); or discover+plan+approve+run from a URL alone (autonomous)",
      )
      .option("--approved-plan <file>", "approved execution plan JSON")
      .option(
        "--plan <file>",
        "YAML/JSON plan (interactive shortcut, or approval re-check with --approved-plan)",
      )
      .option("--prompt <file>", "natural-language testing request")
      .option("--prompt-text <text>", "natural-language testing request given inline")
      .option(
        "--mode <mode>",
        "instruction-led | autonomous (default: instruction-led with explicit scenarios/steps, autonomous for a URL alone or a broad request)",
        mode,
      )
      .option("--url <url>", "target URL (default: BROWSERSWARM_TARGET_URL from .env)")
      .option("--allowed-domain <domains>", "allowed domain(s), comma separated", collect)
      .option("--parallel <n>", "maximum concurrent work packets", positiveInt)
      .option("--output <dir>", "run artifact directory (default artifacts/<runId>)")
      .option(
        "--confirm-authorized",
        "autonomous: state that you are authorized to test the target (noninteractive)",
      )
      .option(
        "--discovery-config <file>",
        "autonomous: YAML/JSON with discovery limits, browser, discoveryModel",
      )
      .option("--yes", "noninteractive approval (CI)")
      .option("--accept-risk", "accept the plan's risky steps (requires --risk-plan-hash)")
      .option("--risk-plan-hash <hash>")
      .option("--operator <name>"),
  ).action(async (o) => {
    code = await cmdRun(io, o, controller.signal);
  });

  scopeOptions(
    program
      .command("discover")
      .description(
        "Autonomous read-only discovery: Website Understanding Profile, generated test plan and review. Runs no tests.",
      )
      .option("--url <url>", "target URL (default: BROWSERSWARM_TARGET_URL from .env)")
      .option("--allowed-domain <domains>", "allowed domain(s), comma separated", collect)
      .option("--prompt <file>", "optional high-level intent (never broadens safety)")
      .option("--prompt-text <text>", "optional high-level intent given inline")
      .option("--parallel <n>", "maximum concurrent work packets in the generated plan", positiveInt)
      .option("--output <dir>", "run artifact directory (default artifacts/<runId>)")
      .option("--confirm-authorized", "state that you are authorized to test the target (noninteractive)")
      .option("--discovery-config <file>", "YAML/JSON with discovery limits, browser, discoveryModel")
      .option("--operator <name>"),
  ).action(async (o) => {
    code = await cmdDiscover(io, o, controller.signal);
  });

  scopeOptions(
    program
      .command("autonomous-plan")
      .description("Regenerate an autonomous test plan from a saved discovery profile (no browser)")
      .requiredOption("--profile <file>", "website-understanding-profile.json")
      .requiredOption("--output <file>", "where to write the YAML plan")
      .option("--write <file>", "also write the execution plan JSON")
      .option("--parallel <n>", "maximum concurrent work packets", positiveInt)
      .option("--run-id <id>", "explicit run id"),
  ).action(async (o) => {
    code = await cmdAutonomousPlan(io, o);
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
