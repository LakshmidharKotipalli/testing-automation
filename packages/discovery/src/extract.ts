/** Structured page facts. Built from the MCP accessibility snapshot (see snapshot-extract.ts). */
export interface ExtractedLink {
  idx: number;
  text: string;
  href: string;
  download: boolean;
  region: "nav" | "header" | "footer" | "aside" | "breadcrumb" | "pagination" | "main";
  regionLabel: string;
  /** Snapshot ref; valid only for the snapshot it came from. */
  ref?: string;
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
  ref?: string;
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
  /** Ref of the first input, for typing into search landmarks. */
  inputRef?: string;
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
