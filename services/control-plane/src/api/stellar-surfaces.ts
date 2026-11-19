// SPDX-License-Identifier: Apache-2.0
// Stellar surface of an API route (2026-11-19 product improvements; plan item D-8): which public Stellar interface a
// normalised route belongs to, so the tenant API dashboard can group routes the way Stellar developers think about
// them. The mapping is versioned (`SURFACE_MAPPING_VERSION`, echoed by every response that uses it); any change to an
// output below is a new version. It reads only the stored route (pathnorm output or the tenant's own route template)
// and the JSON-RPC method the route carries — never a raw path.
//
// Rules, first match wins (segments compared case-insensitively, placeholders such as `{account}` skipped):
//  1. `{unknown}` / `{overflow}` → surface `placeholder` (group = the placeholder).
//  2. A JSON-RPC method on the row → `soroban_rpc`, group = the method (e.g. `getLedgerEntries`); a route whose last
//     literal segment is `rpc` / `soroban-rpc` / `soroban_rpc` without a method → `soroban_rpc`, group `(method not
//     reported)` (switch on the service's RPC method dimension to see methods).
//  3. `/.well-known/stellar.toml` → `sep1`.
//  4. An explicit SEP segment anywhere (`sep6`, `sep-6`, `sep10`, `sep12`, `sep24`, `sep31`, `sep38`, …) → that SEP;
//     the group is the rest of the route after the segment (or `/`).
//  5. Distinctive anchor paths (SEP clients use these without a prefix too):
//     `…/transactions/deposit/interactive`, `…/transactions/withdraw/interactive` → `sep24`;
//     `/auth` → `sep10`; `/customer`, `/customers` (and below) → `sep12`;
//     `/deposit`, `/withdraw`, `/deposit-exchange`, `/withdraw-exchange`, `/fee` → `sep6`;
//     `/quote`, `/quotes`, `/price`, `/prices` → `sep38`;
//     `/info`, `/transaction` (singular) → `sep_shared` ("SEP-6/24/31 shared endpoint": the same path in all three).
//  6. Horizon resources (first literal segment): accounts, assets, claimable_balances, effects, fee_stats, ledgers,
//     liquidity_pools, offers, operations, order_book, paths, payments, trade_aggregations, trades, transactions,
//     transactions_async, and the root `/` → `horizon`, group = the resource. (`/transactions` without a SEP marker is
//     Horizon's; an anchor's SEP-24/6/31 `transactions` list is recognised only under a SEP prefix — rule 4.)
//  7. Anything else → `other`, group = the first literal segment.

export const SURFACE_MAPPING_VERSION = "stellar-surfaces/1.0.0";

export type Surface =
  | "horizon"
  | "soroban_rpc"
  | "sep1"
  | "sep6"
  | "sep10"
  | "sep12"
  | "sep24"
  | "sep31"
  | "sep38"
  | "sep_shared"
  | "sep_other"
  | "placeholder"
  | "other";

export const SURFACE_LABEL: Record<Surface, string> = {
  horizon: "Horizon API",
  soroban_rpc: "Stellar RPC (Soroban) JSON-RPC",
  sep1: "SEP-1 stellar.toml",
  sep6: "SEP-6 deposit and withdrawal (programmatic)",
  sep10: "SEP-10 web authentication",
  sep12: "SEP-12 KYC",
  sep24: "SEP-24 interactive deposit and withdrawal",
  sep31: "SEP-31 cross-border payments",
  sep38: "SEP-38 quotes",
  sep_shared: "SEP-6/24/31 shared endpoint",
  sep_other: "Other SEP",
  placeholder: "Requests without a route of their own",
  other: "Other routes",
};

const HORIZON = new Set([
  "accounts",
  "assets",
  "claimable_balances",
  "effects",
  "fee_stats",
  "ledgers",
  "liquidity_pools",
  "offers",
  "operations",
  "order_book",
  "paths",
  "payments",
  "trade_aggregations",
  "trades",
  "transactions",
  "transactions_async",
]);

const KNOWN_SEPS: Record<string, Surface> = {
  "1": "sep1",
  "6": "sep6",
  "10": "sep10",
  "12": "sep12",
  "24": "sep24",
  "31": "sep31",
  "38": "sep38",
};

const isPlaceholder = (s: string) => s.startsWith("{") && s.endsWith("}");

export interface SurfaceOf {
  surface: Surface;
  group: string;
}

export function surfaceOf(route: string, rpcMethod: string | null | undefined): SurfaceOf {
  if (route === "{unknown}" || route === "{overflow}")
    return { surface: "placeholder", group: route };
  const segs = route.split("/").filter((s) => s !== "");
  const lit = segs.filter((s) => !isPlaceholder(s)).map((s) => s.toLowerCase());
  if (rpcMethod) return { surface: "soroban_rpc", group: rpcMethod };
  const last = lit.at(-1);
  if (last === "rpc" || last === "soroban-rpc" || last === "soroban_rpc")
    return { surface: "soroban_rpc", group: "(method not reported)" };
  if (lit.length === 2 && lit[0] === ".well-known" && lit[1] === "stellar.toml")
    return { surface: "sep1", group: "/.well-known/stellar.toml" };
  for (let i = 0; i < segs.length; i++) {
    const m = /^sep-?(\d{1,3})$/i.exec(segs[i] as string);
    if (m) {
      const rest = `/${segs.slice(i + 1).join("/")}`;
      return { surface: KNOWN_SEPS[m[1] as string] ?? "sep_other", group: rest };
    }
  }
  const path = `/${lit.join("/")}`;
  if (/\/transactions\/(deposit|withdraw)\/interactive$/.test(path))
    return { surface: "sep24", group: route };
  const first = lit[0];
  if (first === undefined) return { surface: "horizon", group: "/" };
  if (first === "auth") return { surface: "sep10", group: route };
  if (first === "customer" || first === "customers") return { surface: "sep12", group: route };
  if (["deposit", "withdraw", "deposit-exchange", "withdraw-exchange", "fee"].includes(first))
    return { surface: "sep6", group: route };
  if (["quote", "quotes", "price", "prices"].includes(first))
    return { surface: "sep38", group: route };
  if (first === "info" || first === "transaction") return { surface: "sep_shared", group: route };
  if (HORIZON.has(first)) return { surface: "horizon", group: first };
  return { surface: "other", group: first };
}
