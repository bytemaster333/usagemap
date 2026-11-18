// SPDX-License-Identifier: Apache-2.0
// app/analytics.tsx — render <Analytics /> once in the root layout
"use client";
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict" for a strict site
import { useEffect } from "react";

// your site key (portal: site → Snippet), set in the build environment, e.g. Vercel → Environment Variables
export const SITE = process.env.NEXT_PUBLIC_SCF_SITE ?? "";

export function Analytics() {
  useEffect(() => {
    const start = () => init({ site: SITE });
    if (process.env.NODE_ENV === "production") return void start();
    // development: the debug module explains why something was (not) sent; start it before the tracker
    void import("@usagemap/tracker/debug").then(({ debug }) => debug()).finally(start);
  }, []);
  return null;
}
