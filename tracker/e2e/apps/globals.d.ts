// SPDX-License-Identifier: Apache-2.0
// Globals the fixture apps expose to the Playwright specs.
import type { Tracker } from "../../src/core.ts";

declare global {
  interface Window {
    fixture: {
      /** Every value init() returned on this page, in call order. */
      trackers: (Tracker | undefined)[];
      /** React SPA: the root layout effect has run. */
      ready?: boolean;
      /** SSR: hydration finished and the root layout effect has run. */
      hydrated?: boolean;
    };
  }
}
