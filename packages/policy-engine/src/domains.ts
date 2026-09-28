export interface DomainScope {
  allowedDomains: string[];
  allowSubdomains: boolean;
}

/** Schemes that never leave the browser and are always safe to load. */
const LOCAL_SCHEMES = new Set(["about:", "data:", "blob:"]);

export function hostMatches(host: string, scope: DomainScope): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return scope.allowedDomains.some((d) => {
    const domain = d.toLowerCase();
    return h === domain || (scope.allowSubdomains && h.endsWith(`.${domain}`));
  });
}

export interface UrlCheck {
  allowed: boolean;
  url?: string;
  reason?: string;
}

/**
 * Resolves `raw` against `base` and checks it against the allowed domains. Ports are not part of the
 * domain scope (a fixture on 127.0.0.1:4173 is matched by allowedDomains: [127.0.0.1]). Only http(s)
 * and browser-local schemes are permitted.
 */
export function checkUrl(raw: string, base: string, scope: DomainScope): UrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return { allowed: false, reason: `unparseable URL: ${raw}` };
  }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return { allowed: true, url: parsed.toString() };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, url: parsed.toString(), reason: `scheme ${parsed.protocol} is not allowed` };
  }
  if (parsed.username || parsed.password) {
    return { allowed: false, url: parsed.origin, reason: "URLs with embedded credentials are not allowed" };
  }
  if (!hostMatches(parsed.hostname, scope)) {
    return {
      allowed: false,
      url: parsed.toString(),
      reason: `host ${parsed.hostname} is outside allowed domains [${scope.allowedDomains.join(", ")}]`,
    };
  }
  return { allowed: true, url: parsed.toString() };
}
