// SPDX-License-Identifier: Apache-2.0
"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import SearchDialog from "@/components/search";

// Light only (design system): the theme is fixed and there is no theme switch.
export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{ SearchDialog }}
      theme={{ forcedTheme: "light", defaultTheme: "light", enableSystem: false }}
    >
      {children}
    </RootProvider>
  );
}
