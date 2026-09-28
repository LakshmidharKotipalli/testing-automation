export type ErrorCode =
  | "INVALID_TRANSITION"
  | "VALIDATION_FAILED"
  | "POLICY_VIOLATION"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_INVALIDATED"
  | "RISK_APPROVAL_REQUIRED"
  | "INTEGRITY_MISMATCH"
  | "HANDOFF_LIMIT_EXCEEDED"
  | "CHECKPOINT_PERSISTENCE_FAILED"
  | "NOT_IMPLEMENTED_IN_MILESTONE"
  | "LLM_OUTPUT_INVALID"
  | "LLM_BUDGET_EXHAUSTED";

export class BrowserSwarmError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BrowserSwarmError";
  }
}

export class InvalidTransitionError extends BrowserSwarmError {
  constructor(machine: string, from: string, to: string) {
    super("INVALID_TRANSITION", `Invalid ${machine} transition ${from} -> ${to}`, { machine, from, to });
    this.name = "InvalidTransitionError";
  }
}

export class ValidationError extends BrowserSwarmError {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super("VALIDATION_FAILED", `${message}\n  - ${issues.join("\n  - ")}`, { issues });
    this.name = "ValidationError";
  }
}

export class ApprovalError extends BrowserSwarmError {
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = "ApprovalError";
  }
}

export class IntegrityError extends BrowserSwarmError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("INTEGRITY_MISMATCH", message, details);
    this.name = "IntegrityError";
  }
}

export class PolicyViolationError extends BrowserSwarmError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("POLICY_VIOLATION", message, details);
    this.name = "PolicyViolationError";
  }
}
