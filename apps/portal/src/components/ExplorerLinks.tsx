// SPDX-License-Identifier: Apache-2.0
// Inline "open in StellarExpert · Stellar Lab · steexp" links for one public chain object (lib/explorers.ts). Renders
// nothing for an id or network no explorer serves. Links open in a new tab without a referrer: the explorer learns
// the reader's address, not the page they came from.

import { type ChainObjectKind, explorerLinks } from "../lib/explorers.ts";

export function ExplorerLinks({
  kind,
  id,
  network,
  testId,
}: {
  kind: ChainObjectKind;
  id: string | null | undefined;
  network: string | null | undefined;
  testId?: string;
}) {
  const links = id ? explorerLinks(kind, id, network) : [];
  if (links.length === 0) return null;
  return (
    <span className="small" data-testid={testId ?? `explorers-${kind}`}>
      {links.map((l, i) => (
        <span key={l.explorer}>
          {i > 0 ? " · " : ""}
          <a href={l.href} target="_blank" rel="noopener noreferrer" data-explorer={l.explorer}>
            {l.label}
          </a>
        </span>
      ))}
    </span>
  );
}
