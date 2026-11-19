// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";

/** A compact icon grid for "what you get" lists. */
export function Features({ children }: { children: ReactNode }) {
  return <div className="not-prose my-6 grid gap-3 sm:grid-cols-2">{children}</div>;
}

export function Feature({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-lg border bg-fd-card p-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-fd-border bg-fd-muted text-fd-foreground [&_svg]:size-4 [&_svg]:stroke-[1.6]">
        {icon}
      </div>
      <div className="text-sm">
        <p className="font-medium text-fd-foreground">{title}</p>
        <div className="mt-1 text-fd-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
