import type {
  ExtractedControl,
  ExtractedForm,
  ExtractedFormField,
  ExtractedLink,
  PageExtract,
} from "./extract.js";

/** A node of the MCP accessibility snapshot (YAML-like `- role "name" [attr] [ref=e1]:` lines). */
export interface SnapNode {
  role: string;
  name: string;
  attrs: Record<string, string | true>;
  ref?: string;
  inline?: string;
  url?: string;
  children: SnapNode[];
  parent?: SnapNode;
}

const LINE = /^(\s*)- (.*)$/;
const HEAD = /^([\w-]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)(?::(?: (.*))?)?$/;

export function parseSnapshotTree(text: string): SnapNode {
  const root: SnapNode = { role: "root", name: "", attrs: {}, children: [] };
  const stack: Array<{ indent: number; node: SnapNode }> = [{ indent: -1, node: root }];
  for (const raw of text.split("\n")) {
    const m = raw.match(LINE);
    if (!m) continue;
    const indent = m[1]!.length;
    const body = m[2]!;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    if (body.startsWith("/url:")) {
      parent.url = body.slice(5).trim();
      continue;
    }
    if (body.startsWith("/")) continue;
    if (body.startsWith("text:")) {
      parent.children.push({
        role: "text",
        name: body.slice(5).trim(),
        attrs: {},
        children: [],
        parent,
      });
      continue;
    }
    const h = body.match(HEAD);
    if (!h) continue;
    const attrs: Record<string, string | true> = {};
    let ref: string | undefined;
    for (const a of h[3]?.matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g) ?? []) {
      if (a[1] === "ref") ref = a[2];
      else attrs[a[1]!] = a[2] ?? true;
    }
    const node: SnapNode = {
      role: h[1]!,
      name: (h[2] ?? "").replace(/\\"/g, '"'),
      attrs,
      ...(ref ? { ref } : {}),
      ...(h[4] ? { inline: h[4] } : {}),
      children: [],
      parent,
    };
    parent.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

function* walk(n: SnapNode): Generator<SnapNode> {
  for (const c of n.children) {
    yield c;
    yield* walk(c);
  }
}
const ancestors = (n: SnapNode): SnapNode[] => {
  const out: SnapNode[] = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out;
};
const clip = (s: string | undefined, n = 160) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const textOf = (n: SnapNode): string =>
  [n.role === "text" ? n.name : n.inline, ...n.children.map(textOf)].filter(Boolean).join(" ");
const nameOf = (n: SnapNode): string => clip(n.name || n.inline || textOf(n));

const INPUT_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "spinbutton",
  "slider",
]);
const CONTROL_ROLES = new Set([
  "button",
  "tab",
  "switch",
  "checkbox",
  "radio",
  "combobox",
  "textbox",
  "searchbox",
  "menuitem",
  "spinbutton",
  "slider",
]);
const COOKIE = /cookie|consent|gdpr|privacy preferences/i;

function regionOf(n: SnapNode): { region: ExtractedLink["region"]; label: string } {
  for (const a of ancestors(n)) {
    if (a.role === "navigation") {
      if (/breadcrumb/i.test(a.name)) return { region: "breadcrumb", label: clip(a.name, 80) };
      if (/pagination|pager|page \d/i.test(a.name)) return { region: "pagination", label: clip(a.name, 80) };
      return { region: "nav", label: clip(a.name, 80) };
    }
    if (a.role === "banner") return { region: "header", label: clip(a.name, 80) };
    if (a.role === "contentinfo") return { region: "footer", label: clip(a.name, 80) };
    if (a.role === "complementary") return { region: "aside", label: clip(a.name, 80) };
    if (a.role === "main") return { region: "main", label: clip(a.name, 80) };
  }
  return { region: "main", label: "" };
}

function fieldType(n: SnapNode): string {
  const label = n.name;
  switch (n.role) {
    case "searchbox":
      return "search";
    case "combobox":
      return "select";
    case "spinbutton":
      return "number";
    case "slider":
      return "range";
    case "checkbox":
    case "radio":
      return n.role;
    default:
      return /password/i.test(label) ? "password" : "text";
  }
}

