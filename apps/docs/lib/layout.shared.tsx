// SPDX-License-Identifier: Apache-2.0
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { origins } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2">
          {/* biome-ignore lint/performance/noImgElement: static export, an SVG needs no optimisation */}
          <img
            src="/brand/usagemap-lockup.svg"
            alt="UsageMap"
            height={22}
            width={130}
            className="h-[22px] w-auto"
          />
          <span className="rounded-full border border-fd-border bg-fd-card px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fd-muted-foreground">
            Docs
          </span>
        </span>
      ),
      url: "/",
    },
    themeSwitch: { enabled: false },
    links: [
      { text: "Open the app", url: origins.app, external: true },
      { text: "usagemap.dev", url: origins.site, external: true },
      { text: "Status", url: origins.status, external: true },
    ],
  };
}
