import type { Page } from "playwright";

/** Attribute used to address extracted controls for safe interactions (attribute only; no behavior change). */
export const CONTROL_ATTR = "data-bsw-discovery-idx";

export interface ExtractedLink {
  idx: number;
  text: string;
  href: string;
  download: boolean;
  region: "nav" | "header" | "footer" | "aside" | "breadcrumb" | "pagination" | "main";
  regionLabel: string;
}

export interface ExtractedControl {
  idx: number;
  tag: string;
  role: string | null;
  type: string | null;
  label: string;
  inForm: boolean;
  ariaExpanded: string | null;
  ariaControls: boolean;
  ariaHasPopup: string | null;
  inPagination: boolean;
  inCookieBanner: boolean;
  visible: boolean;
  testId: string | null;
}

export interface ExtractedFormField {
  name: string;
  type: string;
  label: string;
  required: boolean;
  /** Option values of a <select> (bounded). Never the value of a text field. */
  options: string[];
}

export interface ExtractedForm {
  index: number;
  name: string;
  role: string | null;
  method: string;
  action: string;
  fields: ExtractedFormField[];
  submitLabel: string;
  hasPassword: boolean;
  hasFile: boolean;
  inSearchLandmark: boolean;
}

export interface ExtractedTable {
  caption: string;
  headers: string[];
  rowCount: number;
  sampleRows: string[][];
  role: "table" | "grid";
}

export interface PageExtract {
  url: string;
  title: string;
  lang: string;
  metaDescription: string;
  headings: { level: number; text: string }[];
  landmarks: string[];
  links: ExtractedLink[];
  controls: ExtractedControl[];
  forms: ExtractedForm[];
  tables: ExtractedTable[];
  cards: { heading: string; fields: string[] }[];
  media: { src: string; broken: boolean }[];
  errorTexts: string[];
  emptyStateTexts: string[];
  mainText: string;
  dialogs: number;
  iframes: number;
  cookieBanner: { present: boolean; labels: string[] };
  loginSignals: { passwordField: boolean; loginHeading: boolean };
  numbers: { label: string; value: string }[];
  truncated: boolean;
}

/**
 * The single, fixed in-page extraction used by discovery (no arbitrary script evaluation). It reads
 * structure, labels and visible text only: input values are never read, and every string is bounded.
 */
