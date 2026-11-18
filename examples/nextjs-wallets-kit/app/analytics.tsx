// SPDX-License-Identifier: Apache-2.0
// app/analytics.tsx — with the Wallets Kit adapter
"use client";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { init } from "@usagemap/tracker";
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
import { useEffect } from "react";

// your site key (portal: site → Snippet), set in the build environment
const SITE = process.env.NEXT_PUBLIC_SCF_SITE ?? "";

export function Analytics() {
  useEffect(() => {
    init({ site: SITE });
    return attachWalletsKit(StellarWalletsKit); // returns detach; nothing is counted twice
  }, []);
  return null;
}
