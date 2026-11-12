# ADR-0012: Path normalisation rules and versioning

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** api.attr-route, pathnorm.default-ruleset, pathnorm.numeric-ids, pathnorm.stellar-strkeys, pathnorm.uuids, pathnorm.hex-hashes, pathnorm.trailing-slashes, pathnorm.other-patterns, pathnorm.tenant-http-route

## Context
UsageMap reports endpoint usage by normalised path / `http.route`, with variables removed. Path normalisation is
performed by a hard-coded default rule set that covers common patterns (numeric IDs, Stellar G-/C-/M-addresses,
UUIDs, hex/crypto hashes, trailing slashes, etc.). There is no authenticated UI or API for tenants to add custom
rules; tenants set the `http.route` attribute in their own middleware when they need finer control.

What research established:
- **StrKey has ten types, not three.** SEP-23 **v1.4.0** (Active, updated 2026-09-18; stellar-protocol @ `ced008c`)
  added `W` (muxed contract, CAP-84, Protocol 30 — not yet on mainnet, which runs Protocol 29 since 2026-10-01).
  Construction: `version_byte ‖ payload ‖ CRC16-XMODEM (little-endian)`, RFC 4648 base32 without padding,
  upper case only; strict validity rejects lengths ≡ 1, 3, 6 (mod 8) and non-zero unused bits. Because the algorithm
  bits are 0, the second character is always `A`–`D`. `js-stellar-base` 15.0.0 does not know `W` yet; the Go SDK and
  `rs-stellar-strkey` 1.0.0 do — so `pathnorm` carries its own ~20-line decoder.
- **Seeds appear in URLs.** A scan of stellar-docs @ `48259204` found 17 seed-shaped strings and 312 StrKey-shaped
  strings (9 of them fail strict decoding — hand-made placeholders).
- **Metrics carry no path** (semconv v1.45.0): the normaliser sees a raw path only on server spans; on metrics it
  sees `http.route`, which some stacks fill with the raw path (Rust tower `PathExtractor`, FastAPI host-routing
  fallback) or with literals such as actix's `"default"`.
- **Stellar RPC** is JSON-RPC on one path (`stellar-rpc` `daemon.go:436` `Handle("/")`): the route says nothing.
- **Prior art.** Datadog (obfuscator, `dd-trace-cpp` endpoint inference, overflow sentinel), Sentry Relay
  (≥ 2 consecutive digits → `*`) and its clusterer (merge at 200 distinct children), OBI/Beyla (heuristic with a
  gibberish model). None is Stellar-aware.
- **Executed evidence.** A Python reference model reproduced **451/451** corpus vectors, had 0 idempotence failures,
  and a 50,000-path fuzz with injected fresh seeds produced 0 seed or `@` leaks; all 35 regexes gave identical
  results in CPython and Node 24 and use no look-around (RE2 subset by construction; RE2 itself was not run).
- **Placement.** Normalisation must happen in memory before the Collector's persistent queue. The
  same exposure exists on the web side: a wallet address or seed in a page URL would otherwise reach the gateway
  spool and Umami.

## Options considered
1. **Collector OTTL `replace_pattern` chains.** Pros: no custom code. Cons: RE2 without look-around; rules in YAML that
   are hard to unit-test; no version stamp per data point; no checksum logic; would be duplicated elsewhere anyway.
2. **Normalise in the writer.** Pros: one place with state. Cons: raw paths (and seeds) would sit in the on-disk
   Collector queue — violates "nothing raw on disk".
3. **Versioned Go library `pathnorm` called by `scfsanitize` before the queue and by the web gateway before the
   spool, cardinality guard in the writer (chosen).** Pros: deterministic, unit-tested against a corpus, version
   stamped, nothing raw persisted on either path; one rule set for API routes and web page paths. Cons: our code
   inside the Collector build and the gateway; the guard is stateful and must live elsewhere.
4. **Generic single placeholder (`*` or `{id}`) like Sentry/Datadog.** Pros: simplest. Cons: loses what the endpoint
   is keyed by; Stellar projects need "Stellar-aware".