export async function extractPage(page: Page, maxInteractive: number): Promise<PageExtract> {
  // Some TS runners (tsx/esbuild keepNames) wrap named inner functions in __name(); define a no-op so the
  // serialized function runs unchanged in the page.
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  return page.evaluate(
    ({ max, attr }) => {
      const clip = (s: string | null | undefined, n = 160) =>
        (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      const visible = (el: Element) => {
        const h = el as HTMLElement;
        if (!h.getClientRects || h.getClientRects().length === 0) return false;
        const st = getComputedStyle(h);
        return st.visibility !== "hidden" && st.display !== "none";
      };
      const byId = (id: string) => document.getElementById(id);
      const labelOf = (el: Element): string => {
        const aria = el.getAttribute("aria-label");
        if (aria) return clip(aria);
        const lb = el.getAttribute("aria-labelledby");
        if (lb)
          return clip(
            lb
              .split(/\s+/)
              .map((id) => byId(id)?.textContent ?? "")
              .join(" "),
          );
        const tag = el.tagName.toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") {
          const id = el.getAttribute("id");
          if (id) {
            const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (l) return clip(l.textContent);
          }
          const wrap = el.closest("label");
          if (wrap) return clip(wrap.textContent);
          const type = (el.getAttribute("type") ?? "").toLowerCase();
          if (type === "submit" || type === "button" || type === "reset")
            return clip((el as HTMLInputElement).value || type);
          return clip(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name"));
        }
        const text = clip((el as HTMLElement).innerText ?? el.textContent);
        if (text) return text;
        const img = el.querySelector("img[alt]");
        if (img) return clip(img.getAttribute("alt"));
        return clip(el.getAttribute("title"));
      };
      const regionOf = (el: Element): { region: ExtractedLink["region"]; label: string } => {
        const pag = el.closest(
          '[aria-label*="pagination" i], [class*="pagination" i], nav[aria-label*="pages" i]',
        );
        if (pag) return { region: "pagination", label: clip(pag.getAttribute("aria-label")) };
        const crumb = el.closest('[aria-label*="breadcrumb" i], [class*="breadcrumb" i]');
        if (crumb) return { region: "breadcrumb", label: "breadcrumb" };
        const nav = el.closest("nav, [role=navigation]");
        if (nav) return { region: "nav", label: clip(nav.getAttribute("aria-label")) };
        if (el.closest("footer, [role=contentinfo]")) return { region: "footer", label: "footer" };
        if (el.closest("header, [role=banner]")) return { region: "header", label: "header" };
        if (el.closest("aside, [role=complementary]")) return { region: "aside", label: "aside" };
        return { region: "main", label: "" };
      };
      const cookieRoot = (() => {
        const candidates = Array.from(
          document.querySelectorAll(
            '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [role=dialog], [role=alertdialog]',
          ),
        );
        return (
          candidates.find(
            (c) => visible(c) && /cookie|consent|gdpr|tracking/i.test((c as HTMLElement).innerText ?? ""),
          ) ?? null
        );
      })();

      let idx = 0;
      let truncated = false;
      const links: ExtractedLink[] = [];
      for (const a of Array.from(document.querySelectorAll("a[href], [role=link][href]"))) {
        if (links.length >= max) {
          truncated = true;
          break;
        }
        const href = (a as HTMLAnchorElement).href || a.getAttribute("href") || "";
        const r = regionOf(a);
        const i = idx++;
        a.setAttribute(attr, String(i));
        links.push({
          idx: i,
          text: labelOf(a),
          href,
          download: a.hasAttribute("download"),
          region: r.region,
          regionLabel: r.label,
        });
      }

      const controls: ExtractedControl[] = [];
      const controlSel =
        "button, input[type=submit], input[type=button], input[type=reset], input[type=image], input[type=file], [role=button], [role=tab], [role=menuitem], summary, [aria-expanded]:not(a)";
      for (const el of Array.from(document.querySelectorAll(controlSel))) {
        if (controls.length >= max) {
          truncated = true;
          break;
        }
        if (el.hasAttribute(attr)) continue;
        const i = idx++;
        el.setAttribute(attr, String(i));
        controls.push({
          idx: i,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          type: el.getAttribute("type"),
          label: labelOf(el),
          inForm: !!el.closest("form"),
          ariaExpanded: el.getAttribute("aria-expanded"),
          ariaControls: el.hasAttribute("aria-controls"),
          ariaHasPopup: el.getAttribute("aria-haspopup"),
          inPagination: regionOf(el).region === "pagination",
          inCookieBanner: !!cookieRoot && cookieRoot.contains(el),
          visible: visible(el),
          testId: el.getAttribute("data-testid"),
        });
      }

      const forms: ExtractedForm[] = Array.from(document.querySelectorAll("form"))
        .slice(0, 50)
        .map((f, index) => {
          const fields: ExtractedFormField[] = Array.from(f.querySelectorAll("input, select, textarea"))
            .filter(
              (el) =>
                !["hidden", "submit", "button", "reset", "image"].includes(
                  (el.getAttribute("type") ?? "").toLowerCase(),
                ),
            )
            .slice(0, 30)
            .map((el) => ({
              name: clip(el.getAttribute("name") ?? el.getAttribute("id"), 80),
              type:
                el.tagName.toLowerCase() === "input"
                  ? (el.getAttribute("type") ?? "text").toLowerCase()
                  : el.tagName.toLowerCase(),
              label: labelOf(el),
              required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
              options:
                el.tagName.toLowerCase() === "select"
                  ? Array.from((el as HTMLSelectElement).options)
                      .slice(0, 20)
                      .map((o) => clip(o.value, 80))
                  : [],
            }));
          const submit = f.querySelector(
            "button[type=submit], button:not([type]), input[type=submit], input[type=image]",
          );
          return {
            index,
            name: clip(f.getAttribute("aria-label") || f.getAttribute("name") || f.getAttribute("id") || ""),
            role: f.getAttribute("role"),
            method: (f.getAttribute("method") ?? "get").toLowerCase(),
            action: (f as HTMLFormElement).action || location.href,
            fields,
            submitLabel: submit ? labelOf(submit) : "",
            hasPassword: !!f.querySelector("input[type=password]"),
            hasFile: !!f.querySelector("input[type=file]"),
            inSearchLandmark: !!f.closest("[role=search], search") || f.getAttribute("role") === "search",
          };
        });

      const tables: ExtractedTable[] = Array.from(
        document.querySelectorAll("table, [role=grid], [role=table]"),
      )
        .slice(0, 20)
        .map((t) => {
          const headers = Array.from(t.querySelectorAll("th, [role=columnheader]"))
            .slice(0, 20)
            .map((h) => clip(h.textContent, 60));
          const rows = Array.from(t.querySelectorAll("tbody tr, [role=row]")).filter(
            (r) => !r.querySelector("th, [role=columnheader]"),
          );
          return {
            caption: clip(t.querySelector("caption")?.textContent ?? t.getAttribute("aria-label")),
            headers,
            rowCount: rows.length,
            sampleRows: rows.slice(0, 3).map((r) =>
              Array.from(r.querySelectorAll("td, [role=cell], [role=gridcell]"))
                .slice(0, 8)
                .map((c) => clip(c.textContent, 60)),
            ),
            role: t.getAttribute("role") === "grid" ? "grid" : "table",
          };
        });

      const cards = Array.from(document.querySelectorAll('article, [class*="card" i], main li'))
        .filter((c) => !!c.querySelector("h2, h3, h4"))
        .slice(0, 30)
        .map((c) => ({
          heading: clip(c.querySelector("h1, h2, h3, h4")?.textContent, 100),
          fields: Array.from(c.querySelectorAll("dt, strong, b, [class*='label' i]"))
            .slice(0, 8)
            .map((f) => clip(f.textContent, 40))
            .filter(Boolean),
        }))
        .filter((c) => c.heading);

      const media = Array.from(document.images)
        .slice(0, 100)
        .map((img) => ({
          src: clip(img.currentSrc || img.src, 300),
          broken: img.complete && img.naturalWidth === 0 && !!(img.currentSrc || img.src),
        }));

      const alertTexts = Array.from(
        document.querySelectorAll('[role=alert], .error, [class*="error" i], [aria-live=assertive]'),
      )
        .filter(visible)
        .map((e) => clip((e as HTMLElement).innerText, 200))
        .filter(Boolean)
        .slice(0, 10);
      const main = (document.querySelector("main, [role=main]") ?? document.body) as HTMLElement;
      const mainText = clip(main?.innerText, 4000);
      const errorTexts = [...alertTexts];
      if (
        /\b(404|not found|page not found|something went wrong|internal server error|access denied)\b/i.test(
          document.title + " " + mainText.slice(0, 300),
        )
      )
        errorTexts.push(clip(document.title || mainText.slice(0, 120)));
      const emptyStateTexts = (
        mainText.match(/[^.\n]*\b(no results|nothing found|no items|no data|empty)\b[^.\n]*/gi) ?? []
      )
        .slice(0, 5)
        .map((t) => clip(t, 160));

      const numbers = Array.from(document.querySelectorAll("dl > dt"))
        .slice(0, 30)
        .map((dt) => ({
          label: clip(dt.textContent, 60),
          value: clip(dt.nextElementSibling?.textContent, 60),
        }))
        .filter((n) => /\d/.test(n.value));

      const landmarks = Array.from(
        document.querySelectorAll(
          "header, nav, main, aside, footer, [role=banner], [role=navigation], [role=main], [role=complementary], [role=contentinfo], [role=search], form[aria-label]",
        ),
      )
        .slice(0, 30)
        .map((l) => l.getAttribute("role") ?? l.tagName.toLowerCase());

      return {
        url: location.href,
        title: clip(document.title, 200),
        lang: document.documentElement.lang || "",
        metaDescription: clip(
          document.querySelector('meta[name="description"]')?.getAttribute("content"),
          300,
        ),
        headings: Array.from(document.querySelectorAll("h1, h2, h3"))
          .slice(0, 40)
          .map((h) => ({ level: Number(h.tagName.slice(1)), text: clip(h.textContent, 150) }))
          .filter((h) => h.text),
        landmarks: Array.from(new Set(landmarks)),
        links,
        controls,
        forms,
        tables,
        cards,
        media,
        errorTexts,
        emptyStateTexts,
        mainText,
        dialogs: document.querySelectorAll("dialog[open], [role=dialog]:not([hidden])").length,
        iframes: document.querySelectorAll("iframe").length,
        cookieBanner: {
          present: !!cookieRoot,
          labels: cookieRoot
            ? Array.from(cookieRoot.querySelectorAll("button, [role=button], a"))
                .slice(0, 10)
                .map((b) => labelOf(b))
            : [],
        },
        loginSignals: {
          passwordField: !!document.querySelector("input[type=password]"),
          loginHeading: /\b(sign in|log in|login)\b/i.test(
            Array.from(document.querySelectorAll("h1, h2"))
              .map((h) => h.textContent ?? "")
              .join(" "),
          ),
        },
        numbers,
        truncated,
      };
    },
    { max: maxInteractive, attr: CONTROL_ATTR },
  );
}

/** Fixed horizontal-overflow measurement (same as the executor's assert_no_horizontal_overflow). */
export async function measureOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}
