# pathnorm — SCF path normaliser (`scf-path-rules/1.1.0`)

A hard-coded, versioned, deterministic and idempotent rule set that turns raw request paths, tenant `http.route`
templates and web page paths into low-cardinality routes, e.g.
`/accounts/GA7Q…VSGZ/payments?cursor=now` → `/accounts/{account}/payments`.
Decision: [ADR-0012](../../docs/adr/0012-path-normalisation-rules.md); clarifications C-16, C-24, C-52, C-65, C-70,
C-89; contract: `docs/contracts/wire-formats.md` §a.4 (web page paths) and §f.6 (Collector sanitise step).

Pure Go standard library, no I/O, no state. Two call sites run the same version, in memory, before anything is
queued or spooled:

- the Collector's sanitise step (`scfsanitize`) for API spans and metric data points → `NormalizeSpan`;
- the web gateway for page paths → `NormalizeWebPage` with the site's `path_folding`.

## API

```go
const RuleSetVersion = "scf-path-rules/1.1.0" // store next to every route

func Normalize(in string, opts Options) Result
func NormalizeSpan(in SpanInputs) Result               // http.route → url.path → http.target → url.full/http.url, else {unknown}
func NormalizeWebPage(path string, f Folding) Result   // gateway
func ParseFolding(s string) (Folding, error)           // "full" | "relaxed"
func DecodeStrKey(s string) (StrKeyType, []byte, error) // strict SEP-23 v1.4.0, all ten types

type Options struct {
	Input   InputKind // InputPath (url.path/http.target/url.full), InputRoute (tenant http.route), InputWebPage
	Folding Folding   // FoldingFull (default) | FoldingRelaxed
}

type Result struct {
	Route      string     // "/" + segments, or "*"
	Rules      []Rule     // rule IDs that fired, distinct, first-firing order
	Redactions Redactions // counts by Kind × Location — never the value, a prefix or a hash
	Flags      Flags      // FlagRedacted, FlagQueryStripped, FlagTruncated, FlagTooLong, FlagInvalid, FlagMethodStripped, FlagEmpty
}
```

- `Redactions.Count(kind, loc)`, `.ByKind(kind)`, `.Total()`, `.Each(fn)`. Kinds: `stellar_seed`, `jwt`, `api_key`
  (class `secret`), `email`, `federation`, `phone`, `ip` (class `pii`). Locations: `path`, `query` (query string,
  fragment, `;matrix` parameter — dropped, counted only), `route` (literal segment of a tenant `http.route`).
  The Collector maps any non-zero total to its `route_redacted` counter; the gateway to `drop/path_redacted`.
- `Normalize` never returns `{unknown}` or `{overflow}`; a client sending those strings gets `{id}` (ordinary text).
  `NormalizeSpan` returns `{unknown}` when all four inputs are empty (C-16, C-89). `{overflow}` belongs to the
  writer's cardinality guard (C-24), which runs after this rule set.
- Guarantees: `Normalize(Normalize(x,o).Route,o).Route == Normalize(x,o).Route`; same input → same output; query and
  fragment always stripped; output ≤ 1024 bytes, ≤ 12 segments + `{rest}`.

## Rule order

Pre-processing (whole input), in order:

| ID | Rule |
|---|---|
| A0.empty | empty input → `/` |
| A1.too_long | input > 8 KiB → `/{long}` (still scanned for secrets, counted) |
| A2.absolute | strip `scheme://authority` (only a leading absolute-form) |
| R0.strip_method | route mode: strip a leading `METHOD ` (`POST /transactions`) |
| A3.asterisk | `*` stays `*` |
| A4.query_fragment | from the first `?` or `#`: scan for seeds, JWTs, API keys (counted, location `query`), then drop |
| A5.leading_slash | add a missing leading `/` |
| A6 (not reported) | drop empty segments (duplicate and trailing slashes; root stays `/`) |
| A7.matrix | path modes: strip `;…` from a segment (scanned like the query) |
| A8.invalid_utf8 / A8.control_char | percent-decode once per segment; invalid UTF-8, C0/C1 controls or DEL → `{invalid}` |
| A9.dot_segment | resolve `.` and `..` (also `%2e%2e`) without escaping the root |
| A10.depth_cap | more than 12 segments → first 12 + `{rest}` |
| A11.output_cap | output > 1024 bytes → cut at a segment boundary + `{rest}` |