5. **Learned or clustering normaliser (OBI-style).** Cons: not deterministic across model versions, not explainable.
6. **Tenant-defined rules.** Not a product goal; adds an authenticated rule API and a regex-DoS surface.

## Decision
A deterministic, ordered, idempotent rule set compiled into `pathnorm` (Go), versioned `scf-path-rules/x.y.z`, with
the version stored on every route. No tenant-defined rules. Rule changes create a new version; history is never
rewritten. The same library and version run in two places: in `scfsanitize` for API telemetry (ADR-0009) and in the
web gateway for page paths (see "Web page paths" below, C-52).

**Input precedence (API).** (1) Tenant `http.route` — framework placeholders (`:id`, `{id}`, `{id:\w+}`, `<int:id>`,
`[id]`, `[...slug]`, `*`, `**`, `*splat`, `(.*)`) are canonicalised: named parameters keep their name, lower-cased
and at most 32 characters (`/users/:userId` → `/users/{userid}`, `[...path]` → `{path}`), and the catch-alls `*`,
`*splat` and `(.*)` become `{wildcard}`; the literal segments still go through every secret, PII and identifier
rule, the caps and the guard; (2) span
`url.path`; (3) legacy `http.target` (query stripped). Missing → `{unknown}`, assigned by the Collector's sanitise
step when neither a route nor a path exists (C-16, C-89). The output is the same whichever
source fed it, so old and new SDKs aggregate together.

**Always.** Strip query and fragment (scanned for secrets first, counter only); collapse slashes; remove the trailing
slash (root stays `/`); cap depth and length (research values: depth 12, segment 256, output 1024 bytes).

**Closed placeholder vocabulary — 24 placeholders (C-16).** The closed set is the vocabulary the 451-vector corpus
actually produces — the 21 per-segment placeholders below plus route-mode `{wildcard}` — plus the two route-level
placeholders `{unknown}` (assigned by the Collector's sanitise step) and `{overflow}` (assigned by the writer's
cardinality guard) (C-16, C-89). It replaces the shorter list in the original register entry. The corpus is the
conformance suite for the rule set; `{unknown}` and `{overflow}` are outside the corpus and have their own tests.

| # | Placeholder | Replaces (rule in the research rule set) |
|---|---|---|
| 1 | `{account}` | StrKey `G` (account) and `M` (muxed account) (S4) |
| 2 | `{contract}` | StrKey `C` (contract) and `W` (muxed contract) (S4) |
| 3 | `{pool}` | StrKey `L` (liquidity pool) (S4) |
| 4 | `{balance}` | StrKey `B` (claimable balance); Horizon's 72-hex claimable-balance id (`00000000` + 64 hex) (S4, S7) |
| 5 | `{signer}` | StrKey `T` (pre-auth transaction), `X` (sha256 hash signer), `P` (signed payload) (S4) |
| 6 | `{asset}` | `CODE:ISSUER`, `CODE-ISSUER[-1\|2]`, `stellar:CODE:ISSUER` (issuer must strict-decode as `G`) (S5) |
| 7 | `{hash}` | exactly 64 hex (transaction, ledger, Wasm hash; hex pool id), optional `0x` (S7) |
| 8 | `{hex}` | other long hex (≥ 16, e.g. EVM addresses, dash-less UUIDs, ObjectIds) and mid-length hex with a digit and a letter (7–15) (S7) |
| 9 | `{int}` | decimal integer, any number of digits (1.1.0; single digits included) (ledger sequence, TOID, offer id) (S6) |
| 10 | `{event}` | Stellar RPC event id `%019d-%010d` (S6) |
| 11 | `{cursor}` | Horizon-style paging token `<int>-<int>` (S6) |
| 12 | `{date}` | ISO 8601 date or date-time (S6) |
| 13 | `{uuid}` | UUID, any version, any case, braced or `urn:uuid:` (S7) |
| 14 | `{id}` | StrKey-shaped segment with a bad checksum; ULIDs; mixed identifiers; decimals; segments with special characters; other opaque ids (S4, S6, S10, S12, S13) |
| 15 | `{token}` | long opaque base64/base64url/base58 strings (S11) |
| 16 | `{key}` | Horizon data-entry key after `accounts/{account}/data/` (K1) |
| 17 | `{static}` | content-hashed name of a static file, extension kept (`{static}.js`) (S9) |
| 18 | `{redacted}` | secrets — secret seeds, JWTs, API-key-shaped strings (S1) — and personal identifiers — e-mail addresses, federation addresses (`name*domain`), phone numbers, IP literals (S2) |
| 19 | `{invalid}` | invalid UTF-8 or control characters after percent-decoding (A8) |
| 20 | `{long}` | literal segment longer than 64 characters, decoded segment over 256, or input over 8 KiB (`/{long}`) (S14, S3, A1) |
| 21 | `{rest}` | everything beyond the depth cap of 12 segments (A10) |
| 22 | `{wildcard}` | route mode only: the catch-alls `*`, `*splat`, `(.*)` in a tenant `http.route` (route-mode vectors 433–451) |
| 23 | `{overflow}` | routes beyond the cardinality guard (`{overflow}` or `<prefix>/{overflow}`); assigned by the writer only |
| 24 | `{unknown}` | no path information at all; assigned by the Collector's sanitise step only |

