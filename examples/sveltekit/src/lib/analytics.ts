// SPDX-License-Identifier: Apache-2.0
// src/lib/analytics.ts
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict"
import { PUBLIC_SCF_SITE } from "$app/env/public";

/** Starts the tracker in the browser, or returns the running one; undefined during server rendering. */
export const analytics = () => init({ site: PUBLIC_SCF_SITE });