Per segment, first match wins (decoded segment; literals are re-emitted with canonical percent-encoding —
unreserved characters raw, `%2F` stays inside its segment, no case folding):

| Order | ID | Matches → output |
|---|---|---|
| R1 | R1.route_placeholder | route mode only: `:id`, `{id}`, `{id:\w+}`, `<int:id>`, `[id]`, `[...slug]`, `[[...slug]]` → `{lower-cased name}` (names ≤ 32 chars, `[A-Za-z_][A-Za-z0-9_]*`, not `unknown`/`overflow`); `*`, `**`, `*name`, `(.*)` → `{wildcard}` |
| K1 | K1.horizon_data_key | segment after `accounts/{account}/data/` → `{key}` (after S0, S1, S2) |
| S0 | — | own placeholders pass: `^\{[a-z_][a-z0-9_]{0,31}\}$` (except `{unknown}`, `{overflow}`), `^\{static\}\.[a-z0-9]{1,8}$` |
| S1 | S1.seed / S1.jwt / S1.api_key | seed-shaped run anywhere, any case `[Ss][A-Da-d][A-Za-z2-7]{54}` (checksum never consulted); JWT whole or embedded; API-key prefixes (`sk_live_`, `sk_test_`, `rk_`, `pk_`, `sk_…`, `ghp_`…, `github_pat_`, `xox?-`, `AKIA…`, `AIza…`) → `{redacted}` |
| S2 | S2.email / S2.federation / S2.phone / S2.ip | e-mail (whole, embedded, `%40`, `mailto:`), `name*domain`, `+` phone, IPv4/IPv6 → `{redacted}` |
| S3 | S3.long | decoded segment > 256 characters → `{long}` |
| S4 | S4.strkey.&lt;T&gt;[.lowercase] / S4.strkey_shape_badcrc | StrKey shape (upper-cased) → strict decode → `{account}` (G, M), `{contract}` (C, W), `{pool}` (L), `{balance}` (B), `{signer}` (T, X, P); shape with a bad checksum → `{id}` |
| S5 | S5.asset / S5.asset_fiat | `CODE:ISSUER`, `CODE-ISSUER[-1\|2]`, `stellar:CODE:ISSUER` (issuer must decode as G), `iso4217:XXX` → `{asset}` |
| S8 | S8.allow | versions (`v1`, `v1.2.3`, `v1beta1`), `sep-?N`, `cap-?N`, technical tokens (`ed25519`, `sha256`, `oauth2`, `2fa`, `i18n`, `s3`, `web3`, `erc20`, …) → literal |
| S6 | S6.event / S6.date / S6.cursor / S6.int / S6.decimal | `%019d-%010d` → `{event}`; ISO 8601 → `{date}`; `<int>-<int>` → `{cursor}`; any all-digit segment (single digits included, since 1.1.0) → `{int}`; negative/decimal → `{id}` |
| S7 | S7.uuid / S7.balance_hex / S7.hash64 / S7.hex / S7.hex_mid | UUID (any version/case, braced, `urn:uuid:`) → `{uuid}`; `00000000`+64 hex → `{balance}`; 64 hex (opt. `0x`) → `{hash}`; ≥ 16 hex or any `0x…` → `{hex}`; 7–15 hex with a digit and a letter → `{hex}` |
| S9 | S9.static / S9.static_literal | static extension with a content-hash stem token → `{static}.<ext>` (extension lower-cased); other safe static names stay literal |
| S10 | S10.ulid | ULID → `{id}` |
| S11 | S11.token | ≥ 32 base64/base64url/base58 characters with a digit or mixed case → `{token}` |
| S12 | S12.mixed_id / S12.random_case | token (split on `. _ ~ -`) with a digit run ≥ 3 or ≥ 8 chars with digit+letter; ≥ 16 letters with ≥ 6 case changes → `{id}` |
| S13 | S13.special | `: @ * + , = ! $ ' ( ) & ; % \ { } [ ] < > \| ^ ` "` or white space → `{id}` |
| S14 | S14.long_literal | literal > 64 characters → `{long}` |