export interface SnapshotExtractOptions {
  url: string;
  title: string;
  maxInteractive: number;
}

/**
 * Builds the discovery `PageExtract` from the MCP accessibility snapshot only (no page scripts). Things a
 * snapshot cannot express (form method/action/field names, meta description, document language, collapsed
 * aria-expanded state) are left empty or conservative; the crawler records them as limitations.
 */
export function extractFromSnapshot(snapshot: string, o: SnapshotExtractOptions): PageExtract {
  const tree = parseSnapshotTree(snapshot);
  const nodes = [...walk(tree)];

  const cookieRoots = nodes.filter(
    (n) =>
      ["dialog", "alertdialog", "region", "banner", "complementary", "generic", "group"].includes(n.role) &&
      (COOKIE.test(n.name) || (n.role !== "generic" && COOKIE.test(textOf(n)))) &&
      [...walk(n)].some((c) => c.role === "button"),
  );
  // Prefer the deepest matching container so unrelated siblings are not treated as banner controls.
  const banner = cookieRoots.filter((r) => !cookieRoots.some((o2) => o2 !== r && ancestors(o2).includes(r)));
  const inBanner = (n: SnapNode) => banner.some((b) => ancestors(n).includes(b));

  const links: ExtractedLink[] = [];
  const controls: ExtractedControl[] = [];
  let idx = 0;
  let truncated = false;
  for (const n of nodes) {
    if (n.role === "link" && n.url !== undefined) {
      const r = regionOf(n);
      links.push({
        idx: idx++,
        text: nameOf(n),
        href: n.url,
        download: false,
        region: r.region,
        regionLabel: r.label,
        ...(n.ref ? { ref: n.ref } : {}),
      });
      continue;
    }
    if (CONTROL_ROLES.has(n.role)) {
      if (controls.length >= o.maxInteractive) {
        truncated = true;
        continue;
      }
      const r = regionOf(n);
      controls.push({
        idx: idx++,
        tag: n.role === "button" || n.role === "tab" ? n.role : "input",
        role: n.role,
        type: INPUT_ROLES.has(n.role) ? fieldType(n) : null,
        label: nameOf(n),
        inForm: ancestors(n).some((a) => a.role === "form" || a.role === "search"),
        ariaExpanded:
          n.attrs.expanded === undefined
            ? null
            : n.attrs.expanded === true
              ? "true"
              : String(n.attrs.expanded),
        ariaControls: false,
        ariaHasPopup: n.attrs.haspopup ? String(n.attrs.haspopup) : null,
        inPagination: r.region === "pagination",
        inCookieBanner: inBanner(n),
        visible: true,
        testId: null,
        ...(n.ref ? { ref: n.ref } : {}),
      });
    }
  }

  // Forms: explicit form/search landmarks, else a container holding inputs plus a button.
  const formRoots: SnapNode[] = nodes.filter((n) => n.role === "form" || n.role === "search");
  for (const n of nodes) {
    if (
      ["generic", "group"].includes(n.role) &&
      !formRoots.some((f) => f === n || ancestors(n).includes(f))
    ) {
      const direct = [...walk(n)];
      const hasInput = direct.some((c) => INPUT_ROLES.has(c.role));
      const hasButton = direct.some((c) => c.role === "button");
      const childHasBoth = n.children.some((c) => {
        const d = [...walk(c)];
        return d.some((x) => INPUT_ROLES.has(x.role)) && d.some((x) => x.role === "button");
      });
      if (hasInput && hasButton && !childHasBoth && !inBanner(n)) formRoots.push(n);
    }
  }
  const forms: ExtractedForm[] = formRoots.map((f, i) => {
    const inputs = [...walk(f)].filter((c) => INPUT_ROLES.has(c.role));
    const fields: ExtractedFormField[] = inputs.map((c) => ({
      name: "",
      type: fieldType(c),
      label: nameOf(c),
      required: false,
      options: [],
    }));
    const submit = [...walk(f)].find((c) => c.role === "button");
    const search = f.role === "search" || ancestors(f).some((a) => a.role === "search");
    return {
      index: i,
      name: clip(f.name, 80),
      role: f.role === "form" || f.role === "search" ? f.role : null,
      // Snapshots hide method/action. Only search landmarks are treated as read-only GET queries; any
      // other form is inventoried as potentially persisting and is never submitted.
      method: search ? "get" : "unknown",
      action: search ? o.url : "",
      fields,
      submitLabel: submit ? nameOf(submit) : "",
      hasPassword: fields.some((x) => x.type === "password"),
      hasFile: false,
      inSearchLandmark: search,
      ...(inputs[0]?.ref ? { inputRef: inputs[0].ref } : {}),
    };
  });

  const tables = nodes
    .filter((n) => n.role === "table" || n.role === "grid")
    .map((t) => {
      const rows = [...walk(t)].filter((r) => r.role === "row");
      const headers = [...walk(t)].filter((c) => c.role === "columnheader").map((c) => nameOf(c));
      const body = rows.filter((r) => r.children.some((c) => c.role === "cell" || c.role === "gridcell"));
      return {
        caption: clip([...walk(t)].find((c) => c.role === "caption")?.inline ?? t.name),
        headers: headers.slice(0, 20),
        rowCount: body.length,
        sampleRows: body.slice(0, 3).map((r) => r.children.map((c) => nameOf(c)).slice(0, 12)),
        role: (t.role === "grid" ? "grid" : "table") as "table" | "grid",
      };
    });

  const headings = nodes
    .filter((n) => n.role === "heading" && nameOf(n))
    .map((n) => ({ level: Number(n.attrs.level ?? 2), text: nameOf(n) }))
    .slice(0, 60);
  const main = nodes.find((n) => n.role === "main");
  const errorRe = /\b(error|not found|404|something went wrong|forbidden|unavailable)\b/i;
  const emptyRe = /\b(no results?|nothing found|no items?|no data|empty)\b/i;
  const allText = nodes
    .filter((n) => n.role === "text" || n.role === "alert" || n.role === "heading" || n.role === "status")
    .map((n) => nameOf(n))
    .filter(Boolean);

  return {
    url: o.url,
    title: clip(o.title, 300),
    lang: "",
    metaDescription: "",
    headings,
    landmarks: nodes
      .filter((n) =>
        ["banner", "navigation", "main", "contentinfo", "complementary", "search", "region"].includes(n.role),
      )
      .map((n) => (n.name ? `${n.role}:${clip(n.name, 60)}` : n.role))
      .slice(0, 30),
    links,
    controls,
    forms,
    tables,
    cards: [],
    media: nodes
      .filter((n) => n.role === "img")
      .slice(0, 50)
      .map((n) => ({ src: clip(n.name, 120), broken: false })),
    errorTexts: [
      ...new Set(
        nodes
          .filter((n) => n.role === "alert")
          .map((n) => nameOf(n))
          .concat(allText.filter((t) => errorRe.test(t) && t.length < 120)),
      ),
    ].slice(0, 10),
    emptyStateTexts: allText.filter((t) => emptyRe.test(t) && t.length < 120).slice(0, 5),
    mainText: clip(main ? textOf(main) : "", 2000),
    dialogs: nodes.filter((n) => n.role === "dialog" || n.role === "alertdialog").length,
    iframes: nodes.filter((n) => n.role === "iframe").length,
    cookieBanner: {
      present: banner.length > 0,
      labels: banner
        .flatMap((b) => [...walk(b)].filter((c) => c.role === "button").map((c) => nameOf(c)))
        .slice(0, 10),
    },
    loginSignals: {
      passwordField: forms.some((f) => f.hasPassword),
      loginHeading: headings.some((h) => /\b(log ?in|sign ?in)\b/i.test(h.text)),
    },
    numbers: [],
    truncated,
  };
}
