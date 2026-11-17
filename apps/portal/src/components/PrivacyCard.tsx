// SPDX-License-Identifier: Apache-2.0
// "What we never show / never store" (plan D-4): on the project overview, the web dashboard and the public card.
// The Stellar statement leads; the rest of the inventory is one click away so the card stays short.

import { useId } from "react";
import { NEVER_SHOWN, NEVER_STORED, STELLAR_ENTRY } from "../lib/privacyCard.ts";

export function PrivacyCard({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const stellar = NEVER_STORED[STELLAR_ENTRY] as string;
  const others = NEVER_STORED.filter((_, i) => i !== STELLAR_ENTRY);
  return (
    <section className="um-card" aria-labelledby={`${id}-h`} data-testid="privacy-card">
      <h2 id={`${id}-h`} className="um-h2">
        What we never show and never store
      </h2>
      <p className="um-privacy-lead" data-testid="privacy-stellar">
        {stellar}
      </p>
      <div className={compact ? "um-privacy um-privacy--compact" : "um-privacy"}>
        <div>
          <h3 className="um-h3">Never shown, to anyone</h3>
          <ul className="um-privacy-list" data-testid="privacy-never-shown">
            {NEVER_SHOWN.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <details className="um-privacy-more">
          <summary>Never stored: the full list</summary>
          <ul className="um-privacy-list" data-testid="privacy-never-stored">
            {others.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}

/** Demo tenants (tools/demo-seed) use `demo-` slugs; every page that shows one says so. */
export const isDemoSlug = (slug: string | undefined | null): boolean =>
  typeof slug === "string" && slug.startsWith("demo-");

export function DemoBanner({ slug }: { slug: string | undefined | null }) {
  if (!isDemoSlug(slug)) return null;
  return (
    <p className="alert warn" role="note" data-testid="demo-banner">
      <strong>DEMO</strong> — synthetic data generated for a demonstration. These are not the
      figures of a real project.
    </p>
  );
}
