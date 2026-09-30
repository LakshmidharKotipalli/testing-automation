/** A request or browser event the read-only discovery guard refused. */
export interface DiscoveryBlockedRequest {
  url: string;
  method: string;
  reason: string;
  kind: "external" | "non-read-method" | "popup" | "dialog" | "download" | "file-chooser";
  isNavigation: boolean;
  at: string;
}
