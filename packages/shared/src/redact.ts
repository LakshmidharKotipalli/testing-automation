/** Keys whose values are always treated as sensitive, wherever they appear. */
export const SENSITIVE_KEY_PATTERN =
  /password|passwd|passphrase|secret|token|cookie|authorization|auth[-_]?header|session|api[-_]?key|credential|private[-_]?key|card|cvv|cvc|iban|ssn|otp|pin$/i;

/**
 * Value shapes redacted even when not declared: bearer tokens and JWTs. (Card numbers and other personal
 * data are declared as test data and redacted by value; generic digit-run patterns would corrupt hashes.)
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export interface SecretValue {
  /** Label shown in place of the secret, e.g. `testData.invalidPassword`. */
  label: string;
  value: string;
}

export interface Redactor {
  redactString(input: string): string;
  redactValue<T>(input: T): T;
  /** True when any registered secret value or sensitive pattern appears in the input. */
  containsSecret(input: string): boolean;
  readonly secretCount: number;
}

/**
 * Builds a redactor for a set of known sensitive values (resolved test data, storage tokens, ...).
 * Longer values are replaced first so overlapping secrets never leak a suffix.
 */
export function createRedactor(secrets: SecretValue[] = []): Redactor {
  const known = secrets
    // Values shorter than 4 characters cannot be matched reliably without false positives.
    .filter((s) => s.value.length >= 4)
    .sort((a, b) => b.value.length - a.value.length);

  const redactString = (input: string): string => {
    let out = input;
    for (const secret of known) {
      if (out.includes(secret.value)) {
        out = out.split(secret.value).join(`[REDACTED:${secret.label}]`);
      }
    }
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      out = out.replace(pattern, "[REDACTED:pattern]");
    }
    return out;
  };

  const redactValue = <T>(input: T): T => redactDeep(input, redactString) as T;

  const containsSecret = (input: string): boolean => {
    if (known.some((s) => input.includes(s.value))) return true;
    return SENSITIVE_VALUE_PATTERNS.some((p) => {
      p.lastIndex = 0;
      const hit = p.test(input);
      p.lastIndex = 0;
      return hit;
    });
  };

  return { redactString, redactValue, containsSecret, secretCount: known.length };
}

function redactDeep(value: unknown, redactString: (s: string) => string, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key) && value.length > 0 && !value.startsWith("{{")) {
      return `[REDACTED:${key}]`;
    }
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactString));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, redactString, k);
    }
    return out;
  }
  return value;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}…[truncated ${text.length - maxChars + 20} chars]`;
}
