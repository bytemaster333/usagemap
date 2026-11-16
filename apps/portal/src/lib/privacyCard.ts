// SPDX-License-Identifier: Apache-2.0
// The "what we never show / never store" card (plan D-4). The never-store list is docs/privacy/data-inventory.md §8
// word for word — only the register references (C-…, ADR-…, §…), Markdown marks and the editorial note naming this
// card are left out; test/unit/privacy-card.test.ts compares the two, so the card cannot drift from the inventory. The
// never-show list is the portal's own rule set (dashboard research §3.2): what the pages here deliberately do not
// offer, whatever data exists.

/** docs/privacy/data-inventory.md §8, in order. The Stellar entry is the card's lead statement. */
export const NEVER_STORED: readonly string[] = [
  "IP addresses (full or truncated) in any stored form; IP-derived region, city or coordinates.",
  "Raw User-Agent strings; high-entropy client hints; TLS fingerprints or any other fingerprint hash in any stored form (the gateway computes a JA4 fingerprint and HTTP/2 preface features per connection in memory only, for the transport_mismatch signal — never logged, stored or forwarded).",
  "Cookies, localStorage, sessionStorage, IndexedDB entries (except the visitor's own opt-out flag).",
  "Query strings, URL fragments, UTM/campaign parameters, advertising click IDs (gclid, fbclid, msclkid, ttclid, li_fat_id, twclid) — the gateway discards any it still receives.",
  "Page titles (not collected at all; there is no setting to collect them); form contents; session replay; heatmaps; scroll or mouse traces; browser error reports; web vitals.",
  "Umami distinct_id, identify() traits, session_data, session_link.",
  "Any identifier that spans sites, tenants or days.",
  "Stellar account keys (G/M), contract addresses of users, transaction hashes, XDR, signatures, memos, secret seeds (S…), balances, amounts — in web events and wallet events; in web page paths, custom events and API routes they are replaced by placeholders or {redacted} before storage. No visitor's address is ever collected. The only Stellar accounts stored are the ones a project declares as its own in its Registered Footprint (and the sign-in accounts of tenant members): the platform keeps only accounts a project proved are its own, and for at most 30 days the account of an open claim under verification; a rejected or removed account is deleted at the next hourly retention run. The only transaction hashes stored are those of the platform's own daily-seal transactions (seal_days.tx_hash, sent from the platform's sealing account) — never a transaction of a visitor or a tenant.",
  "Wallet-extension message traffic (Tier 2 not shipped); the Wallets Kit's localStorage keys; lists of installed wallets.",
  "From OpenTelemetry: client addresses, network peer addresses, user agents, full URLs and queries, request/response headers, request/response bodies, enduser.*, user.*, session.id, exception messages and stack traces, span events and links, exemplars, logs, host/process/container resource attributes. Payment amounts are never collected from OpenTelemetry either: the agent-payment events keep only a six-way order-of-magnitude bucket of a tenant server's own payment.",
  'Any cross-tenant visitor de-duplication or "reach" figure.',
];

/** The index of the Stellar entry, shown first and in full. */
export const STELLAR_ENTRY = 7;

/** What no page of this portal shows, to anyone (tenant, operator or public). */
export const NEVER_SHOWN: readonly string[] = [
  "No visitor or session lists, no visitor profiles and no per-visitor journeys.",
  "No session replays, heatmaps or click and scroll traces.",
  "No “who is online now” view and no time-of-day heatmap.",
  "No city or region: countries only.",
  "No full referrer URLs or query strings: referrer hosts and normalised paths only.",
  "No wallet addresses or transaction hashes of end users; wallet activity as daily counts by wallet type only.",
  "No visitor identity across sites or days.",
  "Trust and anomaly flags only as aggregates with their reasons, never as a list of visitors.",
];
