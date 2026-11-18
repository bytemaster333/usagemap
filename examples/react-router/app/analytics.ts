// SPDX-License-Identifier: Apache-2.0
// app/analytics.ts
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict"

// your site key (portal: site → Snippet), set at build time: VITE_SCF_SITE=… pnpm build
const SITE = import.meta.env.VITE_SCF_SITE ?? "";

/** Starts the tracker in the browser, or returns the running one; undefined during server rendering. */
export const analytics = () => init({ site: SITE });
