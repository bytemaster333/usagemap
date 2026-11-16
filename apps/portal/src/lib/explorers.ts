// SPDX-License-Identifier: Apache-2.0
// Deep links to public Stellar explorers for PUBLIC chain objects only — a seal transaction, the sealing account, a
// project's verified contract — never for anything a visitor did (end-user accounts and transactions are never shown,
// privacy invariants of CONTRIBUTING.md). Opening a link is the reader's choice; the explorer then sees the reader's address.
//
// URL formats, verified from each project's source at a pinned commit (2026-11-19):
//   StellarExpert  https://stellar.expert/explorer/{public|testnet}/{tx|account|contract}/{id}
//                  (stellar-expert/stellar-expert-explorer@6d9ba0c2, views/explorer/explorer-router.js; tx = 64-hex hash)
//   Stellar Lab    https://lab.stellar.org/r/{mainnet|testnet}/contract/{C…}  — contracts only; opens the contract
//                  explorer with the network selected (stellar/laboratory@6087cd0b, src/app/(sidebar)/r/[network]/
//                  contract/[contractId]/page.tsx). Lab's mainnet entry has no default RPC: the reader may have to set one.
//   steexp         https://steexp.com/{tx|account|contract}/{id}, testnet on https://testnet.steexp.com
//                  (chatch/stellarexplorer@7864fdc6, app/routes, app/lib/stellar/networks.ts)

export type ChainObjectKind = "tx" | "account" | "contract";
export type ExplorerNetwork = "mainnet" | "testnet";

export interface ExplorerLink {
  explorer: "stellar.expert" | "lab" | "steexp";
  label: string;
  href: string;
}

const PATTERN: Record<ChainObjectKind, RegExp> = {
  tx: /^[0-9a-f]{64}$/,
  account: /^G[A-Z2-7]{55}$/,
  contract: /^C[A-Z2-7]{55}$/,
};

/** Normalises a network name as used across the portal ("public" and "pubnet" mean mainnet); null otherwise. */
export function explorerNetwork(n: string | null | undefined): ExplorerNetwork | null {
  if (n === "mainnet" || n === "public" || n === "pubnet") return "mainnet";
  if (n === "testnet") return "testnet";
  return null; // futurenet, a local network, unknown: no public explorer link
}

/**
 * The explorer links for one public chain object, or [] when the id or the network is not one an explorer serves
 * (a malformed id never becomes a URL). Transaction hashes are lower-cased.
 */
export function explorerLinks(
  kind: ChainObjectKind,
  id: string,
  network: string | null | undefined,
): ExplorerLink[] {
  const net = explorerNetwork(network);
  const v = kind === "tx" ? id.toLowerCase() : id;
  if (!net || !PATTERN[kind].test(v)) return [];
  const links: ExplorerLink[] = [
    {
      explorer: "stellar.expert",
      label: "StellarExpert",
      href: `https://stellar.expert/explorer/${net === "mainnet" ? "public" : "testnet"}/${kind}/${v}`,
    },
  ];
  if (kind === "contract")
    links.push({
      explorer: "lab",
      label: "Stellar Lab",
      href: `https://lab.stellar.org/r/${net}/contract/${v}`,
    });
  links.push({
    explorer: "steexp",
    label: "steexp",
    href: `https://${net === "mainnet" ? "" : "testnet."}steexp.com/${kind}/${v}`,
  });
  return links;
}
