import { describe, expect, it } from "vitest";
import { classifyControl, isCookieDeclineLabel } from "../src/index.js";

describe("discovery control safety", () => {
  it.each([
    ["Delete product", "deletion"],
    ["Add to cart", "purchase"],
    ["Subscribe", "purchase"],
    ["Save changes", "data_modification"],
    ["Send message", "email_sms_sending"],
    ["Book now", "booking"],
    ["Upload photo", "file_upload"],
    ["Invite teammate", "invitation"],
    ["Publish", "social_posting"],
    ["Cancel", "subscription"],
    ["Log out", "authentication"],
  ])("button %s is restricted (%s)", (label, category) => {
    const r = classifyControl({ tag: "button", label });
    expect(r.kind).toBe("restricted");
    if (r.kind === "restricted") expect(r.category).toBe(category);
  });

  it("submit buttons and unknown controls are restricted by default", () => {
    expect(classifyControl({ tag: "button", type: "submit", label: "Go" }).kind).toBe("restricted");
    expect(classifyControl({ tag: "button", label: "Go", inForm: true }).kind).toBe("restricted");
    expect(classifyControl({ tag: "div", role: "button", label: "Mystery" }).kind).toBe("restricted");
    expect(classifyControl({ tag: "input", type: "file", label: "" }).kind).toBe("restricted");
  });

  it("tabs, disclosures and pagination are safe", () => {
    expect(classifyControl({ tag: "button", role: "tab", label: "Specifications" }).kind).toBe("safe-toggle");
    expect(classifyControl({ tag: "summary", label: "Shipping information" }).kind).toBe("safe-toggle");
    expect(classifyControl({ tag: "button", label: "Show details", ariaExpanded: "false" }).kind).toBe(
      "safe-toggle",
    );
    expect(classifyControl({ tag: "button", label: "Load more" }).kind).toBe("safe-pagination");
  });

  it("links: internal pages are safe, downloads/logout/side-effect URLs are restricted", () => {
    expect(classifyControl({ tag: "a", label: "Pricing", href: "https://x.test/pricing" })).toEqual({
      kind: "safe-navigation",
      authPage: false,
    });
    expect(classifyControl({ tag: "a", label: "Sign in", href: "https://x.test/login" })).toEqual({
      kind: "safe-navigation",
      authPage: true,
    });
    expect(
      classifyControl({ tag: "a", label: "Next", href: "https://x.test/p?page=2", inPagination: true }).kind,
    ).toBe("safe-pagination");
    for (const c of [
      { label: "Log out", href: "https://x.test/account/logout" },
      { label: "Catalog", href: "https://x.test/files/catalog.pdf" },
      { label: "Get it", href: "https://x.test/f", download: true },
      { label: "Remove", href: "https://x.test/items/1/delete" },
      { label: "Buy", href: "https://x.test/cart/add?id=1" },
      { label: "Mail us", href: "mailto:a@b.test" },
      { label: "Run", href: "javascript:void(0)" },
    ])
      expect(classifyControl({ tag: "a", ...c }).kind).toBe("restricted");
  });

  it("cookie banners are only declined, never accepted", () => {
    for (const l of [
      "Reject all",
      "Decline",
      "Only necessary",
      "Use necessary cookies only",
      "Essential only",
    ])
      expect(isCookieDeclineLabel(l)).toBe(true);
    for (const l of ["Accept all", "Accept", "OK", "Allow all", "Agree"])
      expect(isCookieDeclineLabel(l)).toBe(false);
  });
});