**Page-path folding** (`Folding`, web page paths, C-52/C-70/C-89): `full` applies every rule. `relaxed` keeps
**numbers** (S6.int, S6.decimal → `F1.relaxed_int`, `F1.relaxed_decimal`), **dates** (S6.date → `F1.relaxed_date`)
and **slugs** (an S12.mixed_id segment made of lower-case words and numbers joined by `-`, at least one word —
`my-post-12345` → `F1.relaxed_slug`) literal, still under the 64-character cap. Everything else is identical to
`full`: StrKeys, hashes, UUIDs, events, cursors, tokens, static hashes and opaque ids are folded; secrets and personal
identifiers are redacted. There is no setting that keeps StrKeys or hashes.

## Placeholder vocabulary (closed, 24 — C-16)

`{account}` `{contract}` `{pool}` `{balance}` `{signer}` `{asset}` `{hash}` `{hex}` `{int}` `{event}` `{cursor}`
`{date}` `{uuid}` `{id}` `{token}` `{key}` `{static}` (as `{static}.<ext>`) `{redacted}` `{invalid}` `{long}` `{rest}`
`{wildcard}` (route mode) — plus `{unknown}` (`NormalizeSpan` only) and `{overflow}` (metrics writer only). Route
mode additionally keeps the tenant's lower-cased parameter names. Exported as `pathnorm.Vocabulary`.

## Versioning

`RuleSetVersion` (`scf-path-rules/MAJOR.MINOR.PATCH`) is stored with every route; history is never rewritten.

- **PATCH** — a fix that changes no output of the corpus (`testdata/vectors.json`, `testdata/vectors_extra.json`).
- **MINOR** — new rules that only change outputs that were literal or `{id}`/`{token}` (refinement).
- **MAJOR** — anything else, including a new placeholder or a changed rule order.
- Every rule change ships with a new version, a corpus diff in the same change, and a note in this README.
  Old routes keep their version; a mapping can be computed later from stored routes alone (they hold no raw values).

The corpus (`testdata/vectors.json`) was generated once from the research corpus by `internal/gen` and is now
owned here; `vectors_extra.json` is hand-maintained (relaxed folding, reserved placeholders, hardening).
Secret-seed tokens (`«S1»`, …) are never stored: the tests derive them at run time from the published formula.

### 1.1.0 (2026-11-18)

S6.int folds **every** all-digit segment, single digits included: `/items/3` → `/items/{int}`,
`/a/1/b/2/c/3` → `/a/{int}/b/{int}/c/{int}`. 1.0.0 kept single digits literal, which contradicted the rule that numeric IDs are removed
(`pathnorm.numeric-ids`) and let one endpoint split into up to eleven series. Version tokens (`v1`, `v2beta1`) and technical tokens (`2fa`, `s3`) are not bare digits and
stay literal (S8 runs first); `relaxed` page-path folding still keeps numbers (`/page/2`). MINOR bump: only
outputs that were literal change. Corpus diff: vectors 29, 30, 282, 284 and 427 (overrides with a note in
`internal/gen`), extra vectors 1048–1055. Routes stored under 1.0.0 keep their version (the metrics writer starts
a new cumulative source on a version change).

### 1.0.0 relative to the research reference model (`1.0.0-draft`)

Same outputs for all 451 corpus vectors. Hardening found or added during the build, none of which changes a corpus
output: seed shapes searched case-insensitively anywhere in a segment (fail closed); embedded JWTs redacted; API
keys counted in the query; `;matrix` parameters and over-long inputs scanned for secrets; C1 control characters →
`{invalid}`; `{unknown}`/`{overflow}` from clients are ordinary text; the static-file extension is lower-cased; the
output cap is exact (≤ 1024 bytes); S0 runs before K1 (a fuzzer-found idempotence bug:
`/accounts/{account}/data/{invalid}` re-normalised to `…/{key}`).

## Running

```sh
eval "$(mise env -s bash)"            # repo root: Go 1.27
cd packages/pathnorm
go test ./...                          # corpus 451/451, extra vectors, idempotence, 50k recombination, StrKey, units
go test -run=^$ -fuzz=FuzzNormalize -fuzztime=5m .
go test -run=^$ -fuzz=FuzzDecodeStrKey -fuzztime=1m .
go test -run=^$ -bench=. -benchmem .
go generate ./...                      # re-create testdata/vectors.json from references/ (needs the research corpus)
```

Fuzz inputs that once failed are kept in `testdata/fuzz/FuzzNormalize/` and run as regular tests.
