import { describe, expect, it } from "vitest";
import { extractFromSnapshot, parseSnapshotTree } from "../src/snapshot-extract.js";

const SNAPSHOT = `- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - navigation "Main" [ref=e3]:
      - link "About us" [ref=e4] [cursor=pointer]:
        - /url: /about
  - main [ref=e6]:
    - heading "Welcome" [level=1] [ref=e7]
    - search [ref=e9]:
      - searchbox "Search" [ref=e11]
      - button "Go" [ref=e12]
    - generic [ref=e13]:
      - textbox "Password" [ref=e15]
      - button "Sign in" [ref=e16]
    - tablist [ref=e30]:
      - tab "Details" [ref=e31]
    - table "T" [ref=e18]:
      - rowgroup [ref=e20]:
        - row "A" [ref=e21]:
          - columnheader "A" [ref=e22]
        - row "1" [ref=e23]:
          - cell "1" [ref=e24]
  - contentinfo [ref=e26]:
    - link "Ext" [ref=e27] [cursor=pointer]:
      - /url: https://ext.example.com/
  - region "Cookie consent" [ref=e40]:
    - button "Reject all" [ref=e41]
    - button "Accept all" [ref=e42]`;

describe("extractFromSnapshot", () => {
  const x = extractFromSnapshot(SNAPSHOT, { url: "http://t/", title: "Home", maxInteractive: 100 });
  it("parses the tree with refs and urls", () => {
    const tree = parseSnapshotTree(SNAPSHOT);
    expect(tree.children[0]?.ref).toBe("e1");
  });
  it("reads links by landmark with refs", () => {
    expect(x.links.map((l) => [l.text, l.href, l.region])).toEqual([
      ["About us", "/about", "nav"],
      ["Ext", "https://ext.example.com/", "footer"],
    ]);
    expect(x.links[0]?.ref).toBe("e4");
  });
  it("treats only search landmarks as read-only GET forms", () => {
    const search = x.forms.find((f) => f.inSearchLandmark);
    expect(search?.method).toBe("get");
    expect(search?.inputRef).toBe("e11");
    const login = x.forms.find((f) => f.hasPassword);
    expect(login?.method).toBe("unknown");
    expect(x.loginSignals.passwordField).toBe(true);
  });
  it("flags cookie banner controls and exposes tables and tabs", () => {
    expect(x.cookieBanner.present).toBe(true);
    expect(x.controls.filter((c) => c.inCookieBanner).map((c) => c.label)).toEqual([
      "Reject all",
      "Accept all",
    ]);
    expect(x.controls.some((c) => c.role === "tab" && c.label === "Details")).toBe(true);
    expect(x.tables[0]).toMatchObject({ headers: ["A"], rowCount: 1 });
    expect(x.headings).toEqual([{ level: 1, text: "Welcome" }]);
  });
});
