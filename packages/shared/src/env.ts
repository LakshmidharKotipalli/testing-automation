import { readFileSync } from "node:fs";

/** Environment variable names BrowserSwarm reads. The target website is configured in one place. */
export const ENV = {
  /** The website under test, e.g. https://staging.example.com. Used by every plan without target.url. */
  TARGET_URL: "BROWSERSWARM_TARGET_URL",
  /** Optional comma-separated allowed domains. Defaults to the host of BROWSERSWARM_TARGET_URL. */
  ALLOWED_DOMAINS: "BROWSERSWARM_ALLOWED_DOMAINS",
  /** Optional path of the env file to load instead of ./.env. */
  ENV_FILE: "BROWSERSWARM_ENV_FILE",
} as const;

/** Parses dotenv text: KEY=value lines, `#` comments, blank lines, optional quotes and `export ` prefix. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] as string).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] as string;
    else value = value.replace(/\s+#.*$/, "");
    out[m[1] as string] = value;
  }
  return out;
}

/**
 * Loads an env file into `env` without overriding variables that are already set, so values exported in
 * the shell or CI always win. Returns false when the file does not exist.
 */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

export interface EnvTarget {
  url: string;
  allowedDomains: string[];
}

/**
 * The centrally configured target website, or undefined when BROWSERSWARM_TARGET_URL is not set.
 * Throws on a malformed URL so a typo in .env fails loudly instead of testing the wrong site.
 */
export function targetFromEnv(env: NodeJS.ProcessEnv = process.env): EnvTarget | undefined {
  const raw = env[ENV.TARGET_URL]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${ENV.TARGET_URL} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${ENV.TARGET_URL} must be an http(s) URL: ${raw}`);
  }
  const domains = (env[ENV.ALLOWED_DOMAINS] ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return { url: raw, allowedDomains: domains.length ? domains : [url.hostname] };
}

/** LLM credentials, kept in the same env file. Values never enter plans, hashes, artifacts or reports. */
export const LLM_ENV = {
  /** The model provider API key. */
  API_KEY: "BROWSERSWARM_LLM_API_KEY",
  /**
   * Name of the variable the model runtime (OpenCode / the provider SDK it wraps) reads the key from, e.g.
   * ANTHROPIC_API_KEY or OPENAI_API_KEY. The key is exported under this name to the OpenCode process only.
   */
  API_KEY_ENV: "BROWSERSWARM_LLM_API_KEY_ENV",
} as const;

export interface LlmApiKey {
  value: string;
  /** Variable name the child model process receives the key under. */
  exportAs: string;
}

/** The centrally configured LLM API key, or undefined when none is set (OpenCode's own login is used). */
export function llmApiKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  exportAs?: string,
): LlmApiKey | undefined {
  const value = env[LLM_ENV.API_KEY]?.trim();
  if (!value) return undefined;
  const name = exportAs || env[LLM_ENV.API_KEY_ENV]?.trim() || LLM_ENV.API_KEY;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`${LLM_ENV.API_KEY_ENV} must be an environment variable name, got: ${name}`);
  }
  return { value, exportAs: name };
}

/** Secret values from the env file that every redactor must mask (currently the LLM API key). */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): { label: string; value: string }[] {
  const key = env[LLM_ENV.API_KEY]?.trim();
  return key ? [{ label: LLM_ENV.API_KEY, value: key }] : [];
}
