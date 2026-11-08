// The browser floor: Chrome 125, Firefox 147, Safari 26.
// Zipscope checks the features, not the browser name. Below the floor, or
// when the page is not cross-origin isolated, the entry module shows the
// "This browser can't run Zipscope" state and does not load the app.
//
// This module must not import Solid or the app: the entry module runs it
// first, also in a browser that cannot run the app.

export type Support = "ok" | "isolation" | "browser";

/**
 * Returns why this browser cannot run Zipscope, or "ok". The checks are
 * features that came at the floor or that the app cannot run without:
 *
 * - `crossOriginIsolated`: without it, there is no `SharedArrayBuffer`.
 * - A growable `SharedArrayBuffer` (the mirrors grow).
 * - CSS anchor positioning: the last of the floor features in each of the
 *   three browsers (Chrome 125, Firefox 147, Safari 26).
 * - `CompressionStream` (the sample archive and the downloads).
 */
export function checkSupport(scope: typeof globalThis = globalThis): Support {
  if (scope.crossOriginIsolated !== true) {
    return "isolation";
  }
  return missingFeatures(scope).length === 0 ? "ok" : "browser";
}

/** Returns the names of the floor features that the browser does not have,
 *  for the unsupported page. */
export function missingFeatures(scope: typeof globalThis = globalThis): string[] {
  const shared = scope.SharedArrayBuffer as typeof SharedArrayBuffer | undefined;
  const missing: string[] = [];
  if (shared === undefined || !("grow" in shared.prototype)) {
    missing.push("growable SharedArrayBuffer");
  }
  if (scope.CSS?.supports?.("anchor-name: --zipscope") !== true) {
    missing.push("CSS anchor positioning");
  }
  if (typeof scope.CompressionStream !== "function") missing.push("CompressionStream");
  return missing;
}
