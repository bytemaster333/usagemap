// SPDX-License-Identifier: Apache-2.0
import type { Metadata } from "next";
import { Geist, Geist_Mono, Manrope } from "next/font/google";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { origins } from "@/lib/shared";
import "./global.css";

// Downloaded at build time and served from this site: no request to a font service at runtime.
const manrope = Manrope({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-manrope" });
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(origins.docs),
  title: { template: "%s · UsageMap Docs", default: "UsageMap Docs" },
  description:
    "Privacy-first web and API analytics for Stellar ecosystem projects: quickstart, integrations and guides.",
  icons: { icon: "/favicon.svg", apple: "/brand/usagemap-app-icon.svg" },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${geist.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