Route mode also keeps the tenant's own lower-cased parameter names; these are canonicalised tenant placeholders, not
values, and the corpus pins them (route-mode vectors 433–451).

**The ten StrKey types** (recognised by shape, then strict-decoded):

| Prefix | Type | Payload bytes | Encoded length | Result |
|---|---|---|---|---|
| `G` | ed25519 public key (account) | 32 | 56 | `{account}` |
| `M` | muxed account (CAP-27) | 40 | 69 | `{account}` |
| `C` | contract | 32 | 56 | `{contract}` |
| `W` | muxed contract (CAP-84) | 40 | 69 | `{contract}` |
| `L` | liquidity pool | 32 | 56 | `{pool}` |
| `B` | claimable balance (starts `BAA`) | 33 | 58 | `{balance}` |
| `T` | pre-auth transaction | 32 | 56 | `{signer}` |
| `X` | sha256 hash signer | 32 | 56 | `{signer}` |
| `P` | signed payload (CAP-40) | 37–100 | 69–165 (16 discrete lengths) | `{signer}` |
| `S` | ed25519 **secret seed** | 32 | 56 | `{redacted}`, never decoded |

Shape alone decides that a segment is replaced; the checksum only chooses between the typed placeholder and `{id}`.

**Seed handling.** Any segment of seed shape (`^[Ss][A-Da-d][A-Za-z2-7]{54}$`, also embedded with a base32 boundary,
also after percent-decoding, also in the query before it is dropped, also inside `http.route`) becomes `{redacted}`
**without consulting the checksum** — a seed with one typo still leaks 55 of 56 characters. The same applies to
JWTs (`eyJ…`, three parts), API-key-shaped strings (`sk_live_`, `ghp_`, `AKIA…`, …) and to the personal
identifiers the corpus pins: e-mail addresses (also `%40`-encoded and `mailto:`), federation addresses
(`name*domain`, also `%2A`-encoded), phone numbers and IPv4/IPv6 literals. Each hit increments a per-tenant counter
by kind and location; **neither the value nor a hash** is recorded. The tenant sees a warning to rotate the key.

**Cardinality guard** (write time, in the writer, after the deterministic rules; API routes) (C-24): default
**1,000 distinct routes per service per day** and **5,000 per tenant per day**, and **200 distinct siblings per
prefix**; the excess becomes `{overflow}` (`<prefix>/{overflow}` for siblings), is counted, and the tenant is told
to set `http.route`. The guard is first-come-first-served, so it is not part of the deterministic rule set and has
its own tests. L0 tenants additionally have a quota of 100 routes (C-19, ADR-0015).

