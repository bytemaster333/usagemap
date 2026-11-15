// SPDX-License-Identifier: Apache-2.0
// ESM entry for bundling into an application (`@usagemap/tracker`, `@usagemap/tracker/strict`).
// Same behaviour as the classic script; the profile is chosen by the import path, not at run time.
import { type Config, createTracker, type Tracker } from "./core.js";

export type { Config, Props, PropValue, Tracker } from "./core.js";

/**
 * Start the tracker. Safe to call during server-side rendering (returns undefined) and safe to call more than
 * once (e.g. React StrictMode effects): the second call returns the running instance, so nothing is counted twice.
 */
export function init(config: Config): Tracker | undefined {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  return createTracker(config);
}
