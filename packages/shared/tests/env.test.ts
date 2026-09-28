import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { envSecrets, llmApiKeyFromEnv, loadDotEnv, parseDotEnv, targetFromEnv } from "../src/index.js";

describe("dotenv parsing and loading", () => {
  it("parses comments, quotes, export prefixes and inline comments", () => {
    expect(
      parseDotEnv(`# comment
BROWSERSWARM_TARGET_URL=https://staging.example.com
export QUOTED="a value # not a comment"
SINGLE='x y'
INLINE=value # trailing comment
EMPTY=
not a pair`),
    ).toEqual({
      BROWSERSWARM_TARGET_URL: "https://staging.example.com",
      QUOTED: "a value # not a comment",
      SINGLE: "x y",
      INLINE: "value",
      EMPTY: "",
    });
  });

  it("never overrides variables already set in the shell", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bs-env-"));
    const file = path.join(dir, ".env");
    await writeFile(file, "A=from-file\nB=from-file\n");
    const env: NodeJS.ProcessEnv = { A: "from-shell" };
    expect(loadDotEnv(file, env)).toBe(true);
    expect(env).toEqual({ A: "from-shell", B: "from-file" });
    expect(loadDotEnv(path.join(dir, "missing.env"), env)).toBe(false);
  });
});

describe("central target website", () => {
  it("derives allowed domains from the URL host unless configured", () => {
    expect(targetFromEnv({ BROWSERSWARM_TARGET_URL: "https://app.example.com:8443/start" })).toEqual({
      url: "https://app.example.com:8443/start",
      allowedDomains: ["app.example.com"],
    });
    expect(
      targetFromEnv({
        BROWSERSWARM_TARGET_URL: "https://app.example.com",
        BROWSERSWARM_ALLOWED_DOMAINS: "app.example.com, cdn.example.com",
      })?.allowedDomains,
    ).toEqual(["app.example.com", "cdn.example.com"]);
    expect(targetFromEnv({})).toBeUndefined();
    expect(targetFromEnv({ BROWSERSWARM_TARGET_URL: "  " })).toBeUndefined();
  });

  it("fails loudly on malformed or non-http URLs", () => {
    expect(() => targetFromEnv({ BROWSERSWARM_TARGET_URL: "staging.example.com" })).toThrow(
      /not a valid URL/,
    );
    expect(() => targetFromEnv({ BROWSERSWARM_TARGET_URL: "file:///etc/passwd" })).toThrow(/http/);
  });
});

describe("LLM API key", () => {
  it("is read from the env file and exported under the configured variable name", () => {
    expect(llmApiKeyFromEnv({})).toBeUndefined();
    expect(llmApiKeyFromEnv({ BROWSERSWARM_LLM_API_KEY: "" })).toBeUndefined();
    expect(llmApiKeyFromEnv({ BROWSERSWARM_LLM_API_KEY: "sk-test-123456" })).toEqual({
      value: "sk-test-123456",
      exportAs: "BROWSERSWARM_LLM_API_KEY",
    });
    expect(
      llmApiKeyFromEnv({
        BROWSERSWARM_LLM_API_KEY: "sk-test-123456",
        BROWSERSWARM_LLM_API_KEY_ENV: "ANTHROPIC_API_KEY",
      })?.exportAs,
    ).toBe("ANTHROPIC_API_KEY");
    expect(llmApiKeyFromEnv({ BROWSERSWARM_LLM_API_KEY: "sk-test-123456" }, "OPENAI_API_KEY")?.exportAs).toBe(
      "OPENAI_API_KEY",
    );
    expect(() =>
      llmApiKeyFromEnv({ BROWSERSWARM_LLM_API_KEY: "k-123456", BROWSERSWARM_LLM_API_KEY_ENV: "bad name" }),
    ).toThrow();
  });

  it("is registered as a secret for redaction", () => {
    expect(envSecrets({ BROWSERSWARM_LLM_API_KEY: "sk-test-123456" })).toEqual([
      { label: "BROWSERSWARM_LLM_API_KEY", value: "sk-test-123456" },
    ]);
    expect(envSecrets({})).toEqual([]);
  });
});