**Web page paths (C-52).** The gateway runs the same `pathnorm` rule set (path mode) over every web page path
**before anything is spooled**, after discarding any query string or fragment it still receives (the tracker sends
the path only; there is no UTM reporting — C-65). Identifier-shaped segments (all StrKey types, hashes, UUIDs, long
numbers) become typed placeholders, and seeds, tokens, JWTs and e-mail addresses become `{redacted}`. **Redaction of
secrets and personal identifiers cannot be switched off.** The per-site folding setting has two values only
(C-70, C-89): `full` (default, every rule) and `relaxed`, which keeps **numbers, dates and slugs** literal; StrKeys
(including `G`/`M` wallet addresses), hashes, tokens and e-mail addresses are always folded or redacted. There is no
setting that keeps StrKeys or hashes. A corpus vector pins `relaxed`.
Custom-event names and property values pass the same server-side secret/PII guard. This closes the gap where a wallet address in a page URL would have been
stored in the spool, Umami and our daily aggregates.

**JSON-RPC.** Optional `rpc.method` dimension, taken only from the tenant's attribute, validated against a closed
set (the 13 documented Stellar RPC methods), anything else `_OTHER`; stored separately, not concatenated.

**Conformance.** The 451-vector corpus (432 path-mode, 19 route-mode; Horizon router, SEP documents, SDP, Anchor
Platform, StellarExpert, Stellarchain, Soroswap, Aquarius, generic, adversarial) is the conformance suite for both
call sites (Collector and gateway), and its vocabulary is the closed set above (C-16); the tests also
assert
 `normalize(normalize(x)) == normalize(x)` in both modes and that no output matches
`(?i)S[A-D][A-Z2-7]{54}` or contains `@`. Version semantics: PATCH changes no corpus output; MINOR only refines
outputs that were literal or `{id}`/`{token}`; MAJOR is anything else; each ships with a corpus diff.

## Consequences
- Positive: covers every common pattern listed above and adds Stellar-specific types; outputs are reproducible from the
  stored version; secrets never reach disk, logs or the database — on the API path and, through the gateway, on the
  web path.
- Positive: a mapping from old to new routes can be computed later from stored routes alone (they hold no raw values);
  erasure selectors can target normalised API routes and web paths (C-46, ADR-0030).
- Negative: free-text segments (asset codes alone, slugs, home domains, Horizon data keys outside their route) are
  not detectable; on the API side only the guard and tenant `http.route` contain them. Accepted false positives
  (`/user1234` → `{id}`) are pinned by the corpus.
- Single digits fold to `{int}` since 1.1.0 (C-141); literal case is preserved.
- Negative: tenants see normalised web page paths (`/account/{account}`), not the individual pages, in their
  dashboards; that is the price of not storing identifiers.
- Negative: raw paths and seeds still exist briefly in Collector and gateway memory before normalisation runs.
- Revisit if: SEP-23 adds a type; tenants hit the guard often; RE2 behaviour differs from the reference model.
- **Unproven:** the Go implementation itself (the corpus and fuzzing ran on the Python reference model, not on Go
  `pathnorm`) (only the Python reference model ran); RE2 equivalence; behaviour inside
  `scfsanitize` (S-04) and in the gateway's per-event budget.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Stellar path normalization: §3.1 StrKey table, regexes, false-positive analysis;
  §3.2 seed and secret policy; §3.3–3.4 identifiers and thresholds; §3.6 prior art; §3.7 metrics carry no path;
  §6.1 pipeline; §6.2 vocabulary; §6.4 precedence; §6.5 guard; §6.6 versioning; §6.7 RPC; §6.9 validation.
- Stellar path normalization test vectors: §3–4 reading rules and legend; §5 corpus;
  §6 coverage and self-check; §7 accepted imperfections.
- OTel semconv SDK dual export: §3.6 raw paths in `http.route`.
- OTel collector pipeline: §3.7 OTTL limits; §3.5 writer-side caps.
- Research synthesis: finding 4, conflict X-1.

## Open points
None outstanding. (Which rules a site may relax is settled by C-70 and C-89: `full` | `relaxed`, numbers, dates and
slugs only; the closed vocabulary, including `{wildcard}`, and who assigns `{unknown}` and `{overflow}` by C-16 and
C-89.) Still to be done, not decided: the `{unknown}` and `{overflow}` tests and the `relaxed` vector.
