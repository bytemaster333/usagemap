# Wire formats — every non-REST interface

Status: **interface contract** (first version 2026-11-12, revised after the contract and architecture reviews).
Binding: the design-decision log in `docs/adr/README.md`, **C-01 … C-113** and later entries (including the spike
decisions C-99 … C-109 and the build decisions C-110 … C-113; a later entry wins over an earlier one).
**Revision C-136 (2026-11-16):** Stellar event schema v1 (§a.3.1), dev/preview origins and debug mode (§a.8), counter
records with Stellar property counts and dev events (§d.3), traction snapshot v2 and the public snapshot list
(§i.3.2–§i.3.4), SCF cohort vocabularies (§i.4), the daily seal (§m.2, superseding the `manage_data` anchor of §m.1)
and the ledger-file fetcher (§p.1).
Where a spike measured an interface, the spike README under `spikes/` holds the evidence; this document states the
resulting contract. Storage is defined in
[`docs/data-model.md`](../data-model.md); REST APIs in `docs/api/*.openapi.yaml`.

Conventions: JSON Schemas are draft 2020-12. "MUST/MUST NOT" as in RFC 2119. `<domain-a>`, `<domain-b>` are the
placeholder service domains; final path and host names are subject to the filter-list check (ADR-0004) —
renaming them is not a protocol change. "SCF operator" = portal user with `operator`/`operator_admin`; "service
operator" = the hosting entity (C-59). All times UTC. `b64u` = base64url without padding. **Ranges** (C-86): every
time range is `start` (inclusive) and `end` (exclusive), RFC 3339 in UTC; ranges over daily data have both bounds at
midnight UTC. There are no inclusive end dates in any format below.

| § | Interface | Producer → consumer | Transport |
|---|---|---|---|
| a | Tracker protocol `v1` | tracker → gateway | HTTPS, public |
| b | Challenge token, proof-of-work, multiplicity counting | gateway ↔ tracker; gateway in memory | inside §a |
| c | Forwarder → engine proxy → Umami | gateway forwarder → engine proxy (core) → Umami | HTTPS mTLS, private |
| d | Spool records and spool accounting | gateway → its own disk | files |
| e | Edge snapshot | control plane → gateway (via engine proxy) | HTTPS mTLS, private |
| f | OTLP ingest | tenant SDK/Collector → gateway → Collector | HTTPS/gRPC public; private `otlp` network (C-130) |
| g | Collector → writer | Collector → writer (direct; one name resolving to both writers, C-107) | OTLP/HTTP mTLS, private |
| h | Verdicts and reason codes | gateway, writer, jobs | vocabulary |
| i | `metrics_endpoint`, `health_endpoint`, traction snapshots | control plane → anyone | HTTPS, public |
| j | Umami adapter calls (live window) and the rollup read path | control plane/jobs → engine proxy → Umami; job `web_rollup` → `scf_ro` view | HTTPS mTLS, private; PostgreSQL |
| k | Key and token formats | control plane → humans/machines | strings |
| l | Edge counter delivery | gateway forwarder → control plane (via engine proxy) | HTTPS mTLS, private |
| m | Audit anchor (§m.1) and daily seal (§m.2, C-136) | jobs → public evidence repo; jobs → Stellar (testnet by default) | file; one `MEMO_HASH` transaction per day |
| n | Gateway peer key exchange (`K_day`, `K_mult`, `K_chal`) | gateway ↔ gateway | TLS mTLS, private mesh |
| o | Probe canary events | probes → gateway; jobs ← Umami | inside §a |
| p | On-chain reader output and ledger-file fetcher (§p.1, C-136) | public ledger-data store → `onchain-reader fetch` → mirror; `onchain-reader` → job `onchain_correlation` | HTTPS download; JSON Lines on stdout |

---

## a. Tracker → gateway protocol `v1`

### a.1 Endpoints and transport

| Route | Purpose |
|---|---|
| `GET /lib/<semver>/<profile>.js` (+ `.js.map` not served) | tracker files, `Cache-Control: public, max-age=31536000, immutable`, SRI-pinned; unknown version → `404`; **withdrawn version → `410 Gone`** (C-37); no `latest` alias |
| `GET /lib/manifest.json` / `manifest.json.sig` | hash manifest of every embedded version, combined into one document (`versions[]`, each the build's `manifest.json`); `.sig` is served **only when the release pipeline supplies a signature** (ADR-0023), otherwise `404` (C-118) |
| `POST /v1/c` | challenge |
| `POST /v1/e` | events (also proof-only and unload batches) |
| `OPTIONS /v1/c`, `/v1/e` | CORS preflight (only if a client sends a non-safelisted content type) |
| `GET /healthz` | node health (no tenant data) |

Hosts: the tracker carries a **fixed list of two ingest hosts on two domains** (`https://<ingest-a>.<domain-a>`,
`https://<ingest-b>.<domain-b>`) compiled into the pinned file (ADR-0004). HTTP/1.1 or HTTP/2 over TLS 1.2+.
**The gateway terminates TLS itself** (no TLS-terminating proxy in front of the ingest listener): it fingerprints
each connection's ClientHello and HTTP/2 connection preface in memory for the `transport_mismatch` reason (§a.6
step 3, §h.2, C-124). Behind a TLS terminator (`GW_ALLOW_PLAINTEXT=1`) there is no fingerprint and the check is
skipped.

Request rules:
- Body is a single JSON object, UTF-8, sent with **`Content-Type: text/plain;charset=UTF-8`** (CORS-safelisted, so
  `fetch(keepalive)` triggers no preflight; the tracker never uses `sendBeacon`, C-116). The gateway also accepts
  `application/json`.
  No `Content-Encoding`. No cookies, no credentials (`credentials: "omit"`).
- **Body ≤ 8 KiB** (checked on bytes received; there is no decompression on this path). Larger → `400`
  (`{"error":"too_large"}`).
- CORS response headers only when `Origin`'s host is a declared domain of the site (verified or not), **or the
  origin matches one of the site's dev origins (§a.8, C-136), or the site's debug mode is on (§a.8)**:
  `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, no `Allow-Credentials`, and on every `429` and `503`
  **`Access-Control-Expose-Headers: Retry-After`** — without it the tracker cannot read `Retry-After` (C-100). A
  response that carries `X-Scf-Debug` (§a.8) also exposes it (`Access-Control-Expose-Headers: X-Scf-Debug`, plus
  `Retry-After` where present). Otherwise no CORS headers.
- The page host is taken from the validated `Origin` header (fallback: `Referer` host); never from the payload.
- Requests carrying `Sec-GPC: 1` or `DNT: 1` are answered `202` and dropped (counter `drop/gpc_dnt`). The tracker
  itself sends nothing when GPC/DNT is set, after `optOut()`, or — in consent mode (`consent: "required"`, C-55) —
  before `grantConsent()` and after `revokeConsent()`.
- **No page titles** are read, sent or accepted (C-89). There is no title field in any schema below.

**Embedding and client behaviour (C-100, as built in `/tracker`; `tracker/README.md` is the tenant-facing text).**
- Script-tag configuration is exactly two attributes: `data-site="<22-char site key>"` (required) and
  `data-consent="required"` (optional, consent-gated mode, C-55). Nothing else is configurable and nothing is fetched;
  hosts, version, profile and the proof-of-work ceiling are compiled into each file (ADR-0004). npm: `init({ site,
  consent })`.
- `window.scf` is the command queue of the classic build: calls pushed before the script loads (`window.scf =
  window.scf || []; window.scf.push(["grantConsent"])`) are replayed in order; after load `window.scf` is the API
  object (`track`, `optOut`, `optIn`, `grantConsent`, `revokeConsent`, `destroy`).
- In consent-gated mode, `track()` calls made **before consent are dropped, not queued**; on `grantConsent()` the
  current page view is counted. Consent state is memory-only.
- At most **30 events** wait for the challenge and proof; while the proof is pending, events beyond 30 are dropped
  **newest-first** (a new event is not queued), so the landing page view and its referrer are kept (C-112(10)).
- The referrer host `r` is sent on the **first page view of a page load only**; SPA navigations never repeat it
  (they would re-count the referrer).
- **No Web Worker** (C-100, C-110): the proof-of-work runs with WebCrypto `deriveBits`, which browsers execute off the
  main thread, so a Worker would add bytes without unblocking anything; tenant CSPs need no `worker-src blob:` and the
  file stays one SRI-pinned script (§b.2). Real-device timing remains open (R-24).
- Size: the `strict` build of tracker 1.1.0 is 2,458 B gzip of its 2,500 B budget (42 B headroom) and `standard`
  2,826 B of 3,500 B (C-140; before C-140: 2,493 B and 2,854 B; C-32, C-138; 1.0.0: 2,408 B and 2,778 B; 2,464 B at C-100, 2,458 B after C-112(10), 2,408 B after
  dropping `sendBeacon`, C-116) — any shared-core growth must be paid for first.
- Delivery: the gateway image builds the tracker from source (`pnpm --filter @usagemap/tracker build`) and serves
  the embedded `tracker/dist/<semver>/` files; `dist/` is not in git. Released versions are archived byte for byte in
  `tracker/releases/<semver>/` (in git; the build checks each file against its archived manifest and copies it next to
  the current version), so every released version stays served unchanged (`tracker.intentional-upgrade`, C-138). `GET /lib/manifest.json` lists per file
  `bytes`, `gzip_bytes`, `sha256`, `sha384`, `integrity` (SRI string) plus build metadata, and is signed (ADR-0023).

### a.2 Challenge — `POST /v1/c`

Request (`ChallengeRequest`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/v1/challenge-request.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "s", "p", "tv"],
  "properties": {
    "v":  { "const": 1 },
    "s":  { "type": "string", "pattern": "^[0-9A-Za-z]{22}$", "description": "public site key" },
    "p":  { "enum": ["standard", "strict"], "description": "profile the script was built as" },
    "tv": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$", "description": "tracker version" }
  }
}
```

Response `200` (`ChallengeResponse`), `Cache-Control: no-store`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/v1/challenge-response.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "t", "pow", "ttl"],
  "properties": {
    "v":   { "const": 1 },
    "t":   { "type": "string", "pattern": "^[A-Za-z0-9_-]{123}$", "description": "challenge token, §b.1" },
    "pow": {
      "type": "object", "additionalProperties": false,
      "required": ["alg", "cost", "max", "pfx"],
      "properties": {
        "alg":  { "const": "pbkdf2-sha256" },
        "cost": { "type": "integer", "minimum": 1, "maximum": 65535 },
        "max":  { "type": "integer", "minimum": 1, "maximum": 65535 },
        "pfx":  { "type": "string", "pattern": "^[0-9a-f]{8}$" }
      }
    },
    "ttl": { "type": "integer", "description": "seconds the token is accepted (1800)" }
  }
}
```

Example: `{"v":1,"t":"AQAAB…(123 chars)","pow":{"alg":"pbkdf2-sha256","cost":512,"max":1024,"pfx":"9c1e04ab"},"ttl":1800}`.

A challenge is issued only if the site key is known, the site is in the snapshot (§e.3) and the `Origin` host is a
declared domain of the site; otherwise the gateway still answers per §a.5 (`404` unknown key, else `200` with a token
whose events will be rejected `origin_mismatch` — no oracle).

### a.3 Events — `POST /v1/e`

Flow (C-35): on page load the tracker fetches a challenge and **solves the proof before sending its first event**
(target ≤ 500 ms, S-07). If the page becomes hidden before the proof is solved, the pending event is sent with the
token and **no** proof (`suspect`, `proof_missing`). Later events of the same page load reuse token + proof up to the
per-token cap. SPAs refresh the challenge when the token is older than 25 minutes. The gateway keeps **no pending-
proof state**: every request is verifiable by any node.

Request (`EventBatch`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/v1/event-batch.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "s", "p", "tv", "e"],
  "properties": {
    "v":  { "const": 1 },
    "s":  { "type": "string", "pattern": "^[0-9A-Za-z]{22}$" },
    "p":  { "enum": ["standard", "strict"] },
    "tv": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
    "t":  { "type": "string", "description": "challenge token, 123 b64u characters ^[A-Za-z0-9_-]{123}$; absent or malformed is NOT a schema error: rejected/challenge_missing, answered 202 (C-118)" },
    "c":  { "type": ["integer", "null"], "minimum": 0, "maximum": 524287, "description": "proof-of-work counter; null/absent = no proof" },
    "sg": {
      "type": "object", "additionalProperties": false,
      "description": "client signal booleans — standard profile only (C-33)",
      "properties": {
        "wd":  { "enum": [0, 1], "description": "navigator.webdriver === true" },
        "vis": { "enum": ["v", "h", "p"], "description": "visible / hidden / prerendering at send time" },
        "act": { "enum": [0, 1], "description": "navigator.userActivation.hasBeenActive" }
      }
    },
    "e": { "type": "array", "minItems": 1, "maxItems": 10, "items": { "$ref": "#/$defs/event" } }
  },
  "$defs": {
    "eventId": { "type": "string", "pattern": "^[A-Za-z0-9_-]{22}$", "description": "random 128-bit per-event id, memory only (C-37)" },
    "path":    { "type": "string", "minLength": 1, "maxLength": 500, "pattern": "^/", "description": "location.pathname only" },
    "event": {
      "type": "object",
      "required": ["id", "k", "u"],
      "properties": {
        "id": { "$ref": "#/$defs/eventId" },
        "k":  { "enum": ["pv", "ev", "wl"] },
        "u":  { "$ref": "#/$defs/path" }
      },
      "oneOf": [
        { "$ref": "#/$defs/pageview" }, { "$ref": "#/$defs/custom" }, { "$ref": "#/$defs/wallet" },
        { "$ref": "#/$defs/stellar" }, { "$ref": "#/$defs/stellarAggregate" }
      ]
    },
    "pageview": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "k", "u"],
      "properties": {
        "id": true, "u": true,
        "k":  { "const": "pv" },
        "r":  { "type": "string", "maxLength": 253, "pattern": "^[a-z0-9.-]+$", "description": "referrer host (standard only; first page view of a page load only, C-100)" },
        "w":  { "enum": ["s", "m", "l", "x"], "description": "screen-width class (standard only)" },
        "l":  { "type": "string", "pattern": "^[a-z]{2,3}$", "description": "primary language subtag (standard only)" },
        "wk": { "const": true, "description": "Stellar Wallets Kit present on the page (standard only, C-93); counted, never forwarded; absent = not detected" }
      }
    },
    "custom": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "k", "u", "n"],
      "properties": {
        "id": true, "u": true,
        "k": { "const": "ev" },
        "n": { "type": "string", "minLength": 1, "maxLength": 50, "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" },
        "d": {
          "type": "object", "maxProperties": 10,
          "propertyNames": { "pattern": "^[a-z][a-z0-9_]{0,31}$" },
          "additionalProperties": {
            "oneOf": [
              { "type": "string", "maxLength": 100 },
              { "type": "number", "minimum": -1e15, "maximum": 1e15 },
              { "type": "boolean" }
            ]
          }
        }
      }
    },
    "wallet": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "k", "u", "n"],
      "properties": {
        "id": true, "u": true,
        "k":   { "const": "wl" },
        "n":   { "enum": ["wallet_modal_opened", "wallet_modal_closed", "wallet_selected", "wallet_connected",
                          "wallet_session_restored", "wallet_disconnected",
                          "sign_requested", "sign_completed", "sign_failed"] },
        "wid": { "enum": ["albedo", "varial", "fordefi", "rabet", "xbull", "lobstr", "hana", "klever", "onekey",
                          "bitget", "cactuslink", "dcent", "scopuly", "metamask", "ghostsig", "ledger", "trezor",
                          "wallet_connect", "hot_wallet", "other"],
                 "description": "wallet id; 'freighter' is sent as 'varial'; unknown ids as 'other'" },
        "sk":  { "enum": ["tx", "auth_entry", "message", "tx_submit"], "description": "sign kind (sign_* only)" },
        "net": { "enum": ["public", "testnet", "futurenet", "other"] },
        "out": { "enum": ["connected", "dismissed", "error"], "description": "modal outcome (wallet_modal_closed only)" },
        "dur": { "enum": ["lt5s", "5_30s", "gt30s"], "description": "duration bucket (sign_completed/failed only)" },
        "err": { "enum": ["rejected", "timeout", "unsupported", "other"], "description": "error class (sign_failed only)" }
      }
    },
    "stellar": {
      "type": "object", "additionalProperties": false,
      "description": "Stellar event schema v1 (§a.3.1, C-136); a `wl` event WITH `sv` — the legacy `wallet` shape has no `sv`",
      "required": ["id", "k", "u", "n", "sv"],
      "properties": {
        "id": true, "u": true,
        "k":   { "const": "wl" },
        "sv":  { "const": 1, "description": "Stellar event schema version" },
        "n":   { "enum": ["wallet_modal_opened", "wallet_modal_closed", "wallet_selected", "wallet_connect",
                          "wallet_disconnect", "sign_requested", "sign_approved", "sign_rejected", "tx_submitted",
                          "smart_wallet_created", "passkey_used", "wallet_connect_failed", "walletconnect_session",
                          "walletconnect_request"] },
        "wt":  { "enum": ["freighter", "albedo", "xbull", "lobstr", "hana", "hot", "rabet", "walletconnect", "ledger",
                          "trezor", "fordefi", "klever", "onekey", "bitget", "cactuslink", "dcent", "scopuly", "metamask",
                          "ghostsig", "passkey", "privy", "injected_other", "unknown"], "description": "wallet type" },
        "net": { "enum": ["mainnet", "testnet", "futurenet", "local", "unknown"], "description": "network, mapped in memory from the passphrase" },
        "ck":  { "enum": ["new", "restored"], "description": "connect kind (wallet_connect)" },
        "sk":  { "enum": ["tx", "auth_entry", "message", "tx_submit"], "description": "sign kind (sign_*)" },
        "ec":  { "enum": ["user_rejected", "invalid_request", "external_service", "internal", "timeout", "unsupported", "unknown"],
                 "description": "SEP-43 error class (sign_rejected)" },
        "rc":  { "enum": ["success", "failed", "pending", "try_again_later", "error"], "description": "submit result class (tx_submitted)" },
        "dur": { "enum": ["lt5s", "5_30s", "gt30s"], "description": "duration bucket (sign_approved, sign_rejected)" },
        "out": { "enum": ["connected", "dismissed", "error"], "description": "modal outcome (wallet_modal_closed)" },
        "po":  { "enum": ["register", "authenticate", "sign"], "description": "passkey operation (passkey_used)" },
        "fr":  { "enum": ["user_rejected", "wallet_not_installed", "wallet_locked", "network_mismatch", "timeout", "error_other"],
                 "description": "connect-failure reason (wallet_connect_failed)" },
        "wc":  { "enum": ["none", "varial_inapp", "dcent_inapp", "scopuly_inapp", "other_inapp", "unknown"],
                 "description": "wallet context from window.stellar.provider/platform and window.scopuly.platform only (wallet_connect, wallet_connect_failed, walletconnect_session)" },
        "ws":  { "enum": ["proposed", "approved", "rejected"],
                 "description": "WalletConnect session or request state (walletconnect_session, walletconnect_request)" },
        "wm":  { "enum": ["sign_xdr", "sign_submit_xdr", "sign_message", "sign_auth_entry"],
                 "description": "WalletConnect Stellar method (walletconnect_request)" }
      }
    },
    "stellarAggregate": {
      "type": "object", "additionalProperties": false,
      "description": "Browser RPC/Horizon telemetry (tracker /stellar-rpc, §a.3.2): one aggregate per page lifecycle and UTC day, counts per cell only; `u` is ignored by the gateway, never stored",
      "required": ["id", "k", "u", "n", "sv", "c"],
      "properties": {
        "id": true, "u": true,
        "k":  { "const": "wl" },
        "sv": { "const": 1 },
        "n":  { "const": "stellar_rpc" },
        "c":  {
          "type": "array", "minItems": 1, "maxItems": 100,
          "description": "cells [api, operation, network, outcome, latency bucket, count]",
          "items": {
            "type": "array", "minItems": 6, "maxItems": 6,
            "prefixItems": [
              { "enum": ["rpc", "horizon"] },
              { "type": "string", "pattern": "^[a-z0-9_]{1,40}$", "description": "RPC method or Horizon route template (closed lists, §a.3.2)" },
              { "enum": ["mainnet", "testnet", "futurenet", "local", "unknown"] },
              { "enum": ["ok", "rpc_error", "http_4xx", "http_429", "http_5xx", "timeout", "network_error"] },
              { "enum": ["lt100ms", "100_500ms", "500_2000ms", "gt2000ms"] },
              { "type": "integer", "minimum": 1, "maximum": 1000000 }
            ]
          }
        }
      }
    }
  }
}
```

**Event ids (C-37, C-140).** `eventId` is 16 random bytes as 22 base64 characters with `+` and `/` written `_`
(≥ 127 bits), one per action, resent unchanged on every retry on either host (including the 3 s abort and retry on
the other host); memory only. The gateway derives the event key of §c.2 and the unidentified surrogate of §c.3 from
it, so every copy of one event is recognised downstream.

**No event fires on page load** (C-75): Umami does not count a visit with a custom event as a bounce, so an automatic
event would erase bounces. Wallets Kit presence is the page-view field `wk` (`standard` only), which the gateway adds
to the per-site daily counter `kit_present_pageviews` and strips before spooling (C-93). **Tier 0** (on by default in
`standard`, C-13) sends wallet events only for user actions: `wallet_modal_opened`, `wallet_modal_closed`,
`wallet_selected`, `wallet_disconnected` (a disconnect click, C-93). **Tier 1** (`attachWalletsKit(kit)`) adds
`wallet_connected`, `wallet_session_restored`, `sign_requested`, `sign_completed`, `sign_failed`. In `strict`, wallet
events are sent only with Tier 1 (C-13) — a rule of the tracker build: the gateway cannot tell whether the Tier-1
adapter is attached, so it does **not** strip Tier-0 wallet events of a `strict` site (C-118).

Field rules by event type (gateway enforces; extra fields for the event type are discarded, not rejected):
`wallet_selected`, `wallet_connected`, `wallet_session_restored`, `wallet_disconnected` → `wid` (+ `net` on
`wallet_connected`); `wallet_modal_closed` → `out` (+ `wid` when connected); `sign_requested` → `wid`, `sk`;
`sign_completed` → `wid`, `sk`, `dur`; `sign_failed` → `wid`, `sk`, `dur`, `err`. Never addresses, XDR, signatures,
memos or error text (ADR-0029, C-45); a test asserts the outgoing body never matches `[GCMSTXPLBW][A-Z2-7]{55}` or
base64 XDR prefixes. These are the **legacy** (schema version 0) rules; trackers from the C-136 release on send
Stellar event schema v1 (§a.3.1), which also covers the Freighter wrapper, direct wallet APIs, injected providers and
the passkey/smart-account adapters, with the same test on every adapter.

Examples (validated against the schema, §Validation):

```json
{"v":1,"s":"Q4mZ8bS1pTn0aR7cLx2VwE","p":"standard","tv":"1.0.0","t":"AQAAB0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR","c":417,
 "sg":{"wd":0,"vis":"v","act":0},
 "e":[{"id":"3qJb2K0z5yTn8vW1aR4cLx","k":"pv","u":"/pricing","r":"news.ycombinator.com","w":"l","l":"en","wk":true}]}
```
```json
{"v":1,"s":"Q4mZ8bS1pTn0aR7cLx2VwE","p":"strict","tv":"1.0.0","t":"AQAAB0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR","c":88,
 "e":[{"id":"Zc8vW1aR4cLx3qJb2K0z5y","k":"ev","u":"/app","n":"signup","d":{"plan":"free"}}]}
```
```json
{"v":1,"s":"Q4mZ8bS1pTn0aR7cLx2VwE","p":"standard","tv":"1.0.0","t":"AQAAB0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR","c":417,"sg":{"wd":0,"vis":"v","act":1},
 "e":[{"id":"b2K0z5yTn8vW1aR4cLx3qJ","k":"wl","u":"/swap","n":"sign_completed","wid":"varial","sk":"tx","dur":"5_30s"}]}
```
```json
{"v":1,"s":"Q4mZ8bS1pTn0aR7cLx2VwE","p":"standard","tv":"1.1.0","t":"AQAAB0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR","c":417,"sg":{"wd":0,"vis":"v","act":1},
 "e":[{"id":"c3L1a6zUo9wX2bS5dMy4rK","k":"wl","sv":1,"u":"/swap","n":"sign_rejected","wt":"freighter","net":"mainnet","sk":"tx","dur":"lt5s","ec":"user_rejected"},
      {"id":"d4M2b7aVp0xY3cT6eNz5sL","k":"wl","sv":1,"u":"/swap","n":"tx_submitted","wt":"freighter","net":"testnet","rc":"try_again_later"}]}
```

### a.3.1 Stellar event schema v1 (`scf-stellar-events/1`, C-136)

A versioned, **address-free** vocabulary of Stellar wallet and transaction events, the same for every tenant so SCF
can compare projects. Published with the tracker (`tracker/README.md`) and in the metric definitions. Status names
follow common prior art; payloads deliberately do not (no addresses, hashes, amounts, XDR, memos, signatures,
passphrases, error text or free text — **every property value is a closed enum**). A v1 event is a `wl` event with
`sv: 1` (schema `$defs/stellar` above); a `wl` event without `sv` is a legacy ADR-0029 event (schema version 0),
which the gateway maps to v1 (table below).

| Event `n` | Fields (wire key → rollup key) | Sent when (source) |
|---|---|---|
| `wallet_modal_opened` | — | wallet picker shown (Tier 0 DOM signal or adapter) |
| `wallet_modal_closed` | `out` → `outcome`; `wt` → `wallet` when connected | picker closed |
| `wallet_selected` | `wt` | user picked a wallet |
| `wallet_connect` | `wt`, `net`, `ck` → `connect_kind` (`new` · `restored`) | an address became available; `restored` for a session restored on page load (never counted as a new connection, ADR-0029) |
| `wallet_disconnect` | `wt`; `net` optional | user disconnected |
| `sign_requested` | `wt`, `net`, `sk` → `sign_kind` | the app asked the wallet to sign |
| `sign_approved` | `wt`, `net`, `sk`, `dur` → `duration` | the wallet returned a signature |
| `sign_rejected` | `wt`, `net`, `sk`, `dur`, `ec` → `error_class` | the wallet returned an error or the call threw |
| `tx_submitted` | `rc` → `result_class`, `net`; `wt` optional | the app's submit call settled (Horizon `submitTransaction`, RPC `sendTransaction` + poll, `signAndSubmitTransaction`) |
| `smart_wallet_created` | `net`; `wt` optional (usually `passkey`) | a smart wallet (contract account) was deployed for the user (event name only: the payload carries a C-address) |
| `passkey_used` | `po` → `passkey_op` (`register` · `authenticate` · `sign`), `net` | a WebAuthn ceremony of a passkey wallet completed |
| `wallet_connect_failed` (1.2.0) | `wt`, `net`, `fr` → `failure_reason`, `wc` → `wallet_context` | an explicit connect produced no usable connection |
| `walletconnect_session` (1.2.0) | `ws` → `wc_state` (`proposed` · `approved` · `rejected`), `net` (the proposal's single chain, else `unknown`), `wc` | the Wallets Kit's WalletConnect module proposed a session (its `getAddress`), and how it ended |
| `walletconnect_request` (1.2.0) | `wm` → `wc_method`, `net` (`stellar:pubnet` → `mainnet`, else `testnet`, as the module picks the chain), `ws` (`approved` · `rejected`) | a WalletConnect sign request settled (counted-only) |

Closed lists (any other value is a schema violation, `400`):
- **Wallet type `wt`** — the Stellar Wallets Kit module ids mapped to canonical names (`freighter` and its 2.8.0
  id `varial` → `freighter`; `wallet_connect` → `walletconnect`; `hot_wallet` → `hot`; the other kit ids `albedo`,
  `xbull`, `lobstr`, `hana`, `rabet`, `ledger`, `trezor`, `fordefi`, `klever`, `onekey`, `bitget`, `cactuslink`,
  `dcent`, `scopuly`, `metamask`, `ghostsig` unchanged), plus `passkey` (passkey/smart-account wallets),
  `injected_other` (an injected provider the adapter recognises by its documented global but has no name for) and
  `unknown`. The alias map is versioned with the tracker; an id outside it becomes `unknown`.
- **Network `net`** — from the passphrase, in memory, never sent: `Public Global Stellar Network ; September 2015` →
  `mainnet`, `Test SDF Network ; September 2015` → `testnet`, `Test SDF Future Network ; October 2022` → `futurenet`,
  `Standalone Network ; February 2017` → `local`, anything else or none → `unknown`.
- **SEP-43 error class `ec`** — from the wallet error's SEP-43 `code`: `-4` → `user_rejected`, `-3` →
  `invalid_request`, `-2` → `external_service`, `-1` → `internal`; no answer within the adapter's timeout →
  `timeout`; method not offered by the wallet → `unsupported`; anything else (no code, unknown code, a thrown
  non-SEP-43 error) → `unknown`. The error message is never read beyond the code.
- **Submit result class `rc`** — RPC `sendTransaction` status `ERROR` → `error`, `TRY_AGAIN_LATER` →
  `try_again_later`, `PENDING` or `DUPLICATE` (the same transaction was already submitted; polled the same way; poll not
  finished within the adapter's bound) → `pending`, then the poll's
  `SUCCESS` → `success` and `FAILED` → `failed`; Horizon: `200` → `success`, `400` with `tx_failed` / `op_*` result
  codes → `failed`, `504` → `pending`, any other failure or exception → `error`. **No transaction hash, envelope,
  result XDR or fee is read into the event.**
- `sk`, `dur`, `out`, `po`: as in the schema.
- **Connect-failure reason `fr`** (tracker 1.2.0; only for an EXPLICIT connect — `requestAccess`, a kit module's
  `getAddress`, the kit's modal, a prompted passkey connect, Privy `createWallet`/login — made while not connected; a
  silent restore that finds nothing is normal and sends nothing): the adapter's timeout → `timeout`; SEP-43 code `-4`,
  WalletConnect `USER_REJECTED` (`5000`), Privy `exited_auth_flow` or WebAuthn `NotAllowedError` → `user_rejected`;
  a wallet that reported itself unavailable (`isConnected`/`isAvailable` false) or WebAuthn `NotSupportedError` →
  `wallet_not_installed`; an answer with neither error nor address → `wallet_locked`; the wallet's own reported
  network differs from the app's `networkPassphrase` → `network_mismatch` (sent INSTEAD of `wallet_connect`); anything
  else → `error_other`. Only numeric codes, Privy's closed error code and the WebAuthn `DOMException` name are
  compared; no message is read. In the kit's modal a code `-1` (the kit's own "closed the modal", also what its
  `parseError` gives a codeless wallet error) counts as `error_other` only after a wallet was picked.
- **Wallet context `wc`** (1.2.0): from exactly `window.stellar.provider`/`.platform` (Varial/Freighter Mobile, D'CENT)
  and `window.scopuly.platform` (Wallets Kit 2.8.0 `varial`, `dcent`, `scopuly` modules): `platform` `mobile` with
  provider `freighter`/`varial` → `varial_inapp`, `dcent` → `dcent_inapp`, other → `other_inapp`; Scopuly `mobile` →
  `scopuly_inapp`; no sentinel or a desktop extension → `none`; a sentinel whose `platform` is not a string or that
  throws → `unknown`. Never a version, never the User-Agent.
- **WalletConnect method `wm`**: `stellar_signXDR` → `sign_xdr`, `stellar_signAndSubmitXDR` → `sign_submit_xdr`,
  `stellar_signMessage` → `sign_message`, `stellar_signAuthEntry` → `sign_auth_entry`. `walletconnect_request` is
  counted-only (C-137): a sign request can coincide with a ledger transaction.
- **`privy`** (1.2.0): Privy embedded Stellar wallets (`@privy-io/react-auth` ≥ 3.52, "Tier 2" chain); a raw-hash
  signature is `sk: tx`.

**As built (C-138; tracker 1.1.0, `tracker/src/stellar.ts`).**
- `wt`: the alias map is case-insensitive and also covers the Wallets Kit 2.8.0 ids that are not lower-case snake
  case — `hot-wallet` (and `hotwallet`) → `hot`, `BitgetWallet` (and `bitkeep`) → `bitget`, `LEDGER` → `ledger`,
  `TREZOR` → `trezor`, `wallet-connect` → `walletconnect`, `d'cent` → `dcent`.
- `net`: besides the four passphrases, a wallet's own **network name** maps to the same closed list
  (case-insensitive): `PUBLIC`/`pubnet`/`mainnet` → `mainnet`, `TESTNET` → `testnet`, `FUTURENET` → `futurenet`,
  `STANDALONE`/`local` → `local` (Freighter's `getNetwork().network`, Albedo's `public`/`testnet`); anything else →
  `unknown`. Neither the passphrase nor the name is sent.
- `ec: unsupported` is set by the adapter itself when the wallet does not offer the called method (an internal
  sentinel, never read from a wallet's error); a cancelled or failed passkey (WebAuthn) prompt carries no SEP-43 code
  and is `unknown`.

Field placement is enforced by the gateway (§a.4): fields not listed for the event are discarded and counted
(`drop/profile_field_stripped`) — for a legacy event too, after mapping (C-138); a missing `wt` or `net` is recorded
as `unknown`; the event is never rejected for a missing field (no oracle).

**Where v1 events go.**
- Every accepted (`verified` or `suspect`) v1 event — and every legacy event after mapping — is counted into
  `web_event_property_daily` (data-model §12.1) through the `props` array of the counter record (§d.3): one
  `_total`/`all` row plus one row per field present, keyed by event, network (`net`, else `unknown`) and verdict.
  `dev` and `rejected` events are never counted.
- **Counted-only events (C-137).** An event that can coincide with a public ledger transaction — `sign_requested`,
  `sign_approved`, `sign_rejected` (every `sk`), `tx_submitted`, `smart_wallet_created` and `passkey_used` (every
  `po`) — is **counted only: never forwarded to Umami, never spooled**, and it does not count towards the site's daily
  quota. Rule: a session-level record (a visit with path, second-precision time, country and device) may never carry
  an event whose time could be matched to a ledger operation, because on a low-traffic contract that match ties a
  public account to a browser session (EDPB 02/2025). The counts lose nothing: the property
  rollup holds them all. A counted-only event produces its `props` rows **and nothing else** (C-138): it adds nothing
  to the batch's web counters (§d.3 `web`: verdict, reason, `drop`, `tracker_version`, `wk`), so it can neither
  inflate the verdict counts nor be told apart from a page view in them.
- The other v1 events — `wallet_modal_opened`, `wallet_modal_closed`, `wallet_selected`, `wallet_connect`,
  `wallet_disconnect` — are forwarded to Umami as custom events with the canonical name and `data` keyed by the
  rollup keys (§c.2). They have no on-ledger counterpart (connecting reads an address from the wallet; nothing is
  submitted), so their time matches nothing public.
- **Source of truth (C-137).** The wallet funnel and every Stellar-event figure are read from
  `web_event_property_daily` only (day of receipt, per-minute counter records, so up to 60 s of counts of a node that
  dies before its record is fsync'd are lost, §d.3), never from Umami's event table (which holds only the forwarded
  events, after a delay of up to 72 hours and with Umami's own bot filter). The two are not reconciled and the metric
  definitions say so.
- Bounce rule unchanged: a forwarded wallet event follows a user action and makes the visit a non-bounce (C-75);
  counted-only events never reach a visit and so never change bounce, visits or duration.

**Legacy mapping (schema version 0 → 1).** The gateway maps legacy events before counting and forwarding, so storage,
rollups and dashboards see only v1 names. Legacy `wid` maps like `wt` (`other` → `unknown`); `net` `public` →
`mainnet`, `other` → `unknown`.

| Legacy (ADR-0029) | v1 |
|---|---|
| `wallet_modal_opened`, `wallet_modal_closed` (`out`, `wid`), `wallet_selected` (`wid`) | same name; `wid` → `wt` |
| `wallet_connected` (`wid`, `net`) | `wallet_connect`, `ck: new` |
| `wallet_session_restored` (`wid`, `net`) | `wallet_connect`, `ck: restored` |
| `wallet_disconnected` (`wid`) | `wallet_disconnect` |
| `sign_requested` (`wid`, `sk`, `net`) | `sign_requested` |
| `sign_completed` (`dur`) | `sign_approved` |
| `sign_failed` (`dur`, `err`) | `sign_rejected`; `err` `rejected` → `ec: user_rejected`, `timeout` → `timeout`, `unsupported` → `unsupported`, `other` → `unknown` |

Umami events stored before C-136 keep their legacy names; dashboards that read Umami's event names map them with the
same table. **Versioning rule:** the vocabulary is versioned by `sv`. Adding an event name or an enum value is a
**minor** change: it is added to the gateway, the counter-record schema and the `web_event_property_daily` check
first (a migration), and only then may a tracker release send it (§a.7's two steps). Removing or renaming a value, or
changing a meaning, creates `sv: 2`; the gateway keeps accepting `sv: 1` (and legacy) for the life of the service and
maps it, as above.

### a.3.2 Browser Stellar RPC / Horizon aggregate (`stellar_rpc`, tracker 1.2.0)

The tracker subpath `/stellar-rpc` hooks js-stellar-sdk's public `httpClient.interceptors` (13.x–14.3.0: the
module-wide `AxiosClient`) of the app's `rpc.Server` / `Horizon.Server` in the browser and keeps **in memory only**
one count per cell `[api, operation, network, outcome, latency]`. On page hide (`pagehide`, `visibilitychange` →
hidden) and on a UTC day change it hands the cells to the running tracker as ONE `wl` event `{sv: 1, n:
"stellar_rpc", c: [...]}` (schema `$defs/stellarAggregate`) and clears them; blocked tracking (GPC, DNT, opt-out, no
consent) discards them.
- `api`: `rpc` · `horizon`. `operation`: RPC — `get_health`, `get_network`, `get_latest_ledger`, `get_ledgers`,
  `get_ledger_entries`, `get_events`, `get_fee_stats`, `get_version_info`, `get_transaction`, `get_transactions`,
  `simulate_transaction`, `send_transaction`, `query_events`, `other`; Horizon — the 50 route templates of
  `packages/stellar-otel` in snake case (`/` → `root`, `/accounts/{id}/data/{key}` → `accounts_id_data_key`, a base-path
  prefix such as a provider API key skipped), `other`. The gateway folds a well-formed unknown operation into `other`
  (a newer tracker never costs the batch). `network`: the closed list (option, or learnt from `getNetwork`).
  `outcome`: `ok`, `rpc_error` (JSON-RPC error answer), `http_4xx`, `http_429`, `http_5xx`, `timeout`, `network_error`.
  `latency`: `lt100ms`, `100_500ms`, `500_2000ms`, `gt2000ms`. `count` 1…1,000,000; at most 100 cells (the last 10
  reserved for `other`).
- **Gateway:** verdict as for any event (a rejected batch counts nothing; event-id de-duplication applies), then the
  cells go to the counter record's optional `rpc` part (§d.3) and **nothing else**: never spooled or forwarded, no web
  counter, no quota, no multiplicity observation, no surrogate, not in the dev panel; `u` is dropped. Sent only when
  the snapshot advertises `"rpc"` in `counter_features` (C-137 upgrade rule; until then dropped in memory).
- **Privacy argument.** The cells are per-site daily totals of closed enums: there is no visitor key, no session, no
  page path, no time or order of calls (only a coarse latency bucket), no URL, params, hash, XDR or address. The
  page-lifecycle batching means one aggregate cannot be split into individual calls, and the stored row
  (`web_rpc_client_daily`) has the same granularity as `web_event_property_daily`. It is the browser counterpart of
  `scf.stellar_client_*` (§g.7) and, like it, never counts as API usage or traffic.

**Custom events are unchanged.** `ev` events keep their free names and the value guard of §a.4 (StrKey, e-mail and
JWT shapes, ≥ 32-character base64/hex runs and API-key prefixes are dropped). A custom event that happens to use a v1
name is still a custom event: it is never counted as a Stellar event.

### a.4 Profiles — what each may send (gateway-enforced, C-37)

The gateway applies the **site's configured** profile (from the snapshot), not the request's `p`; fields the site's
profile does not allow are discarded and counted (`drop/profile_field_stripped`).

| Field | `standard` | `strict` | Server-side handling |
|---|---|---|---|
| `u` path | yes | yes | query/fragment stripped if present (C-65), then **pathnorm** (C-52) per the site's `path_folding` (below) |
| `r` referrer host | yes (host only, cross-site) | **no** | lower-cased; self-referral dropped |
| `w` width class | yes | no | `s` ≤ 480 px, `m` 481–1024, `l` 1025–1920, `x` > 1920 |
| `l` language | yes | no | primary subtag |
| `wk` Wallets Kit present | yes | no | counted into `kit_present_pageviews` (per site and day), **never forwarded** (C-93) |
| `ev` custom events | yes | yes | name/props through the guard |
| `wl` wallet events (legacy and Stellar schema v1, §a.3.1) | Tier 0 (user actions: `wallet_modal_opened`, `wallet_modal_closed`, `wallet_selected`, `wallet_disconnect`) + Tier 1 (adapters) | only when the tenant attached an adapter (Tier 1, C-13) | closed sets only; legacy mapped to v1; field placement per §a.3.1; counted into the property rollup; the counted-only events of §a.3.1 (`sign_*`, `tx_submitted`, `smart_wallet_created`, `passkey_used`) are never forwarded (C-137) |
| `sg` client signals | yes | **no** (C-33) | absence is never a `suspect` reason |
| challenge + proof | yes | yes (C-33) | strict traffic can be `verified` |

**Page-path folding** (`sites.path_folding`, C-52, C-70, C-89) has exactly two values:
- `full` (default): the pathnorm rule set as published — identifier-shaped segments become typed placeholders.
- `relaxed`: **numbers, dates and slugs are kept** as literals; everything else is handled exactly as in `full`.

In **both** values, StrKeys (all SEP-23 types), hashes, UUIDs and other identifiers are folded to their placeholders,
and seeds, tokens, JWTs, API-key-shaped strings and e-mail addresses become `{redacted}` (counted `drop/path_redacted`
per path). There is no value that keeps StrKeys or hashes. The pathnorm corpus carries test vectors for `relaxed`
(owned by the pathnorm workstream).

**Server-side guard** (custom-event names and property values; C-52, C-100): the gateway applies **the same value
guard as the tracker** plus the API-key prefixes of the pathnorm rule set. A value matching any of these is dropped
and counted (`drop/prop_redacted`): e-mail `[^@\s]+@[^@\s]+\.[A-Za-z]{2,}` (also `%40`); JWT
`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`; any run of **≥ 32 characters of `[A-Za-z0-9+/]`** (base64/hex —
this covers every StrKey, `[GCMSTXPLBW][A-Z2-7]{55}` and `[MW][A-Z2-7]{68}`, and hashes); API-key prefixes of
`pathnorm`; and every value pathnorm classifies as a personal identifier — federation address `name*domain.tld`,
phone number `+` digit and 6–20 of `[0-9 ().-]`, IPv4/IPv6 literal (this also refuses `hh:mm:ss`) — judged on the
whole value, on each word of it and on each phone-shaped run, because a value is free text (C-140). The tracker's
`track()` returns `false` and sends nothing for the same matches.

### a.5 Responses

| Status | When | Body | Tracker action |
|---|---|---|---|
| `202` | every **well-formed** batch, whatever the verdict (no oracle, C-39); also suspended/pending tenants and GPC/DNT drops (counted); a batch with nothing to spool waits for the same group commit (about as long as a data commit, C-140) | empty | done |
| `400` | not JSON, schema violation, > 8 KiB, > 10 events | `{"error":"malformed"\|"too_large"}` | no retry |
| `404` | unknown site key, site not in the snapshot (archived, purging, removed tenant — C-72, CR-19); carries CORS (Origin echoed, no credentials), as do 503s given before the site is resolved (C-140) | `{"error":"unknown_site"}` | no retry; stop for this page |
| `410` | tracker version `tv` withdrawn (C-37) | `{"error":"withdrawn"}` | stop |
| `429` | per-site rate limit (this node's share) or per-subnet rate limit | `{"error":"rate_limited"}` + `Retry-After` | retry after delay |
| `429` | site `over_quota` (C-90), or this node's share of the tenant's daily verified quota used up — decided before the verdict, so every non-dev batch of the tenant gets it (C-140) | `{"error":"quota_exceeded"}` + `Retry-After` (seconds to 00:00 UTC, at most 3600) | retry after delay |
| `503` | spool not durable (disk/fsync failure, draining) or the site's spool share used up, whatever the verdict (C-140) | `{"error":"unavailable"}` + `Retry-After` | retry on the other host |

**Debug header (C-136, C-137).** On a `/v1/e` or `/v1/c` answer for a request from a dev origin the gateway adds
`X-Scf-Debug: v=1; class=dev; reasons=dev_origin` (plus `dev_rate_limited`) and nothing else; only while the site's
debug mode is on does the header carry the class and reason codes of any request, dev or not (§a.8). The status codes
above do not change — a dev or debug request still gets `202` for every well-formed batch (C-39), and `429` when a rate
limit applies; only the header explains it.

Every `429` is counted per site (`drop/rate_limited`, `drop/quota_exceeded`), so a site whose visitors are refused
because of its quota is reported per site (C-80). `202` is sent **only after the record is fsync'd** (group commit,
ADR-0020). Tracker retry policy: on network error, timeout (3 s), `429`, `503` or other `5xx`: up to 2 retries
alternating between the two hosts, waiting `min(Retry-After, 30 s)` or 500 ms × 2ⁿ with jitter; **the same event ids**
are resent; the gateway drops repeats within a batch and seen in the last 10 minutes on that node, and the engine
proxy drops copies that reached another node by event key (§c.5, C-140) (C-37, `drop/duplicate_event_id`).
On `pagehide` / `visibilitychange` to hidden the queue is flushed with `fetch(keepalive)` (no retry), **never
`sendBeacon`**: EasyPrivacy blocks every third-party `ping` request (`*$ping,third-party`), which is what a beacon is
(C-116). A page restored from the back/forward cache is not counted again.

### a.6 Gateway processing order (per event; normative)

1. Parse and size-check; resolve the site from the snapshot (`404`/`410` checks). **If the `Origin` (fallback
   `Referer`) matches one of the site's dev origins (§a.8), the batch is a `dev` batch:** steps 2, 4, 5 and 6 are
   skipped except the **per-subnet request limit of step 2, which applies to dev requests too** (C-137; over it →
   `429 rate_limited`, not counted in `drop/rate_limited`), and nothing else they count changes (no per-site rate,
   quota, multiplicity or counter state); the dev limit of §a.8 applies; step 3 runs in memory only to compute each
   event's would-be verdict (step 7's rules without `origin_mismatch` and `domain_unverified`); each event goes to
   the `dev` array of the next counter record (§d.3) — only when the snapshot advertises `dev` (§e.3) —, **never to
   the spool, Umami, a counter or the property rollup**; answer `202` with `X-Scf-Debug` (§a.8: `class=dev` only,
   unless debug mode is on). A token whose `prof` byte carries the dev bit (§b.1) is valid **only** on a dev batch;
   on any other batch it is `rejected/challenge_invalid` (C-137). Otherwise, if the site is `over_quota`, or this
   node's share of the tenant's daily verified-event quota is used up (`n ≥ daily_quota ÷ live edge nodes`) → `429
   quota_exceeded` (C-140).
2. Rate limits (C-90, C-140): first per site and truncated subnet, `min(web_requests_per_min_subnet, max(⌊share ÷
   4⌋, 10))` per node; then per site, this node's share = `rate_limit_per_min ÷ live edge nodes` (live = peers
   answering §n). A batch whose token this node verifies (§b.3, no rejection, not unverifiable) spends the site
   budget (`429 rate_limited`). Any other batch spends a separate per-site budget of the same size and, beyond it, is
   dropped (`202`, counted `drop/rate_limited`). Both limits apply to `POST /v1/e` and `POST /v1/c` (each route its
   own budgets; `/v1/c` applies the node's share of the site limit); tracker files, the manifest and `/healthz` are
   not rate limited per subnet (C-118).
3. Compute the surrogate **from the full IP and raw User-Agent** in memory (C-34, ADR-0007); truncate the IP; resolve
   country (DB-IP Lite) and ASN class; reduce the UA to family + major + OS + device class; apply `isbot` to the
   **raw** UA (C-36). The **network (ASN) class is looked up on the full address**, in memory, before truncation;
   only the country uses the truncated address (C-118). Compute the multiplicity keys (§b.4) from the full IP and the truncated subnet. Compare the
   UA's browser engine with the connection's **transport fingerprint** (below; reason `transport_mismatch`). Raw IP
   and UA are then discarded. Country: **DB-IP IP to Country Lite** (CC BY 4.0) read with
   `github.com/oschwald/maxminddb-golang/v2` (ISC), looked up with the address truncated to /24 (IPv4) or /48 (IPv6);
   one database for all lookups, never a per-lookup mix with another source (they disagree on 4–12 % of addresses;
   truncation changes the country for 0.10–0.27 %, S-12, C-106). No `iso_code` → `XX`. The database file is pinned by
   SHA-256 in the geo manifest and its `database_type` must be `DBIP-Country-Lite`.
4. If country ∈ site `exclude_countries` → drop, count `drop/country_excluded` (C-58).
5. If `visitor_id = off`, or `off_in` contains the country → replace the surrogate with a fresh random one (§c.3) and
   mark the event **unidentified**: it goes to the site's twin Umami website (C-73).
6. Multiplicity update and bucket (§b.4).
7. Verdict per §h. `rejected` → counters only. The daily quota was checked in step 1 (it counts verified events
   only, C-80, C-90; the counted-only events of §a.3.1 are not counted); a batch below the share is accepted whole
   (C-140). Count `wk` (if present), strip it; for
   a `wl` event map legacy to v1 (§a.3.1) and add its property rows to the counter record (§d.3 `props`, only when
   the snapshot advertises `props`, §e.3); unless it is a counted-only event (§a.3.1: `sign_*`, `tx_submitted`,
   `smart_wallet_created`, `passkey_used`), build the spool record (§d.2); fsync, `202` (with `X-Scf-Debug` when the
   site's debug mode is on).

**Transport fingerprint (C-124; reverses C-77(2) for a `suspect` signal).** Per connection, in memory only, for the
life of the connection (never logged, stored, spooled, forwarded or exported — only family labels reach metrics):

- **TLS:** a JA4 fingerprint (FoxIO layout: `t` ‖ version ‖ `d`/`i` ‖ cipher count ‖ extension count ‖ ALPN first+last
  character `_` SHA-256₁₂(sorted ciphers) `_` SHA-256₁₂(sorted extensions without SNI/ALPN `_` signature algorithms),
  GREASE removed) plus the features the classifier uses: GREASE present, the ALPS extension (`0x44cd` or the earlier
  `0x4469`), `record_size_limit` (`0x001c`), the offered ALPN list.
- **HTTP/2** (ALPN `h2` only): the first SETTINGS frame (ids and values in order), the connection WINDOW_UPDATE
  increment, PRIORITY frames before the first request, and the **pseudo-header order** of the first request
  (`m`=`:method`, `a`=`:authority`, `s`=`:scheme`, `p`=`:path`), read from the first HEADERS frame (static-table HPACK
  only; at most 16 KiB of the stream is inspected).

Classification (rule set `scf-transport/1`, versioned with the gateway; re-checked against current browser majors at
every gateway release): observed family = `chromium` (GREASE + ALPS), `apple` (GREASE, no ALPS), `gecko` (no GREASE,
`record_size_limit`), else `library` (a TLS library default: Go, OpenSSL — curl, Python, Node —, rustls, Java …).
Claimed family from the UA: Chrome, Edge, Opera, Samsung Internet → `chromium`; Firefox → `gecko`; Safari on macOS and
**every browser on iOS** → `apple`; Safari elsewhere (WebKitGTK/WPE) and unknown families → not checked.
**Mismatch** when a browser is claimed and (1) the observed family differs, or (2) the client did not offer `h2` first
in ALPN, or (3) on HTTP/2 the first request's pseudo-header order is not the claimed engine's (`chromium` `masp`,
`gecko` `mpas`, `apple` `mspa`/`msap`; an unreadable order is no signal). Measured with real clients
(`docs/evidence/bot/transport-fingerprints-*.json`): Go `net/http`, curl 8.14 (OpenSSL 3.5), Python `urllib`, Node 24
`fetch` (undici) and `node:http2` → `library`; Playwright Chromium → `chromium`/`masp`; Playwright Firefox 159 →
`gecko`/`mpas`. Never a rejection on its own; known limits in §h.2.

### a.7 Versioning

`v` is the protocol major version. The schemas are closed (`additionalProperties: false`), so a new optional field is
introduced in two steps: first every gateway is deployed accepting it, then a new tracker release may send it. Unknown
fields are never silently accepted. Breaking changes create `/v2/…` routes; every released tracker version stays
served and `v1` stays accepted for the life of the service (ADR-0004). The Stellar event vocabulary inside `v1` is
versioned separately by `sv` (§a.3.1); the optional `sv` field itself follows the same two steps (gateways first).

### a.8 Dev/preview origins and debug mode (C-136, amending ADR-0008)

**Dev origins** (`sites.dev_origins`, data-model §12.1; at most 10 per site; set by the tenant with `updateSite`).
Each entry is one of:
- `localhost` or `127.0.0.1` — matches that host on **any port, `http` or `https`**;
- an exact host (lower-case A-label, no port) — matches `https://<host>` on the default port;
- a preview-host pattern with one `*` in its **leftmost label** (`myapp-*.vercel.app`, `*-myteam.example.org`,
  `*.preview.example.org`) — `*` matches one or more characters of that label only (never a dot), `https` only. The
  control plane refuses a wildcard label with fewer than 3 literal characters around the `*` unless the rest is a
  host the tenant has verified, and refuses a bare `*.` directly above a public suffix of the Public Suffix List
  (private section included): `*.vercel.app`, `*.netlify.app` or `*.pages.dev` would admit every user of the host.

A request whose `Origin` (fallback: `Referer` host) matches a dev origin is a **`dev` request**. A declared domain
always wins: a host that is both a declared domain and a dev origin is treated as production. The `Origin` header is
chosen by the client, so a script can claim a dev origin at will (TM-INF-09); the rules below make that worth nothing
(C-137). Dev requests:
- get a challenge on `/v1/c` as a production origin would (so the tracker's full path runs locally), with the **same
  per-subnet limit and the same adaptive proof cost** (§b.2) as production, and with the **dev bit set in the token's
  `prof` byte** (§b.1): such a token is accepted only on dev batches and is `rejected/challenge_invalid` on any other
  batch, so tokens fetched "as localhost" can never be spent on counted events;
- are accepted (`202`) and are **never forwarded to Umami, never spooled, never counted** in any counter (verdict,
  reason, drop, tracker version, `wk`), the property rollup, any rollup, metric, snapshot or trust score, and never
  touch per-site rate, quota or multiplicity state; they **do** consume the per-subnet request limit of §a.6 step 2
  (in memory, uncounted), so a dev origin is no way around it;
- are limited per site and node to `dev_events_per_min_site` (setting, 120) events per minute; beyond it they are
  dropped silently (`X-Scf-Debug: … reasons=dev_rate_limited`);
- are reported in the counter record's `dev` array (§d.3), at most 20 per site and record, and land in
  `web_dev_events`, the newest 100 per site for 24 hours (data-model §12.1), which the first-event panel reads
  (`listSiteDevEvents`). Kept: kind, canonical event name (`pageview` for page views; custom names after the guard of
  §a.4), path normalised with `full` folding (§a.4), receipt time, would-be verdict and its worst reason. Never kept:
  any visitor identifier, surrogate, IP, User-Agent, referrer, country, property value or the origin host.

**Debug mode** (`sites.debug_until`, at most 24 hours ahead; `setSiteDebugMode`). While it is on, the site's `/v1/c`
and `/v1/e` answers carry CORS headers for any origin and the header below, so the tracker's debug mode can
explain why an event was not counted (wrong origin, GPC/DNT, bot, proof missing, quota). The cost is stated: during
the window anyone can read the site's reason codes, which helps a bot author tune against them; it is therefore
time-boxed, audited (`site.debug_mode_set`) and off by default.

**`X-Scf-Debug`** — on a dev request outside debug mode it is exactly `v=1; class=dev; reasons=dev_origin` (or
`…reasons=dev_origin,dev_rate_limited`) and says nothing about the would-be verdict, which the tenant reads only in
the authenticated first-event panel (`listSiteDevEvents`); **while debug mode is on** every request of the site, dev or
not, gets the full header below; never otherwise (C-137: a dev origin is no permanent, unaudited verdict oracle):

```
X-Scf-Debug: v=1; class=<class>; reasons=<code>[,<code>…]
class   = "verified" / "suspect" / "rejected" / "dropped" / "dev" / "challenge"
reasons = §h.2 reason codes, `drop` labels of data-model §8.9, or "dev_origin", "dev_rate_limited", "none"
```

In debug mode, for `/v1/e` the class and reasons are those of the batch's worst event (for `dev`: the would-be
verdict's reasons after `dev_origin`, e.g. `class=dev; reasons=dev_origin,proof_missing`); `dropped` covers GPC/DNT,
excluded countries, duplicates and profile-stripped fields (`reasons=gpc_dnt`). For `/v1/c`: `class=challenge;
reasons=none`, or `origin_mismatch` when the token's events will be rejected, or `dev_origin`. The header never
carries an identifier, a count, a threshold or another site's data. The tracker's debug mode reads the
header only when it is present and otherwise explains with what the browser itself knows (GPC, CSP, ad blocker,
origin).

**Would-be verdict outside debug mode (C-140).** Outside debug mode a dev
entry's would-be verdict and reason use only configuration and protocol checks (tenant, challenge, proof, token
flood, hidden/prerender); the bot-detection reasons `ua_bot`, `fetch_impossible`, `header_inconsistent`,
`transport_mismatch`, `automation_flag`, `net_datacenter`, `ctx_moved` are applied only while debug mode is on, so a
dev origin and the first-event panel are no detection oracle (a bot's dev entry can therefore read `verified`).

**As built (C-138; `services/gateway/internal/ingest/debug.go`, `server.go`).**
- *Which form on `/v1/c`*: while debug mode is on, the form of this section (`class=challenge; reasons=none`,
  `origin_mismatch` or `dev_origin`); outside it, the §a.5 form — `class=dev; reasons=dev_origin` on a dev request and
  no header otherwise.
- *Worst event of a batch*: `rejected` > `dropped` > `suspect` > `verified`; the header carries the first event of
  the highest class and that event's reasons (rejection reasons first). `dropped` also covers a `429` of the batch.
- *GPC/DNT on a dev batch*: `202`, nothing is kept (no `web_dev_events` row); in debug mode the header is
  `class=dev; reasons=dev_origin,gpc_dnt`.
- *"Never counted in any metric"* means the analytics figures (tenant, operator, public, snapshot, trust score). The
  gateway's own operational metrics (Prometheus, no site or tenant label) may count dev requests like any request.
- *Dev entry path*: the `full`-folded normalised path, cut at the first `?`, `#` or whitespace and at 200
  characters (the `dev` entry pattern of §d.3); `/` if nothing is left.

### a.9 App events — `POST /v1/app-events` (self-attested; migration 0084)

Native apps (React Native / Expo, Flutter, Swift, Kotlin) and Telegram Mini Apps send named events to the edge with the
site's **public** `site_key` (the `k` of the tracker tag; no new key kind). An app cannot run the browser proof of
work or the browser checks of §a.6, so **nothing on this path is verified**: every count is `self_attested`, kept in
`app_event_daily` only, and never enters the web verdict counters, the verified-event quota, Umami, visitor counts,
trust scoring, public metrics, traction snapshots or the Usage Map.

Request: `POST /v1/app-events`, `Content-Type: application/json` (or `text/plain`, so a WebView need not preflight),
body ≤ 8 KiB (as §a.1). CORS: `Access-Control-Allow-Origin: *`, never credentials; `OPTIONS` answers the preflight.

```json
{"v":1,"k":"<site_key, 22 chars>","platform":"ios|android|web","app_version":"1.4.2","sdk_version":"mobile-rn/0.1.0",
 "tma_platform":"android|ios|macos|desktop|web|other (optional; only with platform web)",
 "events":[{"ts":1794460740000,"session":"<16–64 of [A-Za-z0-9_-]>","name":"swap_started","props":{"tier":"pro"}}]}
```

Shape (any violation → `400 {"error":"malformed"}` for the whole batch; unknown fields included): `v` = 1; 1–20
events; `name` the custom-event name rule of §a.4 (`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`, ≤ 50); ≤ 8 props, keys
`^[a-z][a-z0-9_]{0,31}$`, **string values only**, 1–32 characters; `app_version` `^[0-9]{1,6}(\.[0-9]{1,6}){0,3}`
optionally followed by a `-…`/`+…` suffix that the edge removes (only the numeric core is counted); `sdk_version`
`^[a-z][a-z0-9-]{0,23}/[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$`. There is no field for a device id, install id,
advertising id, user id, wallet address or Telegram `initData`, and the edge never reads the User-Agent.

Per event (dropped events are counted, the rest of the batch is kept): property values must be enum tokens
(`^[a-z][a-z0-9_]{0,31}$`, not hex-like `^[0-9a-f_]{16,}$`) → else `value_shape`; the name and values pass the value
guard of §a.4 and contain no run of ≥ 6 digits → else `unsafe`; `ts` within [now − 24 h, now + 5 min] → else `stale`
(an accepted event counts on the UTC day of its `ts`); per site, UTC day and edge node at most 100 distinct names and
1,000 distinct (name, key, value) cells → else `cardinality`.

Order: content type (415) → size (413) → shape (400) → snapshot present / not draining (503 `unavailable`) → not
expired (503 `snapshot_expired`) → site by key (404 `unknown_site`) → tenant pending / suspended (403
`tenant_pending` / `tenant_suspended`) → site `over_quota` or this node's share of the tenant's **separate** daily
app-event budget (same size as `daily_quota`) (429 `quota_exceeded`, `Retry-After` to midnight) → per-(site, subnet)
and per-site request limits in their own windows, sized as the web limits (429 `rate_limited`, `Retry-After`) →
`202 {"accepted":n,"dropped":m}`. The peer address is used in memory for the subnet window only.

Sessions: the SDK keeps a random id in memory and replaces it at the latest after 30 minutes. The edge keeps only
HMAC-SHA-256(per-process random key, site ‖ day ‖ session) for 35 minutes, to count each session once per day and
node. A session spanning midnight counts on both days; one seen by two edge nodes counts on each (stated limit).

Cells (counter record `app`, §d.3; aggregated per node and minute like `props`; sent only when `counter_features`
lists `app`, else dropped in memory; the forwarder's strip-and-resend of §d.3 rule 3 also removes `app`):

| event | key | value |
|---|---|---|
| tenant name | `_total` | `all` (one per accepted event) |
| tenant name | prop key | prop value (one per property) |
| `_session` | `_total` / `app_version` / `sdk_version` / `tma_platform` | `all` / numeric version / `sdk/x.y.z` / class |
| `_dropped` | `reason` | `unsafe`, `value_shape`, `stale`, `cardinality` |

**Telegram Mini Apps.** A Mini App is a web page in Telegram's WebView; the web tracker already works there. A Mini
App that wants app-style counts sends `platform: "web"` and may add `tma_platform`, mapped from `WebApp.platform`:
`android`, `android_x` → `android`; `ios` → `ios`; `macos` → `macos`; `tdesktop`, `unigram` → `desktop`; `weba`,
`webk`, `web` → `web`; anything else → `other`. It never reads or sends `initData`, `initDataUnsafe` or the user
object; the body schema has no field that could carry them.

## b. Challenge token, proof-of-work and multiplicity

### b.1 Token layout (92 bytes → 123 `b64u` characters)

| Offset | Bytes | Field | Value |
|---|---|---|---|
| 0 | 1 | `ver` | `0x01` |
| 1 | 4 | `kep` | key epoch = `floor(unix_seconds / 3600)`, big-endian |
| 5 | 16 | `site_ref` | first 16 bytes of `SHA-256(site_key)` |
| 21 | 6 | `issued_ms` | issue time, Unix ms, big-endian uint48 |
| 27 | 16 | `nonce` | CSPRNG |
| 43 | 8 | `ctx` | first 8 bytes of `HMAC-SHA-256(K_chal[kep], "ctx1" ‖ net ‖ 0x00 ‖ ua_class)`; `net` = /24 (IPv4, 4 bytes, last byte 0) or /48 (IPv6, 16 bytes); `ua_class` = ASCII `family/major/os` |
| 51 | 2 | `cost` | PBKDF2 iterations per attempt (setting `pow_cost`) |
| 53 | 2 | `max` | counter space (`pow_max` × adaptive multiplier ∈ {1, 2, 4, 8}) |
| 55 | 4 | `pfx` | expected key prefix (§b.2) |
| 59 | 1 | `prof` | bit 0: `0` standard, `1` strict (site's configured profile at issue time); bit 1 (`0x02`, C-137): issued to a **dev** request (§a.8) — valid only on dev batches; other bits `0` (a token with another bit set is `challenge_invalid`) |
| 60 | 32 | `mac` | `HMAC-SHA-256(K_chal[kep], bytes 0 … 59)` |

`K_chal[e]`: 32 random bytes per UTC hour, generated and shared between gateway nodes exactly like `K_day` (§n), held
in locked memory, kept for the current and previous hour, then destroyed. It is never written to disk (C-68).

### b.2 Proof-of-work (ALTCHA-v2-style, deterministic)

- `password(c) = "scf-pow-v1" ‖ nonce ‖ uint32be(c)`; `salt = nonce`;
  `dk(c) = PBKDF2-HMAC-SHA-256(password(c), salt, iterations = cost, dkLen = 32)`.
- Issue: the gateway draws a secret `c*` uniformly in `[0, max)` and sets `pfx = dk(c*)[0..4]` (hex in the response).
- Solve (tracker, WebCrypto `deriveBits`, a few calls in flight, **no Web Worker**: `deriveBits` already runs
  off the main thread, C-100, C-110): try `c = 0, 1, …,
  max−1` until `dk(c)[0..4] = pfx`; send `c`. Deriving 32 or 4 bytes is equivalent for the solver. Expected work
  `cost × max / 2` iterations (≈ **2¹⁸** at the defaults `cost` 512 × `max` 1024). The tracker refuses to solve a
  challenge above its compiled ceiling (2²⁴ iterations).
- Defaults and timing (S-07, C-106): `pow_cost = 512`, `pow_max = 1024` stay. Emulated on 1/6 of a desktop core the
  default took a median of 288 ms (Chromium) / 314 ms (WebKit), p95 418 / 608 ms — within the 500 ms target (C-35)
  **in emulation only**; no real phone was measured, and S-07 timed a Worker-wrapped solver; in both cases the
  PBKDF2 work runs off the main thread inside WebCrypto, but the shipped build's timing on real devices stays open (risk
  R-24, C-110). `pow_cost` is never set below 256 (call overhead dominates below it).
- Verify (gateway, stateless): one PBKDF2 of `cost` iterations for the submitted `c`.
- Adaptive difficulty: the multiplier doubles (max 8×) for a `(site, net)` pair whose multiplicity bucket (§b.4) is
  `high`, datacenter/VPN/Tor class, events-per-token cap reached, or site event rate > 10× its 28-day p99; never
  because of `relay` or mobile class alone. Measured cost (S-07): 2× ≈ 0.5–0.6 s, 8× ≈ 1.6–2.3 s median on the slow
  emulated CPU, so `proof_missing` (page hidden before the proof) fires more often for such pairs; the published
  thresholds say so.
- Timing signal: `latency = receipt_time(first event with proof) − issued_ms` is bucketed into counter
  `pow_latency` (§d.3); nothing per event is stored. Emulated real solves span ~20 ms (desktop) to ~3 s (8× on a slow
  CPU), inside the buckets' 100 ms … 10 s resolution (S-07).

### b.3 Validation, binding, expiry, replay bounds

| Check | Failure → |
|---|---|
| `t` present and 123 b64u characters | absent or malformed → `rejected/challenge_missing`, the request still answered `202` (C-118) |
| `ver = 1`, length 92, `mac` valid under `K_chal[kep]` | bad MAC with a known epoch → `rejected/challenge_invalid`; epoch key unknown on this node (restart, partition) → `suspect/challenge_unverifiable`; **bad MAC under a key this node generated itself after the token's claimed `issued_ms`** (a single node restarted within the hour and re-created `K_chal` under the same epoch id, or another partition's key) → also `suspect/challenge_unverifiable` (C-124: the exact chaos check found every outstanding page's events `rejected` for up to 30 minutes after a single-node restart). Either case applies only when `Epoch(issued_ms) = kep` and `Epoch(now − 1800 s) ≤ kep ≤ Epoch(now + 60 s)`; otherwise the token is `rejected/challenge_invalid`, so a forged token cannot pick an unknown epoch (C-140) |
| `site_ref` = SHA-256(site key of the request)[0..16] | `rejected/challenge_invalid` |
| `prof` dev bit (C-137) set and the batch is not a dev batch (§a.8), or an unknown `prof` bit set | `rejected/challenge_invalid` |
| age: `now − issued_ms ≤ 1800 s` and `issued_ms ≤ now + 60 s` | `rejected/challenge_expired` |
| `ctx` recomputed from this request equals token `ctx` | `suspect/ctx_moved` (mobile users change networks: soft) |
| `c` present and `dk(c)` matches `pfx` | `c` absent → `suspect/proof_missing`; `c` wrong → `rejected/proof_invalid` |
| events per `nonce` on this node ≤ `web_events_per_token` (300) in 35 min | over → `rejected/token_flood` |

Replay bounds: a token is usable for 30 minutes, by any node, for at most 300 events per node; it cannot move between
sites (`site_ref`, `mac`) and moving between subnets/UA families is flagged. The per-nonce counter is in memory only
(LRU, 35-min TTL).

### b.4 Multiplicity counting (ADR-0008 L6, C-68, C-80b, C-89)

Per gateway node, **in memory only**, from `references/bot-detection-anti-inflation-2026-11-12.md` §3.7. Nothing
from it is written to disk or sent anywhere except the bucket label.

**Keys.** `K_mult` is a 32-byte random key per UTC day, generated and shared by the §n mechanism (kind `mult`), held
in locked memory and destroyed at rotation. Per event, from the full IP before it is discarded:

```
key_ip  = first 8 bytes of HMAC-SHA-256(K_mult, "mip1" ‖ site_id(16 bytes) ‖ ip(4 or 16 bytes))
key_net = first 8 bytes of HMAC-SHA-256(K_mult, "mnet1" ‖ site_id(16 bytes) ‖ net)   ; /24 IPv4, /48 IPv6 as in §b.1
```

**Unit of counting** = a **page load**: the first event of a challenge `nonce` seen on this node (the per-nonce LRU of
§b.3 tells first from later events). Later events of the same nonce only read the bucket.

**Cell** (one per key, both keys updated per page load):

```
struct Cell {
  loads           u32       # page loads in the window
  distinct        Sketch    # distinct surrogates (identified sites only)
  zero_activation u32       # page loads with sg.act = 0   (standard profile only)
  proofs_ok       u32       # page loads whose first event carried a valid proof
  auto_flags      u32       # page loads with sg.wd = 1 or sg.vis ∈ {h, p}   (standard profile only)
  window          two tumbling 5-minute halves → a 10-minute sliding window
}
Sketch = exact set of 8-byte surrogate digests up to 32 entries, then HyperLogLog p = 10
         (1,024 registers × 6 bits = 768 bytes); estimate m = |set| or HLL estimate
```

**Measure m per cell.** Sites with an identifier (`visitor_id = on`, or `off_in` outside the listed countries):
`m` = estimated **distinct surrogates** in the window, compared with `multiplicity_thresholds`. Sites or events
without an identifier (`visitor_id = off`, or unidentified under `off_in`, C-80b): the surrogate is random, so `m` =
**page loads** in the window, compared with `multiplicity_event_thresholds` — weaker, and stated as such.

**Bucket.** `T = thresholds[cell kind (exact_ip | subnet)][ASN class]`; `relay` (Apple Private Relay) is exempt
(bucket `one`). **`unknown` uses `max(T[unknown], T[eyeball_mobile])`** (C-124, F19): an address in none of the range
lists — without eyeball lists, nearly every visitor — may be a carrier-grade NAT, campus or corporate gateway shared
by hundreds of people, and the former `unknown` = `eyeball_fixed` thresholds (6 distinct visitors per address, 24 per
/24 in 10 minutes) marked such audiences suspect, because landing views typically carry no user activation
(`zero_activation / loads > 0.7` is met by real visitors). With the defaults `unknown` is now 40 per address / 160
per subnet (identified) and 400 / 1,600 page loads (unidentified); a class without its own threshold falls back to
that figure. The cost is stated: a bot farm behind one unclassified address may show up to 40 distinct surrogates per
10 minutes before the cell is `high`; PoW, the per-subnet rate limit, `transport_mismatch` and the daily trust score
still apply. `bucket = one if m ≤ 1; low if m ≤ T/2; mid if m ≤ T; high otherwise`. The event's bucket is the
higher of its two cells and is counted in `multiplicity/<bucket>`.

**Reason** `multiplicity_high` (suspect) iff bucket = `high` **and** low engagement in the cell that is `high`:
`proofs_ok / loads < 0.5`, or — standard profile only — `zero_activation / loads > 0.7` or `auto_flags / loads > 0.2`.
On `strict` sites only the proof condition applies (absence of client signals is never a reason, C-33).

**Mode (C-124).** `multiplicity_mode` = `enforce` | `shadow`, a platform setting (snapshot `settings.multiplicity_mode`,
default `enforce`) with a per-site override (`sites[].multiplicity_mode`, `null` = inherit; §e.3). `enforce` adds the
reason as above. `shadow` computes everything identically but **does not add the reason**: the event is counted in
`multiplicity/high_shadow` instead (and `multiplicity/<bucket>` as always), so the verdict is unchanged and the
installation check shows how many events *would* have been suspect. Operators publish the false-positive estimate
from shadow periods: `high_shadow` among events with no other suspect reason, per network class, against a manual
review of the flagged cells' sites. Absent or unknown values are `enforce`.

**Memory bounds.** At the design target (1 M page views/day, C-48) at most ~3 k new page loads per 10 minutes, so at
most ~6 k cells (two per load) of ≤ 800 bytes: **< 10 MB per node**. Hard cap **200,000 cells per node** (≈ 160 MB
worst case under attack), LRU-evicted; cells idle for 20 minutes are evicted. An evicted or missing cell yields bucket
`one` — it can never make an event `verified` that would otherwise be `suspect`. All cells are dropped at the daily
`K_mult` rotation.

**Multiple nodes.** Counting is per node (an attacker spreading over four nodes divides its apparent multiplicity by
up to four); the daily trust score (L7) sees the bucket counters of all nodes. Sharing `K_mult` keeps cell keys equal
across nodes so that gossip of HLL registers can be added later without a protocol change (not in this release).

## c. Gateway forwarder → engine proxy → Umami `POST /api/send`

### c.1 Transport and core selection (C-74, C-60)

The forwarder drains the spool to the **engine proxy** (`/services/engine-proxy`, Go) on a core node over HTTPS with
**per-node mutual TLS** (private CA). It picks the core by **rendezvous hashing of the surrogate**: for each configured
core `k`, `score(k) = first 8 bytes of SHA-256(core_id(k) ‖ surrogate as 16 bytes)` (big-endian); the healthy core
with the highest score receives the event. If it fails (connection error, timeout, `5xx`), the forwarder sends to the
next core in score order; a visit may split once at a failover (stated). An unidentified event's surrogate is
derived from its event id (§c.3), so every copy of one event reaches the same core (C-140). Every event of one identified visitor on any
edge node therefore reaches the same engine proxy, which holds that visitor's cache token (§c.5). At-least-once;
ambiguous retries counted. The same edge certificate also reaches `/internal/v1/edge/snapshot` and
`/internal/v1/edge/counters` through the engine proxy (§e, §l, CR-18). Spool delay does not change visits by itself:
`timestamp` is the receipt time, and Umami derives the day salt and the hour bucket from it (S-01). What a delayed
burst could do — merge events hours apart into one visit through a replayed cache token — is prevented by the engine
proxy's 30-minute rule on event timestamps (§c.5, C-99).

### c.2 Exact request (edge → engine proxy)

```http
POST /api/send HTTP/1.1
Host: engine.internal
Content-Type: application/json
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
x-scf-surrogate-ip: 2001:db8:5c1f:9a2e:77d0:13ab:e4c2:b9f
cf-ipcountry: DE
x-scf-visit: track

{"type":"event","payload":{
  "website":"5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41",
  "hostname":"app.example.org",
  "url":"/pricing",
  "referrer":"https://news.ycombinator.com/",
  "screen":"1536x864",
  "language":"en",
  "tag":"v",
  "timestamp":1794460800}}
```

| Payload field | Source | Rules |
|---|---|---|
| `website` | identified event → `sites.umami_website_id`; unidentified → `sites.umami_twin_website_id` (C-73), resolved from the snapshot at send time (§d.2) | always |
| `hostname` | validated `Origin` host | always; never from the client payload |
| `url` | normalised path (§a.4) | no query, no fragment |
| `referrer` | `"https://" + r + "/"` | omitted when no `r` |
| `screen` | width class → `s`: `390x844`, `m`: `820x1180`, `l`: `1536x864`, `x`: `2560x1440` | omitted when no `w` |
| `language` | `l` | omitted when absent |
| `name` | custom event `n`; wallet event: the **v1 name** (legacy events mapped, §a.3.1; C-136) | absent for pageviews; `tx_submitted` is never forwarded |
| `data` | custom `d`; wallet event fields under their rollup keys `{"wallet","network","connect_kind","sign_kind","error_class","duration","outcome","passkey_op"}` (present ones only; before C-136: `wallet_id`, `sign_kind`, `network`, `outcome`, `duration`, `error_class`) | after the guard |
| `tag` | verdict (§c.4) | always |
| `timestamp` | **time of receipt** at the gateway, Unix seconds (ADR-0005) | always |

| Header (edge → engine proxy) | Meaning |
|---|---|
| `x-scf-surrogate-ip` | surrogate (§c.3); passed on to Umami (`CLIENT_IP_HEADER`). **MUST be present on every event**: without it Umami derives the session from the User-Agent alone and every visitor with that UA collapses into one session (S-01) |
| `cf-ipcountry` | ISO 3166-1 alpha-2 or `XX`; passed on. **MUST be present and non-empty on every event** (C-99, C-104): our Umami image ships no geo database, and an event with a public-looking surrogate and no country header is answered `500` (which the forwarder would retry for 72 h). `XX` is stored literally. Country is fixed per session by its first event |
| `x-scf-visit` | `track` for identified events (the proxy keeps and replays the cache token), `none` for unidentified ones (no cache state); removed by the proxy |
| `x-scf-event-key` | 32 lower-case hex = SHA-256("scf-evk1" ‖ site_id (16 bytes) ‖ event id)[0..16]; absent on records written before C-140; removed by the proxy (§c.5 step 1a) |
| `User-Agent` | synthetic template (§c.3); passed on |

**Never sent**: `ip` (a `payload.ip` replaces the surrogate in the session hash **and** switches the country to a geo
lookup of that address, S-01, C-99), `userAgent`, `browser`, `os`, `device`, `id`, `salt`, `link`, `pixel`, `title`,
web-vital fields;
`type` other than `"event"` (no `identify`, `performance`, `error`); the client's `timestamp`, `hostname` or event id;
the `wk` field; headers `x-umami-cache` (only the engine proxy sets it), `x-forwarded-for`, `forwarded`, `x-real-ip`,
`true-client-ip`, `cf-connecting-ip`, any other `cf-*`, `x-vercel-ip-*`, `cloudfront-viewer-*`, `eo-*`,
`x-umami-client-*`, `cookie`, `authorization`. Region and city are never sent.

### c.3 Surrogate and synthetic User-Agent

- Identified: `2001:0db8:` + 96 bits of `HMAC-SHA-256(K_day, site_id ‖ ip ‖ user_agent)` (ADR-0007, C-34), written in
  RFC 5952 form.
- Unidentified (C-02, C-73): `2001:db8:` + SHA-256("scf-unid1" ‖ site_id ‖ event id)[0..12] — random per event,
  identical for every copy of one event (C-140) — sent to the **twin** website with `x-scf-visit: none`.
- `cf-ipcountry`: ISO 3166-1 alpha-2 from the truncated address, or `XX` when unknown.
- `User-Agent`: a synthetic string from a fixed template table keyed by (browser family, OS family, device class)
  with the observed major version substituted, e.g. Chrome/Windows/desktop as above; Safari/iOS/mobile
  `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0
  Mobile/15E148 Safari/604.1`; unknown → `Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/0.0`. The table lives
  in the gateway; a contract test asserts that Umami parses every template to the intended browser/OS/device and that
  its `isbot` returns false for all of them. Umami's own bot check stays on as a backstop (C-36, design trade-off DV-08).
  Parses observed on Umami 3.5.0 (S-01; the contract test pins exactly these): Chrome/Windows → `chrome` / `Windows
  10` / `laptop`; Safari/iPhone → browser **`ios`** / `iOS` / `mobile`; Safari/macOS → `safari` / `Mac OS`; Firefox/
  Windows → `firefox` / `Windows 10`; Chrome/Android → `chrome` / `Android OS` / `mobile`; Edge → `edge-chromium`; the
  "unknown" template → **`firefox` / `Linux`** / `laptop` (so "unknown" browsers are reported as Firefox on Linux; the
  metric definitions say so). A bare `Mozilla/5.0` or `Mozilla/5.0 (Unknown)` is a bot for `isbot` and can never be a
  template.

### c.4 Verdict → tag and website (C-73)

Tags are **`v` and `s` only**; whether an event has a visitor identifier is expressed by the website it goes to.

| Verdict | Identified → main website | Unidentified → twin website |
|---|---|---|
| `verified` | `v` | `v` |
| `suspect` | `s` | `s` |
| `rejected` | never forwarded | never forwarded |

### c.5 Engine proxy contract (C-74, C-60)

The engine proxy runs on each core node in front of Umami, the control plane's internal edge endpoints and nothing
else. It **accepts** only per-node mTLS connections from the private CA and applies the path allow-list of the
caller's certificate (C-60).

**Certificate identity (C-113).** Every node certificate of the private CA carries **exactly one OU, naming its role**
— `edge`, `reader` or `provisioner` — and its **CN is the node name** (`^[a-z0-9][a-z0-9-]{1,31}$`, the `node_id` of §d; C-114). A
certificate with no OU, several OUs or an unknown OU is refused (`403`). The role selects the allow-list; the CN is the
caller's identity in the proxy's logs and, for edges, is passed on: on the internal edge calls (`/internal/v1/edge/*`)
the proxy **drops any incoming `X-Scf-Edge-Node` header and sets `X-Scf-Edge-Node: <CN>`**, which is how the control
plane learns which node is calling. The proxy → control-plane hop is **mutual TLS** (C-114): the control plane's
internal listener refuses plain HTTP on any non-loopback address and trusts `X-Scf-Edge-Node` only from a client
certificate whose CN is in `SCF_INTERNAL_ALLOWED_CLIENTS` (the engine proxies, OU `engine-proxy`); in Compose the two
share a dedicated network (§l). A **reload** of the proxy's certificates or CRL rotates its session-ticket keys and
closes existing connections (idle at once, busy after their request), and revocation is checked for resumed sessions
too (C-114).

| Caller certificate (OU) | Allowed |
|---|---|
| `edge` (edge nodes, CN `edge-*`) | `POST /api/send` (→ Umami); `GET /internal/v1/edge/snapshot`, `POST /internal/v1/edge/counters` (→ local control plane, with `X-Scf-Edge-Node`) |
| `reader` (control plane, jobs) | the Umami read calls of §j.3 and `GET /api/heartbeat`, with exactly the listed parameters |
| `provisioner` (provisioning worker, `umami_reconcile`) | the calls of §j.2 including the P13 lookups, the bootstrap calls B1–B5 of §j.2, and `DELETE /internal/v1/visit-tokens/websites/{websiteId}` (below) |
| anything else | `403` |

**Bootstrap gate (C-112(7)).** After every start, the engine proxy refuses **every caller except the provisioning
worker** (`503` with `Retry-After`) until it has forwarded the worker's B5 check (§j.2: `POST /api/auth/login` with the
seed admin's original credentials) and Umami answered it `401` — i.e. the seed admin is gone or its password changed.
Only then does it open the other allow-lists. The worker runs B5 at its own start and whenever the proxy answers it
`503`. **The proxy also runs its own B5 probe** directly against Umami (C-113) — at start, then every 2 s while the
gate is closed and every 60 s while it is open — so a restarted proxy re-opens without waiting for the worker. The
probe **opens** the gate only when the seed credentials are refused **and** the provisioning identity
(`EP_PROVISIONER_USER`, password from `EP_PROVISIONER_PASSWORD_FILE`) signs in (C-114); without those credentials it
can only close the gate. Metrics `scf_engine_proxy_bootstrap_probe_last_status` and
`scf_engine_proxy_bootstrap_probe_provisioner_last_status`. Any
B5 answer of `200` (the seed credentials work again, e.g. after a restore of an unbootstrapped database) **closes the
gate again**; other answers change nothing. Probe counts and the last probe status are exported metrics.

**Never forwarded, whatever the caller — the one Umami deny-list** (C-104, C-112(11); every other document refers to
this list; checked before the allow-lists; `403`): `POST /api/batch`, `POST /api/record`, `/api/websites/*/recorder`,
`/api/websites/*/export`, `/api/websites/*/reset`, `/api/websites/*/shares`, `/q/*`, `/p/*`, `/mcp`, `/share/*`,
`/api/share*`, `POST /api/teams/join`, `/script.js`, `/recorder.js`, `/telemetry.js`, `/api/scripts/*`,
`/openapi.json`, `/_next/image`, `/login`, `/api/2fa/*`, report and compat routes; `/api/auth/*` and
`/api/me/password` except for the provisioning identity (`/api/auth/login`, and `/api/me/password` during bootstrap).
Health: `GET /api/heartbeat`.

**Visit rule (C-99).** Measured on Umami 3.5.0 (S-01 §3): a replayed cache token whose request carries `timestamp`
keeps the token's visit **for ever** (10:55 → 23:59 became one visit); without a token Umami's visit is (session, UTC
clock hour of `timestamp`). Umami therefore has no inactivity rule on our path, and **the engine proxy is the 30-minute
inactivity rule**. For `POST /api/send` from an edge it:
1. removes any incoming `x-umami-cache` and the `x-scf-visit` header and validates the request (C-113); it answers
   `400` (never forwarded; the forwarder discards it as `engine_rejected`, §c.6) when the body exceeds **16 KiB**, is
   not one JSON object `{"type","payload"}` with `type` = `"event"`, carries a payload field outside the §c.2 list
   (`website`, `hostname`, `url`, `referrer`, `screen`, `language`, `name`, `data`, `tag`, `timestamp` — so
   `payload.ip` and `payload.userAgent` are refused), has a `website` that is not a UUID, a `tag` other than `v`/`s`
   or a `timestamp` Umami would not accept (§j.4); when `x-scf-surrogate-ip` is **not an IPv6 address inside
   `2001:db8::/32`** (so no real address can reach Umami); when `cf-ipcountry` is present but not two upper-case letters;
   when the `User-Agent` is empty or longer than 512 bytes; or when `x-scf-visit` is neither `track` nor `none`. A
   **missing** `cf-ipcountry` becomes `XX` at the proxy (Umami answers `500` without it, C-99) — a safety net only:
   the gateway still MUST send it (§c.2);
1a. with `x-scf-event-key` (else `400 bad_event_key` if malformed): a key Umami already accepted within
   `EP_DEDUP_WINDOW` (1 h, at most 500,000 keys, memory only) is answered `200` with the first answer (`{}` or
   `{"beep":"boop"}`) and not forwarded; a concurrent copy waits; a failed first attempt releases the key. Copies
   across a core failover or a proxy restart are not recognised (C-140; metrics
   `scf_engine_proxy_send_duplicates_total`, `scf_engine_proxy_event_keys`, `scf_engine_proxy_event_key_evictions_total`);
2. if `x-scf-visit: track`, looks up `(payload.website, x-scf-surrogate-ip)` in its map; an entry is
   `{token, last_event_ts}`. It adds `x-umami-cache: <token>` **only if** `|payload.timestamp − last_event_ts| ≤ 1800`
   seconds; otherwise it sends no token (Umami starts a new visit);
3. forwards to Umami. On `200` with a JSON body containing `cache`, it stores the `cache` Umami returned and sets
   `last_event_ts := max(previous last_event_ts, payload.timestamp)` (`payload.timestamp` alone when there was no
   entry) (C-112(9)) — **except** when the event is more than 1,800 s **older** than the stored `last_event_ts`: then
   the entry is left unchanged, so a backlog event cannot take over the visit in progress (C-113, refining
   C-112(9)). It then returns Umami's status and body to the edge **with `cache`, `sessionId` and `visitId`
   removed** (they are pseudonymous identifiers; a stored event returns `{}`, Umami's bot answer `{"beep":"boop"}`
   unchanged, so §c.6 still works).

**Website deletion.** A valid token lets events into a website that has been deleted (S-01 case H: `200`, event stored
for the deleted website). Therefore, **before P9** the provisioning worker calls `DELETE
/internal/v1/visit-tokens/websites/{websiteId}` on **every** core's engine proxy (`204`; C-112(9)); each proxy drops
every entry of that website and remembers the id for 72 hours (memory only). Only when every core has answered `204`
does the worker send P9 (it retries otherwise); the proxy that forwards P9 also drops entries again. For a remembered id
the proxy never adds a token, so after P9 Umami answers `400 Website not found` and the forwarder discards the record
(`engine_rejected`, §c.6).

**State: memory only** — a map of at most **500,000 entries per core** (LRU; evictions counted), keyed by
(website id, surrogate), value = `{token, last_event_ts}`, with a 30-minute wall-clock idle TTL; the LRU and the TTL
are memory bounds only — the visit rule is the event-timestamp test above. It is never written to disk or logs, never
returned to an edge or a browser, emptied at 00:00 UTC (surrogates change daily anyway, ADR-0007) and lost on restart,
after which visits in progress split once (Umami's clock-hour rule applies to their next event). A visit interleaved
with a long out-of-order backlog can also split once (`|Δ|` test; accepted, measured in the e2e soak). Exported
metrics: map size, hits, replays refused by the 30-minute test, misses, evictions, purges — no keys.

### c.6 Responses and acknowledgement (forwarder)

A record is acknowledged (marked in the spool's ack bitmap, §d.1) on a final answer:
- `200` with any body other than `{"beep":"boop"}` → `acked_stored`;
- `200 {"beep":"boop"}` (Umami's bot check; the event was silently dropped) → `acked_engine_bot`, counted
  `drop/engine_bot_drop` (C-69);
- `400` → record discarded, `acked_engine_rejected`, counted `drop/engine_rejected`, alert.

`5xx`, timeout or connection error on every core → keep in the spool, retry with backoff (1 s → 60 s); records older
than 72 h are discarded and counted (`expired_72h`, `drop/undeliverable_72h`, C-18).

## d. Gateway spool records

### d.1 Segment format

Append-only segment files `spool/<node_id>/<segment:016d>.seg` (sealed at 16 MiB or 60 s), on the node's local disk
only — **there are no copies in object storage** (C-77; an accepted record on a node that is lost before forwarding
is lost, and that exposure — normally seconds of backlog — is stated in the SLA). Each record:

```
uint32 LE  length of payload
uint32 LE  CRC-32C of payload
payload    UTF-8 JSON (one SpoolRecord)
```

`202` is sent after the group commit containing the record is fsync'd. Acknowledgements are kept in
`<segment>.ack` (bitmap of acknowledged record indexes); a segment is deleted when fully acknowledged or when its last
unacknowledged record expires (72 h). Nothing in a record identifies a person directly: **no raw IP, no raw
User-Agent, no query string, no event id (only its digest `event_key`), no token, no nonce, no client-signal raw
values, no title.**

**Recovery (C-140).** At start the spool re-reads every segment (per frame: length, CRC, JSON, and `site_id` for the
per-site spool share). A damaged frame is skipped — it keeps its index as a placeholder, or recovery resyncs to the
next valid frame and rewrites the ack file — and is counted (`scf_gateway_spool_corrupt_frames`,
`scf_gateway_spool_corrupt_bytes`); only a torn tail of the newest segment is truncated, so one corrupt frame never
truncates acknowledged or later records. A failed ack fsync is rolled back and returned per request.

### d.2 Event record

Every event record carries its **position** (`node_id`, `segment`, `offset` = byte offset of its frame in the
segment), so accounting and investigations can name each record (C-76).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/spool/event-record-1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["rv", "type", "record_id", "node_id", "segment", "offset", "received_at_ms", "tenant_id", "site_id",
               "target", "umami_website_id", "tag", "surrogate", "country", "ua", "hostname", "url", "kind"],
  "properties": {
    "rv":               { "const": 1 },
    "type":             { "const": "event" },
    "record_id":        { "type": "string", "format": "uuid", "description": "UUIDv7 generated by the gateway" },
    "node_id":          { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,31}$" },
    "segment":          { "type": "integer", "minimum": 0, "description": "segment sequence number (file name)" },
    "offset":           { "type": "integer", "minimum": 0, "description": "byte offset of this record's frame in the segment" },
    "received_at_ms":   { "type": "integer" },
    "tenant_id":        { "type": "string", "format": "uuid" },
    "site_id":          { "type": "string", "format": "uuid" },
    "target":           { "enum": ["main", "twin"], "description": "identified → main website; unidentified → twin (C-73)" },
    "umami_website_id": { "type": ["string", "null"], "format": "uuid",
                          "description": "null only for target = twin while the twin is not yet in the snapshot; the forwarder resolves it at send time and keeps the record until it can" },
    "tag":              { "enum": ["v", "s"] },
    "surrogate":        { "type": "string", "pattern": "^2001:db8:", "description": "IPv6 text form (§c.3)" },
    "country":          { "type": "string", "pattern": "^([A-Z]{2}|XX)$" },
    "ua":               { "type": "string", "maxLength": 200, "description": "synthetic template UA (§c.3)" },
    "hostname":         { "type": "string", "maxLength": 253 },
    "url":              { "type": "string", "maxLength": 500, "pattern": "^/[^?#]*$" },
    "referrer_host":    { "type": "string", "maxLength": 253 },
    "screen":           { "enum": ["390x844", "820x1180", "1536x864", "2560x1440"] },
    "language":         { "type": "string", "pattern": "^[a-z]{2,3}$" },
    "kind":             { "enum": ["pageview", "custom", "wallet"] },
    "name":             { "type": "string", "maxLength": 50 },
    "data":             { "type": "object", "maxProperties": 10 },
    "event_key":        { "type": "string", "pattern": "^[0-9a-f]{32}$", "description": "optional; §c.2 x-scf-event-key (C-140)" }
  }
}
```

Example:

```json
{"rv":1,"type":"event","record_id":"0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12","node_id":"edge-a1","segment":4711,"offset":81920,
 "received_at_ms":1794460800123,"tenant_id":"0193b7e2-0000-7000-8000-00000000000a","site_id":"0193b7e2-0000-7000-8000-0000000000a1",
 "target":"twin","umami_website_id":null,"tag":"v","surrogate":"2001:db8:9f1e:2a77:d013:abe4:c2b9:f001","country":"DE",
 "ua":"Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/0.0","hostname":"app.example.org","url":"/pricing","kind":"pageview"}
```

### d.3 Counter record (C-39, C-76)

Verdict and reason counters (and the other edge counters) travel through the spool, aggregated per node per minute,
and are delivered by the forwarder to the control plane (§l). The `day` of a web counter is the UTC day of receipt.
The labels per counter are the closed lists of data-model §8.9. `tracker_version` (C-129, migration `0062`) counts every
event that is not rejected (verdict `verified` or `suspect`) under the label `v<major>_<minor>_<patch>` of the
payload's `tv` (dots are not allowed in labels); the control plane's installation check reports the label with the
most events in its range as `tracker_version_seen`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/spool/counter-record-1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["rv", "type", "record_id", "node_id", "period_start_ms", "period_end_ms", "web", "otlp", "tokens", "spool"],
  "properties": {
    "rv": { "const": 1 }, "type": { "const": "counter" },
    "record_id": { "type": "string", "format": "uuid" },
    "node_id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,31}$" },
    "period_start_ms": { "type": "integer" }, "period_end_ms": { "type": "integer" },
    "web": {
      "type": "array", "maxItems": 100000,
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["tenant_id", "site_id", "day", "counter", "label", "count"],
        "properties": {
          "tenant_id": { "type": "string", "format": "uuid" }, "site_id": { "type": "string", "format": "uuid" },
          "day": { "type": "string", "format": "date" },
          "counter": { "enum": ["verdict", "reason", "asn_class", "client_signal", "pow_latency", "multiplicity",
                                "identifier", "kit_present_pageviews", "drop", "tracker_version"] },
          "label": { "type": "string", "pattern": "^[a-z0-9_]{1,40}$" },
          "count": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "otlp": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["tenant_id", "day", "reason", "count"],
        "properties": {
          "tenant_id": { "type": "string", "format": "uuid" }, "day": { "type": "string", "format": "date" },
          "reason": { "enum": ["rate_limited", "payload_too_large", "logs_rejected", "tenant_pending", "tenant_suspended", "token_expired"] },
          "count": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "tokens": {
      "type": "array",
      "description": "tenant_id from the snapshot's ingest_tokens entry (C-113), so the control plane applies each entry in that tenant's transaction",
      "items": { "type": "object", "additionalProperties": false, "required": ["token_id", "tenant_id", "last_used_ms"],
                 "properties": { "token_id": { "type": "string", "pattern": "^[0-9A-Za-z]{12}$" },
                                 "tenant_id": { "type": "string", "format": "uuid" }, "last_used_ms": { "type": "integer" } } }
    },
    "spool": { "$ref": "#/$defs/spoolAccounting" },
    "props": {
      "type": "array", "maxItems": 100000,
      "description": "C-136: Stellar event schema v1 property counts of accepted (verified/suspect) wl events, §a.3.1 → web_event_property_daily; optional",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["tenant_id", "site_id", "day", "event", "network", "key", "value", "verdict", "count"],
        "properties": {
          "tenant_id": { "type": "string", "format": "uuid" }, "site_id": { "type": "string", "format": "uuid" },
          "day": { "type": "string", "format": "date" },
          "event": { "enum": ["wallet_modal_opened", "wallet_modal_closed", "wallet_selected", "wallet_connect", "wallet_disconnect",
                              "sign_requested", "sign_approved", "sign_rejected", "tx_submitted", "smart_wallet_created", "passkey_used",
                              "wallet_connect_failed", "walletconnect_session", "walletconnect_request"] },
          "network": { "enum": ["mainnet", "testnet", "futurenet", "local", "unknown"] },
          "key": { "enum": ["_total", "wallet", "connect_kind", "sign_kind", "error_class", "result_class", "duration", "outcome", "passkey_op",
                            "failure_reason", "wallet_context", "wc_state", "wc_method"] },
          "value": { "type": "string", "pattern": "^[a-z0-9_]{1,32}$", "description": "closed list per key (§a.3.1); `all` for _total" },
          "verdict": { "enum": ["verified", "suspect"] },
          "count": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "dev": {
      "type": "array", "maxItems": 20000,
      "description": "C-136: events of dev requests (§a.8), at most 20 per site per record → web_dev_events; optional",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["tenant_id", "site_id", "received_at_ms", "kind", "name", "path", "would_be"],
        "properties": {
          "tenant_id": { "type": "string", "format": "uuid" }, "site_id": { "type": "string", "format": "uuid" },
          "received_at_ms": { "type": "integer" },
          "kind": { "enum": ["pageview", "custom", "stellar"] },
          "name": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$", "description": "`pageview`, the custom name after the guard, or the v1 Stellar name" },
          "path": { "type": "string", "maxLength": 200, "pattern": "^/[^?#\\s]*$", "description": "normalised with full folding" },
          "would_be": { "enum": ["verified", "suspect", "rejected"] },
          "reason": { "type": ["string", "null"], "pattern": "^[a-z0-9_]{1,40}$", "description": "worst reason of the would-be verdict" }
        }
      }
    },
    "rpc": {
      "type": "array", "maxItems": 100000,
      "description": "tracker 1.2.0: browser Stellar RPC/Horizon aggregate cells of accepted stellar_rpc events (§a.3.2) → web_rpc_client_daily; optional, sent only when counter_features has \"rpc\"",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["tenant_id", "site_id", "day", "api", "operation", "network", "outcome", "latency", "verdict", "count"],
        "properties": {
          "tenant_id": { "type": "string", "format": "uuid" }, "site_id": { "type": "string", "format": "uuid" },
          "day": { "type": "string", "format": "date" },
          "api": { "enum": ["rpc", "horizon"] },
          "operation": { "type": "string", "pattern": "^[a-z0-9_]{1,40}$", "description": "closed list per api (§a.3.2)" },
          "network": { "enum": ["mainnet", "testnet", "futurenet", "local", "unknown"] },
          "outcome": { "enum": ["ok", "rpc_error", "http_4xx", "http_429", "http_5xx", "timeout", "network_error"] },
          "latency": { "enum": ["lt100ms", "100_500ms", "500_2000ms", "gt2000ms"] },
          "verdict": { "enum": ["verified", "suspect"] },
          "count": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "app": {
      "type": "array", "maxItems": 100000,
      "description": "§a.9: self-attested app-event cells → app_event_daily (migration 0084); optional, gated by counter_features \"app\"",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["tenant_id", "site_id", "day", "platform", "event", "key", "value", "count"],
        "properties": {
          "tenant_id": { "type": "string", "format": "uuid" }, "site_id": { "type": "string", "format": "uuid" },
          "day": { "type": "string", "format": "date" },
          "platform": { "enum": ["ios", "android", "web"] },
          "event": { "type": "string", "pattern": "^(_session|_dropped|[A-Za-z0-9][A-Za-z0-9_.:-]{0,49})$" },
          "key": { "type": "string", "pattern": "^(_total|[a-z][a-z0-9_]{0,31})$" },
          "value": { "type": "string", "minLength": 1, "maxLength": 64, "description": "per-cell rule of §a.9 (checked by the core and the table)" },
          "count": { "type": "integer", "minimum": 1 }
        }
      }
    }
  },
  "$defs": {
    "spoolAccounting": {
      "type": "object", "additionalProperties": false,
      "description": "event-record accounting for this period (§d.4); counter records themselves are not counted",
      "required": ["boot_id", "day", "fsynced", "acked_stored", "acked_engine_bot", "acked_engine_rejected", "expired_72h", "queued"],
      "properties": {
        "boot_id": { "type": "string", "format": "uuid", "description": "random per gateway start" },
        "day": { "type": "string", "format": "date", "description": "UTC day of period_end" },
        "fsynced": { "type": "integer", "minimum": 0 },
        "acked_stored": { "type": "integer", "minimum": 0 },
        "acked_engine_bot": { "type": "integer", "minimum": 0 },
        "acked_engine_rejected": { "type": "integer", "minimum": 0 },
        "expired_72h": { "type": "integer", "minimum": 0 },
        "queued": { "type": "integer", "minimum": 0, "description": "event records not yet acknowledged at period_end (gauge)" },
        "queued_at_day_start": { "type": "integer", "minimum": 0, "description": "in the first record of each UTC day of each boot (a restarted node sends it again); the control plane keeps the first value it received for the node and day (C-118)" }
      }
    }
  }
}
```

Example:

```json
{"rv":1,"type":"counter","record_id":"0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e13","node_id":"edge-a1",
 "period_start_ms":1794460740000,"period_end_ms":1794460800000,
 "web":[{"tenant_id":"0193b7e2-0000-7000-8000-00000000000a","site_id":"0193b7e2-0000-7000-8000-0000000000a1","day":"2026-11-12","counter":"verdict","label":"verified","count":412},
        {"tenant_id":"0193b7e2-0000-7000-8000-00000000000a","site_id":"0193b7e2-0000-7000-8000-0000000000a1","day":"2026-11-12","counter":"kit_present_pageviews","label":"all","count":37}],
 "otlp":[],"tokens":[],
 "spool":{"boot_id":"0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e14","day":"2026-11-12","fsynced":431,"acked_stored":428,"acked_engine_bot":1,"acked_engine_rejected":0,"expired_72h":0,"queued":7}}
```

Labels are the closed lists of data-model §8.9 and §h. Counters are lost if a node dies before the minute's record is
fsync'd (≤ 60 s of counters; stated; the accounting check of §d.4 shows such a gap as `unaccounted`). `props` and
`dev` (C-136) are optional and a record without them is valid. `props` rows aggregate per node and minute like `web`
rows.

**Upgrade and rollback rule for `props` and `dev` (C-137).** The control plane validates counter
records against a closed schema, and the forwarder discards a record answered `400`/`422` (§l), so a part the core does
not know would cost the whole record — verdict counters, quota input, spool accounting — for every tenant. Therefore:
1. The gateway sends `props` and `dev` **only when the current edge snapshot advertises them** in
   `settings.counter_features` (§e.3) and **omits each when it is empty**; a node whose snapshot does not advertise a
   part drops those entries in memory (the events themselves are unaffected: counted-only events and dev events were
   never forwarded).
2. `settings.counter_features` is the platform setting `edge_counter_features` (data-model §12.1, default `[]`), which
   an `operator_admin` sets to `["props","dev"]` **after every control plane runs a release that accepts them**
   (the upgrade runbook's last step; `make up` and the smoke stack set it at start). Before rolling a control plane
   back to a release older than C-136, the setting is set to `[]` and every node is given 60 s to apply the snapshot.
3. Safety net: when the control plane answers `400`/`422` to a record that carries `props` or `dev`, the forwarder
   re-sends it **once without them** (same `record_id`, so the per-part idempotency of §l still holds) and only then
   applies the discard rule; the dropped parts are logged with their entry counts.
4. Tested by an upgrade test: the new gateway against the previous control-plane image with the setting `[]` and with
   it wrongly set, asserting that no counter record is discarded.

### d.4 Spool accounting and the durability check (C-76)

Each node counts **event records** only:

| Counter | Incremented when |
|---|---|
| `fsynced` | a record's group commit is fsync'd and `202` is answered |
| `acked_stored`, `acked_engine_bot`, `acked_engine_rejected` | the forwarder receives the final answer of §c.6 |
| `expired_72h` | a record is discarded under the 72-hour rule |
| `queued` (gauge) | records fsync'd and neither acknowledged nor expired, recomputed from the segment files on start |

Invariant per node and UTC day: `queued_at_day_start + Σ fsynced = Σ (acked_stored + acked_engine_bot +
acked_engine_rejected + expired_72h) + queued at end of day`. The control plane adds each record's deltas into
`edge_spool_accounting` (data-model §8.13); a new `boot_id` within a day increments `restarts`. Job
`durability_reconcile` (daily, for D-1) writes one `durability_reports` row per node: `balanced` when the invariant
holds, `loss` when acknowledged + expired + queued falls short and no restart explains it, `unaccounted` when a
restart left an unreported window (the gap is published as such), `pending` while counter records are still arriving.
It also writes one row per canary probe source (§o): expected = canary events the probes saw accepted, observed =
canary events Umami holds. A shortfall is a loss unless the 72-hour counters explain it.

## e. Control plane → edge signed snapshot

### e.1 Transport

`GET https://<core>/internal/v1/edge/snapshot` through the core's engine proxy (§c.5) with the per-node mTLS
certificate (C-60), every **30 s** ± 5 s jitter, `If-None-Match: "<sequence>"` → `304` or `200` with the envelope.
Either core answers (C-07). The job `edge_snapshot` rebuilds within 10 s of any change (`NOTIFY scf_edge`) and every
10 s; it runs **in the jobs service** (superseding C-113 on this point), connected as `scf_jobs`
with `app.job = 'edge_snapshot'`, because only the jobs service holds the signing key (§e.2): the internet-facing
control plane only serves the stored envelopes from `scf.edge_snapshots`. The control plane identifies the
calling node by the `X-Scf-Edge-Node` header the engine proxy sets from the certificate's CN (§c.5), so tenant suspension, removal, token revocation, site changes and `over_quota` reach every live node within
**60 s** (C-06, C-90).

### e.2 Envelope and signature

```json
{
  "format": "scf-edge-snapshot/1",
  "alg": "Ed25519",
  "kid": "edge-2026-11",
  "payload": "<b64u of the UTF-8 JSON payload bytes>",
  "sig": "<b64u of Ed25519(signing_key[kid], payload bytes)>"
}
```

The signing key is separate from every pepper (C-05) and held by the jobs service only (F16); gateways pin up to two
public keys (`kid` → key) in their configuration for rotation. Verification order: parse envelope → known `kid` →
signature over the **exact decoded payload bytes** → parse payload → `format` matches → **`sequence` > current
sequence** (anti-rollback, C-62; equal = no-op, smaller = reject and alert) → apply atomically → write envelope to
`/var/lib/scf-gateway/snapshot.json` (fsync, rename). Envelope ≤ 32 MiB.

### e.3 Payload

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/edge-snapshot-1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["sequence", "issued_at", "settings", "tenants", "sites", "ingest_tokens", "tracker_versions"],
  "properties": {
    "sequence":  { "type": "integer", "minimum": 1 },
    "issued_at": { "type": "string", "format": "date-time" },
    "expires_at": { "type": "string", "format": "date-time" },
    "settings": {
      "type": "object", "additionalProperties": false,
      "required": ["pow_cost", "pow_max", "pow_max_multiplier", "web_events_per_token", "multiplicity_thresholds",
                   "multiplicity_event_thresholds", "web_requests_per_min_subnet",
                   "otlp_requests_per_s", "otlp_burst", "otlp_bytes_per_s", "pathnorm_rules_version",
                   "multiplicity_mode"],
      "properties": {
        "pow_cost": { "type": "integer" }, "pow_max": { "type": "integer" }, "pow_max_multiplier": { "type": "integer" },
        "web_events_per_token": { "type": "integer" },
        "multiplicity_thresholds": { "type": "object" }, "multiplicity_event_thresholds": { "type": "object" },
        "web_requests_per_min_subnet": { "type": "integer", "minimum": 1 },
        "otlp_requests_per_s": { "type": "integer" }, "otlp_burst": { "type": "integer" }, "otlp_bytes_per_s": { "type": "integer" },
        "pathnorm_rules_version": { "type": "string", "pattern": "^scf-path-rules/[0-9]+\\.[0-9]+\\.[0-9]+$" },
        "multiplicity_mode": { "enum": ["enforce", "shadow"], "description": "platform default (§b.4, C-124); a node treats an absent or unknown value as enforce" },
        "dev_events_per_min_site": { "type": "integer", "minimum": 1, "description": "C-136, §a.8; optional, absent = 120" },
        "counter_features": { "type": "array", "uniqueItems": true, "items": { "enum": ["props", "dev", "app", "rpc"] },
                              "description": "C-137, §d.3: optional counter-record parts the core accepts (setting edge_counter_features); absent = []" }
      }
    },
    "tenants": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["tenant_id", "status", "level"],
        "properties": {
          "tenant_id": { "type": "string", "format": "uuid" },
          "status": { "enum": ["pending", "active", "suspended"] },
          "level": { "type": "integer", "minimum": 0, "maximum": 4 }
        }
      }
    },
    "sites": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["site_id", "tenant_id", "site_key", "umami_website_id", "umami_twin_website_id", "status", "profile",
                     "visitor_id", "visitor_id_off_countries", "exclude_countries", "path_folding",
                     "rate_limit_per_min", "daily_quota", "domains", "multiplicity_mode"],
        "properties": {
          "site_id": { "type": "string", "format": "uuid" }, "tenant_id": { "type": "string", "format": "uuid" },
          "site_key": { "type": "string", "pattern": "^[0-9A-Za-z]{22}$" },
          "umami_website_id": { "type": "string", "format": "uuid" },
          "umami_twin_website_id": { "type": ["string", "null"], "format": "uuid", "description": "null until provisioned (C-73)" },
          "status": { "enum": ["active", "over_quota"] },
          "profile": { "enum": ["standard", "strict"] },
          "visitor_id": { "enum": ["on", "off", "off_in"] },
          "visitor_id_off_countries": { "type": "array", "items": { "type": "string", "pattern": "^[A-Z]{2}$" } },
          "exclude_countries": { "type": "array", "items": { "type": "string", "pattern": "^[A-Z]{2}$" } },
          "path_folding": { "enum": ["full", "relaxed"] },
          "rate_limit_per_min": { "type": "integer", "minimum": 1, "description": "whole-platform figure; each node enforces ÷ live edge nodes (C-90)" },
          "daily_quota": { "type": "integer", "minimum": 1, "description": "verified web events/day of the site's tenant, shared by its sites (C-19, C-90)" },
          "multiplicity_mode": { "enum": ["enforce", "shadow", null], "description": "per-site override set by an SCF operator; null = the platform setting (§b.4, C-124)" },
          "dev_origins": { "type": "array", "maxItems": 10, "items": { "type": "string", "maxLength": 253 },
                           "description": "C-136, §a.8: dev/preview origins; optional, absent = []" },
          "debug_until": { "type": ["string", "null"], "format": "date-time", "description": "C-136, §a.8: debug mode end; optional, absent = off" },
          "domains": {
            "type": "array",
            "items": { "type": "object", "additionalProperties": false, "required": ["host", "include_subdomains", "verified"],
                       "properties": { "host": { "type": "string" }, "include_subdomains": { "type": "boolean" }, "verified": { "type": "boolean" } } }
          }
        }
      }
    },
    "ingest_tokens": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["token_id", "tenant_id", "hash", "pepper_version", "allowed_service_names", "expires_at"],
        "properties": {
          "token_id": { "type": "string", "pattern": "^[0-9A-Za-z]{12}$" },
          "tenant_id": { "type": "string", "format": "uuid" },
          "hash": { "type": "string", "description": "b64u HMAC-SHA-256(pepper_ing[pepper_version], secret)" },
          "pepper_version": { "type": "integer", "minimum": 1, "description": "C-81" },
          "allowed_service_names": { "type": ["array", "null"], "items": { "type": "string" } },
          "expires_at": { "type": ["string", "null"], "format": "date-time" }
        }
      }
    },
    "tracker_versions": {
      "type": "array",
      "items": { "type": "object", "additionalProperties": false, "required": ["version", "status"],
                 "properties": { "version": { "type": "string" }, "status": { "enum": ["active", "withdrawn"] } } }
    }
  }
}
```

Rules:
- Only `active` sites of `active`, `pending` or `suspended` tenants are listed; **archived and purging sites and all
  sites of removed tenants are omitted** (→ `404`, C-72, CR-19). A site is listed `over_quota` when its tenant's
  verified events today (sum of `verdict/verified` counters of all its sites) reached `daily_quota`; the state ends at
  00:00 UTC (C-90).
- `dev_origins`, `debug_until` and `dev_events_per_min_site` (C-136) are optional: gateways accept them first, then
  `edge_snapshot` emits them; a site's debug mode reaches every node within 60 s like any site change.
- `counter_features` (C-137) is the capability flag of §d.3's upgrade rule: `edge_snapshot` copies the setting
  `edge_counter_features`; a gateway sends a counter-record part only when it is listed. An older gateway ignores the
  field (the snapshot parser accepts unknown fields), so the flag can be emitted before every gateway is upgraded.
- `rate_limit_per_min` = `web_requests_per_min_site` (L1+) or `l0_web_requests_per_min_site` (L0); `daily_quota` =
  `l1_events_per_day` or `l0_events_per_day` by the tenant's level (data-model §7.1).
- Only non-revoked, non-expired tokens of tenants with status `active`, `pending` or `suspended` are listed (pending
  and suspended tokens authenticate but are refused with `403`, so tenants see why). The snapshot carries no secrets
  other than ingest-token hashes, verifiable only with `pepper_ing` (C-05). Edge nodes hold every `pepper_ing`
  version still referenced by a token (C-81).

### e.4 Staleness (C-62) and hard expiry (F12)

The node always serves from the last good snapshot (availability first). No fresh snapshot (no successful 200/304) for
**15 minutes** raises an alert; the node keeps serving; revocations, suspensions and `over_quota` do not reach it
until it reconnects — stated as a residual risk.

`expires_at` (optional in the schema, emitted whenever `SCF_EDGE_SNAPSHOT_MAX_AGE_S` > 0, default 86 400 s = 24 h) bounds
that risk: it is `issued_at` + the maximum age, and the builder re-issues an unchanged snapshot (new sequence) once a
quarter of its validity has elapsed, so a connected node never holds one within 18 h of expiry. A node whose current
snapshot is past `expires_at` must stop accepting **new** ingest for the snapshot's tenants and sites (`503`
`snapshot_expired`, `Retry-After: 30`) while it keeps polling, keeps forwarding its spool and keeps answering health
checks; it accepts again as soon as a valid, newer snapshot arrives. A payload without `expires_at` never expires
(previous behaviour). Fail-open within the validity window stays deliberate (C-62); the expiry turns "stale forever"
into "stale for at most the maximum age". A node starting without any valid snapshot on disk refuses ingest
(`503`) until it has one. On the control plane's side, `GET /internal/v1/edge/snapshot` answers **`503`** (problem
`unavailable`, `Retry-After: 10`) until `edge_snapshot` has issued the first sequence (C-113).

## f. OTLP ingest

### f.1 Endpoints

| Signal | OTLP/HTTP (protobuf `application/x-protobuf` or JSON `application/json`, optional `Content-Encoding: gzip`) | OTLP/gRPC |
|---|---|---|
| metrics | `POST https://<otlp>.<domain-a>/v1/metrics` | `opentelemetry.proto.collector.metrics.v1.MetricsService/Export` |
| traces | `POST https://<otlp>.<domain-a>/v1/traces` | `opentelemetry.proto.collector.trace.v1.TraceService/Export` |
| logs | **`404`** | **`UNIMPLEMENTED`** |

Port 443 for both (gRPC over HTTP/2, `content-type: application/grpc`); the same hosts exist on `<domain-b>`. OTLP proto
v1.x; JSON per the OTLP JSON mapping (hex trace/span ids, integer enums, int64 as string or number).

### f.2 Authentication

`Authorization: Bearer scfa_ing_<id>_<secret><crc>` (in env-var form `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_…`).
The gateway checks prefix and CRC offline, looks up `token_id` in the snapshot, compares
`HMAC-SHA-256(pepper_ing[pepper_version], secret)` in constant time, checks `expires_at` and the tenant status. If no
SCF token is present but a foreign vendor credential (`DD-API-KEY`, `x-honeycomb-team`, `api-key`,
`Authorization: Basic …`) is, the `401` message says so. Request headers are never logged. A tenant's environment
headers really do reach this endpoint (S-06a/b, C-102, C-105): `OTEL_EXPORTER_OTLP_HEADERS` from Node and Python SDK
exporters, and in Rust they **replace** the code's `Authorization` and forward a vendor `api-key`. So a wrong or
foreign bearer is answered `401` without logging any value, only `Authorization` is read, and every other incoming
header is discarded (§f.4). The onboarding quickstarts are those of `spikes/s06a-dual-export-node-python/README.md` and
`spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md` (they set `service.instance.id` and keep env headers unset).

### f.3 Status codes and retry semantics

| Condition | HTTP | gRPC | Client retries? |
|---|---|---|---|
| accepted (handed to the local Collector, which persisted it) | `200` (empty `Export*ServiceResponse`) | `OK` | — |
| malformed protobuf/JSON | `400` (`google.rpc.Status`) | `INVALID_ARGUMENT` | no |
| unsupported `Content-Type` or `Content-Encoding` | `400` | `UNIMPLEMENTED` | no |
| missing/invalid/revoked/expired token, removed tenant | `401` | `UNAUTHENTICATED` | no |
| tenant `pending` or `suspended` (C-08) | `403` | `PERMISSION_DENIED` | no |
| logs | `404` | `UNIMPLEMENTED` | no |
| compressed body > 4 MiB or decompressed > 16 MiB | `413` | `RESOURCE_EXHAUSTED` without `RetryInfo` | no |
| per-tenant rate (`otlp_requests_per_s`/`otlp_burst`) or bytes (`otlp_bytes_per_s`) exceeded | `429` + `Retry-After: <s>` | `RESOURCE_EXHAUSTED` + `RetryInfo` | yes |
| local Collector unavailable or its queue full | `503` + `Retry-After` | `UNAVAILABLE` | yes |

As built (C-118): the gateway answers `400` itself only for the **wire-level** checks (content type and encoding,
size, a body that is not a decodable request); deeper schema errors found by the Collector's receiver are passed
through with the Collector's status and body. A Collector answer of `429`, `503` or any unexpected status becomes
`503` + `Retry-After: 5` (gRPC `UNAVAILABLE`) — the tenant retries, nothing is lost silently. The per-tenant rate and
byte limits are enforced **per node at the full snapshot figure** (not divided by the number of live nodes, unlike
the web path's per-site share): a tenant spread over both nodes can reach up to twice the figure.

Order (C-140): authentication, the in-flight bounds per node (`GW_OTLP_MAX_INFLIGHT`, 16 → `503`) and per tenant
(`GW_OTLP_MAX_INFLIGHT_TENANT`, 4 → `429`) and the request rate are checked before the body is read or decompressed;
HTTP/2 is capped at 100 streams per connection; the `Bearer` scheme is case-insensitive.

Decompressed size is enforced while streaming (gzip-bomb safe). Rejections at the gateway are counted per tenant
(§d.3 `otlp`). Drops performed later (§f.5) do **not** produce `partial_success` (a processor cannot report it); tenants
see them as data-quality counters in the portal (`api_ingest_counters`).

### f.4 Metadata passed to the Collector

The gateway proxies the request to the edge node's Collector on the private `otlp` network that only the two of them join
(`otlp-collector:4318` HTTP, `otlp-collector:4317` gRPC; C-130 — formerly loopback in a shared network namespace). It
**forwards only** the content headers the protocol needs — HTTP: `Content-Type`, `Content-Encoding`; gRPC:
`content-type`, `te`, `grpc-encoding`, `grpc-accept-encoding`, `grpc-timeout` — and the `x-scf-*` headers it sets
itself (below); every other incoming header, including `Authorization`, `User-Agent`, vendor keys and any incoming
`x-scf-*`, is dropped (C-107). The gateway's own HTTP client sends **no** `User-Agent` either (Go's default
`Go-http-client/1.1` / `/2.0` is suppressed, C-122). Reason (S-04): the v0.165 receiver turns **all** incoming headers into client metadata
(it has no key allow-list), and the persistent queue writes all client metadata and the peer address to disk with each
queued request — a canary header was found in the queue file. It adds:

| Header / gRPC metadata | Value |
|---|---|
| `x-scf-tenant-id` | tenant UUID |
| `x-scf-token-id` | ingest token id |
| `x-scf-allowed-services` | `*` when the token's `allowed_service_names` is null; otherwise the comma list of percent-encoded `service.name` values (C-70) — an **empty** list gives an empty value, which the Collector treats as "no service allowed" (fail closed, C-118) |
| `x-scf-tenant-level` | `L` + min(level, 3) of the tenant in the snapshot (`L0`…`L3`); `scfsanitize` stamps it as `scf.tenant.level` (int) for the writer's L0 quotas (C-116, C-118) |
| `x-scf-received-at` | Unix nanoseconds at the gateway — the reference "now" for the time bounds of §f.5 step 7 |
| `x-scf-node` | node id |

The Collector receiver uses `include_metadata: true` on both `protocols.http` and `protocols.grpc`; `scfsanitize`
reads only these, through `client.FromContext(ctx).Metadata` (S-04 verified it identically for HTTP headers and gRPC
metadata). A request without `x-scf-tenant-id` is dropped and counted in the Collector's own metrics (there is no
tenant to attribute it to; S-04 saw the client still answered `200`) — the gateway never forwards one.

**Fallbacks when the gateway's metadata is missing or malformed (C-113)** — the gateway MUST always send all six
headers; the Collector fails closed or safe:
- `x-scf-allowed-services` missing, empty or repeated → **no service is allowed** (every resource is dropped as
  `service_not_allowed`); there is no implicit `*`.
- `x-scf-received-at` missing, repeated or not a positive integer → the Collector uses **its own clock** as the receipt
  time (for §f.5 steps 1 and 7) and counts the request in `otelcol_processor_scfsanitize_received_at_fallback`.
- A resource without `service.name` is treated as `service.name = "unknown_service"` (the OTel SDK default) for the
  allow-list test and the stream key.

### f.5 What `scfsanitize` keeps (allow-list) and does

Runs first, before any queue that touches disk:

1. Sets resource attribute `scf.tenant.id` from `x-scf-tenant-id`, **overwriting** any payload value; deletes any
   payload `tenant.id`, `scf.*` attributes; then sets resource attribute **`scf.received_at_unix_nano`** (int) from
   `x-scf-received-at` — the receipt time, carried through the persistent queue so the writer can enforce the 72-hour
   cap by age (C-112(8)) — and resource attribute **`scf.stream.instance`** = `service.instance.id`, or `"_"` when
   absent **or redacted by step 3** (C-113, C-141; the writer's stream key, §g.2, §g.4).
2. Drops resources whose `service.name` is not in `x-scf-allowed-services` (counted `service_not_allowed`, C-70). The
   drop is reported under the fixed `service.name` **`{not_allowed}`** — the tenant-sent name is never echoed (C-114).
3. Keeps only the allow-listed attributes below; drops exemplars, span events, span links, all other attributes.
   **The output is built from scratch (C-114):** new resources, scopes, metrics, points and spans into which only the
   allow-listed fields are copied, so nothing else — resource entity references, schema URLs, dropped-attribute
   counts, metric descriptions and metadata, span names, status messages — can pass, whatever the input carries.
   **Every kept free-text value** — `service.name`, `service.namespace`, `service.instance.id`,
   `deployment.environment.name`, scope name and version, `rpc.*` — goes through `pathnorm`'s sensitive-value
   classifier (seed, StrKey of any type, muxed address, JWT, API key, e-mail, IP address with or without port, URL or
   path with a query) and is **replaced by `{redacted}`** when it matches (counted in
   `otelcol_processor_scfsanitize_redactions{kind="free_text",location="attribute"}`); `rpc.*` values must also match
   `^[A-Za-z0-9_./-]{1,128}$` or are dropped. Values with control characters or over 256 bytes are dropped.
4. Metrics: keeps only `http.server.request.duration` (unit `s`) and `http.server.duration` (unit `ms` → values ×0.001,
   bounds ×0.001, unit set to `s`; the name is kept so the stream group is `sdk_legacy`). Client metrics → dropped
   (`client_metric_ignored`), except the Stellar client metrics of step 4a and the client-metric sets of steps 4b–4d when enabled; others → `metric_not_allowed`. **Malformed points are dropped and counted
   `malformed_point`, never a crash (C-114):** explicit histograms whose bucket counts do not match the bounds or do not
   add up (64-bit overflow included), exponential histograms with a scale outside −10…20, **more than 320 buckets per
   side**, or bucket indexes outside **±1075 · 2^scale** (the range of finite float64 values; index arithmetic is 64-bit),
   non-finite values, unspecified temporality. Data-point flags keep only `FLAG_NO_RECORDED_VALUE`. A request whose
   processing fails unexpectedly is dropped whole and all its items are counted `malformed_point` under
   `service.name = "unknown_service"`; the Collector keeps running.
4a. **Stellar client metrics (outbound dependency health; `scfsanitize` setting `stellar_client_metrics`, default
   `false`).** When on, the sanitise step also keeps the metrics of `@usagemap/stellar-otel` (js-stellar-sdk 17.x).
   They are never API usage and never feed the API metrics:
   - `rpc.client.call.duration`: histogram or exponential histogram, unit `s` or `ms` (converted as in step 4). Only
     points with `rpc.system.name = "jsonrpc"` **and** a string `stellar.network` are kept. Output attributes:
     `rpc.system.name = jsonrpc`; `rpc.method` ∈ {getHealth, getNetwork, getLatestLedger, getLedgers,
     getLedgerEntries, getEvents, getFeeStats, getVersionInfo, getTransaction, getTransactions, simulateTransaction,
     sendTransaction, queryEvents} else `_OTHER`; `error.type` (only when sent) ∈ {-32700, -32600, -32601, -32602,
     -32603, an HTTP status ≥ 400 from the list below, `timeout`, `network`} else `_OTHER`; `rpc.status_code` =
     `error.type` when that is a JSON-RPC code (derived, never copied).
   - `http.client.request.duration`: as above, only points with a string `url.template` **and** `stellar.network`.
     `http.request.method` ∈ {GET, POST} else `_OTHER`; `url.template` ∈ the 50 Horizon templates of
     `packages/stellar-otel/src/classify.ts` `HORIZON_TEMPLATES` (`/`, `/accounts`, `/accounts/{id}`, …,
     `/transactions_async`) else `_OTHER`; `http.response.status_code` (int) kept only when it is in {200, 201, 202, 204,
     301, 302, 304, 307, 308, 400, 401, 403, 404, 405, 406, 408, 409, 410, 413, 414, 415, 422, 429, 500, 501, 502,
     503, 504}, and then `error.type` = the status when ≥ 400 (derived); without a kept status `error.type` ∈
     {timeout, network} else `_OTHER`.
   - `stellar.tx.submissions` (unit `{transaction}`), `stellar.tx.polls`, `stellar.tx.simulations` (unit `{call}`):
     monotonic sums, delta or cumulative, value a non-negative int (or an integral double ≤ 2^53, stored as int);
     anything else `malformed_point`. Attributes: `stellar.tx.via` ∈ {rpc, horizon} else `_OTHER`;
     `stellar.tx.status` ∈ {PENDING, DUPLICATE, TRY_AGAIN_LATER, ERROR, SUCCESS, FAILED} (submissions) /
     {SUCCESS, FAILED, NOT_FOUND} (polls) else `_OTHER`; `stellar.tx.result_class` only on ERROR/FAILED, ∈ {success,
     bad_seq, insufficient_fee, insufficient_balance, bad_auth, time_bounds, no_account, malformed, soroban_invalid,
     resource_limit, expired_state, contract_error, op_failed, undecodable, other} else `other`;
     `stellar.sim.outcome` ∈ {success, error, restore_required} else `_OTHER`; `stellar.sim.error_class` only on
     `error`, ∈ {contract_error, resource_limit, expired_state, auth, wasm_trap, value_error, storage, no_account,
     other} else `other`.
   - Every Stellar point carries `stellar.network` ∈ {mainnet, testnet, futurenet, local, unknown} (else `unknown`).
     No other key is copied (`url.full`, `server.address`, `scf.route` … never). The closed sets bound the series per
     resource and scope: 1,960 / 24,480 / 555 / 95 / 65. Time bounds (step 7) and the merge rule (step 8, sums added
     with int64 overflow refusing the merge) apply. Points without the marker stay `client_metric_ignored`; with the
     setting off, everything is as in step 4. No new reason code. The setting is off by default in the processor; our Collector configuration turns it on together with the writer's `stellar_client` stream (C-153).
4b–4d. **Further client-metric sets (`scfsanitize` setting `client_metric_sets`, any of `partner`, `payments`,
   `anchors`; default none; our Collector configuration enables all three together with the writer's `integration`
   stream, §g.8, data-model `0085`, register C-170).** One compiled-in rule per metric name
   (`collector/processor/scfsanitizeprocessor/clientrules.go`): output name, unit and shape are constants; a point is
   kept only with the rule's marker attribute; every output attribute is rebuilt from a closed set (else `_OTHER` or a
   fixed default) and any other key is never copied. Unmarked points and names of a disabled set are
   `metric_not_allowed`; a wrong shape is `malformed_point`. Never API usage, never in `api_*` or `stellar_client_*`.
   - **4b partner** (`partner.go`): `stellar.partner.call.duration` (histogram, `s` or `ms` → `s`) from
     `@usagemap/partner-otel`; marker `stellar.partner`; `stellar.partner` ∈ the 14 partner ids,
     `stellar.partner.operation` ∈ that partner's route templates, `stellar.partner.outcome` ∈ 8 classes,
     `stellar.network` (as step 4a). Closed sets: `packages/partner-otel/src/partners.ts`
     (`TestPartnerTableMatchesPackage`). Bound: 7,650 series per resource and scope.
   - **4c payments** (`payments.go`): `payment.server.events` (monotonic sum, `{event}`) from
     `@usagemap/payments-otel` (x402 and MPP server hooks); marker `payment.protocol` ∈ {x402, mpp};
     `payment.stage` ∈ {required, verified, settled, paid, failed, canceled}; `payment.network` ∈ {stellar:pubnet,
     stellar:testnet, other, unknown}; per protocol `payment.scheme` (x402: exact, upto) or `payment.method` /
     `payment.intent` (MPP); `payment.asset` ∈ {USDC, XLM, USD, EUR}; `payment.amount_bucket` (6 buckets, never on
     failed/canceled); `payment.reason_class` (27 classes) and `error.type` (the x402 or MPP set) on failed/canceled
     only. Closed sets: `packages/payments-otel/src/classify.ts` and `common.ts` (`TestPaymentSetsMatchPackage`). No
     amount, address, payload, URL or error text can become a value. Worst case ≈ 1.34 M attribute sets per resource
     and scope (reason class and error type independent for a hostile sender), hence the writer's per-tenant and
     per-service series caps (§g.8).
   - **4d anchors** (`anchors.go`): `stellar.anchor.request.duration`, `stellar.anchor.events` from
     `@usagemap/anchor-otel` (a wallet's anchor funnel through the Wallet SDK) and
     `stellar.anchor.transfer.{created,transitions,status.duration,duration}`, `stellar.anchor.customer.updates`,
     `stellar.anchor.quotes.created` from `tools/ap-listener` (an anchor's own Anchor Platform events, Kafka only).
     Marker `stellar.network`. Closed sets: `packages/anchor-otel/src/classify.ts` and `tools/ap-listener/classify.go`
     (`TestAnchorSetsMatchSources`). `stellar.anchor.home_domain` and `stellar.anchor.client` are kept only as a public
     DNS name that passes the sensitive-value classifier, or (client only) a short configured name; else `_OTHER` —
     business identifiers of anchors and wallets, never of end users.
   - **Not accepted:** the Prometheus metrics of the Stellar Disbursement Platform and the OpenZeppelin Relayer
     (`TestPlatformPrometheusMetricsNotAccepted`; reasons in `docs/onboarding/api-sdp.md`, `api-oz-relayer.md`).
5. Traces: keeps SERVER spans that are **local roots**; others dropped (`span_not_server`, `span_not_local_root`).
   The remote-parent flag is available (S-04, C-107): a span is dropped as not a local root when it has a parent and
   `flags & 0x100 ≠ 0` (the SDK knows `is_remote`) and `flags & 0x200 = 0` (the parent is local); spans from SDKs that
   do not set `0x100` are kept ("every SERVER span counts"). This test runs inside `scfsanitize` (so the two reasons are
   counted per tenant); the equivalent OTTL condition is in `spikes/s04-collector-build/README.md` §2. Spans feed only
   `signal_to_metrics` and are discarded — S-04 confirmed no span leaves the Collector. **Tenant multipliers are
   bounded (C-114):** a span longer than 24 h (end − start) is `malformed_point`; span flags keep only `0x303`
   (sampled, random, the two is-remote bits); the `ot=th:` sampling threshold is capped so that one span counts at
   most **1,024** times (`th` above `ffc` becomes `ffc`; the value is canonical: lower case, trailing zeros removed).
6. Normalises paths with `pathnorm` (ADR-0012, C-16, C-101): input precedence `http.route` → `url.path` →
   `http.target` → path of `url.full`/`http.url`; writes `scf.route` and `scf.rules_version`; deletes `url.*`,
   `http.target`, `http.url` **and the raw `http.route`** — only `scf.route` and `scf.rules_version` leave the
   Collector (C-113). An `http.route` of `""` (Rust on unmatched paths) or `/**` (Spring catch-all) counts as
   **absent** (C-105). Bracket templates (`/accounts/[id]`, Next.js) are converted to the `{param}` form before
   normalisation, and any query in `http.target` (Next.js sends the raw path with its query) is stripped first
   (C-102). For metric points, `http.target` on `http.server.duration` is the route template of old-convention SDKs
   (Python 0.66b2 default) and is used as the route. Redactions increment `route_redacted`. **When none of the inputs
   exists, the sanitise step itself sets `scf.route = "{unknown}"`** (C-16, C-89, C-101); `pathnorm` never outputs
   `{unknown}` or `{overflow}`, and treats those strings as ordinary input text if a client sends them.
   **Method and status are canonicalised here** (C-113): `http.request.method` (or legacy `http.method`, renamed)
   becomes the upper-case semantic-conventions method or `_OTHER`; `http.response.status_code` (or legacy
   `http.status_code`, renamed) becomes an int and is kept only when it is 100–599 (int, integral double or decimal
   string accepted). An **absent** attribute stays absent; the writer maps absent method → `_OTHER` and absent status
   → `0` (§g.2).
7. Time bounds against `x-scf-received-at` (or the fallback clock, §f.4): points with time, and spans with **end time**
   (C-113), > received + 5 min → `future`; < received − 48 h → `too_old` (ADR-0009). This 48-hour late-data bound is enforced **here, by the sanitise step, against
   `x-scf-received-at`** — not by the writer (C-110). It bounds how old a point's own timestamp may be; the queue's
   72-hour cap is enforced separately, by receipt time at the writer (§g.1, C-112(8)).
8. **Merges data points whose attribute sets became identical** after the stripping above (C-113; e.g. Go's
   `otelhttp` points that differed only in `server.address`), within one resource, scope and metric: counts, sums and
   buckets are added, min/max combined, the merged point covers the earliest start. **Merge rule (C-114):** two points
   are merged only when their **original** attribute sets differed **and their timestamps are equal** — two points
   with the same original attributes are two snapshots of one stream (cumulative counts 3 and 5 are never sent as 8),
   and points of different times are kept apart. Cumulative points of a resource **without** `service.instance.id`
   (`scf.stream.instance = "_"`) are merged only when their start times are equal (they are different streams
   otherwise, §g.4); exponential points of different scales are merged at the smaller scale unless the result would
   span more than 640 buckets per side, but explicit points with **different bucket bounds** (and exponential points
   with different zero thresholds) are never merged. The bucket layout is part of the merge key, a key keeps at most 4
   merge targets and a metric with more than 10,000 points in one request is passed on unmerged, so merging is linear.
   The writer must therefore accept **several points with the same stream key in one request** — different bounds,
   different times, or snapshots of one stream (§g.2, §g.6). Merged points are counted in
   `otelcol_processor_scfsanitize_merged_points`.
9. Emits its drop counts as the metric `scf.ingest.dropped` (§g.2).

| Level | Allowed (input) attributes |
|---|---|
| Resource | `service.name`, `service.instance.id` (stream identity only), `service.namespace`, `deployment.environment.name`, `deployment.environment` |
| Scope | name, version (classified; `{redacted}` when sensitive, C-114) |
| Metric data point | `http.route`, `http.target` (transient, legacy route template, C-102), `http.request.method`, `http.method`, `http.response.status_code`, `http.status_code`, `rpc.method`, `rpc.system`, `rpc.system.name`, `otel.metric.overflow` |
| Span | kind, parent span id + flags, start/end time, `http.route`, `url.path`, `http.target`, `url.full`, `http.url` (all four transient), `http.request.method`, `http.method`, `http.response.status_code`, `http.status_code`, `rpc.method`, `rpc.system`, `rpc.system.name`; span-level sampling `th` from `tracestate` |

Never kept: `client.*`, `network.peer.*`, `network.local.*`, `network.protocol.*`, `user_agent.*`, `url.query`,
`url.fragment`, headers, bodies, `enduser.*`, `user.*`, `session.*`, `server.address`, `server.port`, `host.*`,
`process.*`, `os.*`, `container.*`, `http.host`, `http.server_name`, `net.host.*`, `error.type`, exemplars, exception
attributes — all observed in S-06a/b on real SDKs (resource attributes such as `host.id` and
`process.command_args` from Node; `http.host` on Python metric points; `aspnetcore.request.is_unhandled` from .NET).
Extra framework metrics (`aspnetcore.*`, `kestrel.*`, Rust's other tower metrics) are dropped by the metric-name
allow-list of step 4 (C-105). 5xx errors are derived from `http.response.status_code ≥ 500`, never from `error.type`
(absent on Go and Rust).

## g. Collector → metrics-writer

### g.1 Transport (C-77, C-60)

The Collector (custom `ocb` v0.165.0 build: `otlp`, `memory_limiter`, `filter`, `transform`, `scfsanitize`,
`signal_to_metrics`, `otlp_http`, `file_storage`, `health_check`; C-107) sends **directly** to the writers over the
private mesh with the node's mTLS certificate, through **one `otlp_http` exporter whose endpoint is one DNS name that
resolves to both writers** — `https://writers.<mesh>:4319/v1/metrics`, two address records (mesh DNS or `/etc/hosts`
written by the IaC; both cores active, C-07). Go's dialer tries the addresses in turn, so failover happens at
**connection level**: S-04 measured no loss and no duplicate across writer kills, ≈ 15–17 s to switch when a writer's
host vanished (pooled connections wait for the 5 s timeout), < 1 s when it refused connections. Not used: the alpha
`failover` connector (it dropped data when no writer was up, or stalled with an infinite last-level retry) and the
`loadbalancing` exporter (routes by key, no persistent queue per endpoint). The loopback relay of C-07
(`http://127.0.0.1:4320/v1/metrics` on the gateway) remains only as the fallback for an mTLS/SAN problem. Rules:
- **Both writer certificates carry `writers.<mesh>` in their SAN** (C-60 private CA), next to their node name.
- **A writer that cannot reach PostgreSQL closes its OTLP listener** (and reopens it when the database is back)
  instead of answering `503`: the exporter fails over only on connection-level errors, never on an HTTP status from a
  live writer. Requests in flight when the database is lost are answered `503` and retried.
- **No exporter-side batching**: `sending_queue.batch` is not configured and no `batch` processor sits after
  `scfsanitize`, so one queued request = one incoming request and retries and crash replays are byte-identical (the
  §g.3 key; S-04 saw re-batched replays change the hash). A lint test on the Collector config enforces it.
- Persistent queue: `file_storage` with **`fsync: true`** (S-04: nothing lost across `kill -9`; ≈ 7.7 ms per
  acknowledged request on the test disk, so edge disks are sized for IOPS); replayed requests go to the tail of the
  queue, so the writer never relies on order (§g.4).
- **72-hour cap (C-18, C-107, C-112(8)).** The Collector has no age-based eviction (`max_elapsed_time` is per request
  and restarts with the process). The cap is therefore enforced **by age at the writer**: `scfsanitize` stamps
  `scf.received_at_unix_nano` (§f.5 step 1) and the writer drops every point received more than 72 hours before its
  own clock, counted `undeliverable_72h` (§g.6). The queue's **size limit** (`queue_size` = 72 h of requests at the
  node's planned rate; in bytes since C-114) stays as the second bound. The 48-hour late-data bound of §f.5 step 7 (sanitise step, against
  `x-scf-received-at`) is a data-quality rule (`too_old`) on the point's own timestamp, not the queue cap. Queue depth
  and age are alerted (`otelcol_exporter_queue_size`).

Exporter values (S-04): `endpoint: https://writers.<mesh>:4319`, `encoding: proto`, `compression: gzip`, `timeout: 5s`,
`retry_on_failure: {enabled: true, initial_interval: 1s, max_interval: 5s, max_elapsed_time: 72h}`, `sending_queue:
{enabled: true, storage: file_storage/queue, sizer: bytes, queue_size: <SCF_QUEUE_BYTES>, num_consumers: 4}`.
**The queue is bounded in bytes (C-114)** — `SCF_QUEUE_BYTES`, default 2 GiB, set by the IaC to 72 h × the node's
planned request rate × average request size within the queue volume's free space. The v0.165 exporter queue has a
single sizer, so the request count is bounded only through the bytes (a queued request is ≥ ~150 bytes); the 72-hour
cap stays the writer's (`undeliverable_72h`).
The writer terminates mTLS itself (it is not behind the engine proxy). Body: `ExportMetricsServiceRequest`,
`application/x-protobuf`, gzip.

### g.2 Payload contract

- **Resource attributes**: `scf.tenant.id` (UUID string), `service.name`, `scf.stream.instance`
  (= `service.instance.id`, or `"_"` when absent or redacted, §f.5 step 1), `scf.received_at_unix_nano` (int, receipt time at the gateway,
  C-112(8); never stored, used only for the 72-hour drop), `deployment.environment.name` (optional; informational, not
  stored), `scf.tenant.level` (optional int 0…3, stamped by the Collector from the gateway's `x-scf-tenant-level`,
  which the gateway takes from the tenant's level in the edge snapshot; absent when the header was missing or not
  exactly `L0`…`L3` — the writer then applies no L0-specific cap; never stored; C-116).
  Span-derived resources **may** additionally carry **`signal_to_metrics.service.instance.id`** (the Collector
  instance's UUID, new on every Collector restart; added by the connector, S-04 — our `transform/span_derived` step
  removes it, C-113): the writer **ignores** it — it is never part of a stream key. Any other resource attribute is
  ignored.
  **`scf.ingest.dropped` resources** carry only `scf.tenant.id`, `scf.received_at_unix_nano` and
  `scf.stream.instance = "_"` — no `service.name` at resource level (the service is a data-point attribute) (C-113).
- **Scope**: instrumentation scope name and version as received **after the free-text classifier** (§f.5 step 3,
  C-114): a name or version that looks like a secret or identifier arrives as `{redacted}`. Span-derived points arrive with the connector's fixed
  scope name `github.com/open-telemetry/opentelemetry-collector-contrib/connector/signaltometricsconnector`; the writer
  **maps it to `scf/signal_to_metrics`** (stream group kind `span_derived`, §g.5) (C-107). No `transform` step renames
  it in the Collector. `scf.ingest.dropped` arrives under **two scopes** (C-113): `scf/scfsanitize` version `1.3.0` (C-114, C-116, C-141; the version changes with the sanitise rules)
  from the metrics pipeline (emitted by the processor itself), and the connector's scope above from the traces
  pipeline (the processor emits marker spans there, which `signal_to_metrics` turns into the same metric); the writer
  accepts both and adds them up.
- **Metrics**:

| Name | Type | Temporality | Unit | Group kind |
|---|---|---|---|---|
| `http.server.request.duration` | Histogram or ExponentialHistogram | cumulative or delta | `s` | `sdk_stable` |
| `http.server.duration` | Histogram or ExponentialHistogram (already in seconds) | cumulative or delta | `s` | `sdk_legacy` |
| `scf.span.server.duration` | ExponentialHistogram (scale 20, `max_size` 160; writer down-scales to 3); no `start_time_unix_nano` | delta | `s` | `span_derived` |
| `scf.ingest.dropped` | Sum, monotonic, delta, int | delta | `{point}` | — (counters only) |

- **Merged points (C-113, C-114).** The Collector has already merged points whose attribute sets became identical and
  whose timestamps are equal (§f.5 step 8), but several points with the **same stream key** can still arrive in one
  request: explicit points with different bucket bounds, points of different times, and two snapshots of one stream
  (same original attributes, never added up); the writer handles each on its own (§g.6).
- **Resource and point values (C-114):** `service.name`, `scf.stream.instance`, `service.namespace`,
  `deployment.environment.name` and `rpc.*` may be `{redacted}`; data-point flags carry only
  `FLAG_NO_RECORDED_VALUE`. `scf.ingest.dropped` points for `service_not_allowed` carry `service.name = "{not_allowed}"`
  — the writer attributes them to no service (all-zero `service_id`) and never auto-registers a service from a
  counter.
- **Data point attributes**: `scf.route` (string: a pathnorm route or `{unknown}`), `scf.rules_version`,
  `http.request.method` (canonical upper-case or `_OTHER`; legacy `http.method` renamed — both by the Collector, §f.5
  step 6), `http.response.status_code` (int 100–599; legacy `http.status_code` renamed), `rpc.method` (optional),
  `otel.metric.overflow` (bool, optional). Method and status **may be absent** — the Collector never invents them; the
  **writer** maps absent method → `_OTHER` and absent status → `0` (C-113). Span-derived points carry the same set:
  `scf.route`, `scf.rules_version`, method, status and `rpc.method` when present (C-113); span-derived `{unknown}`
  points carry no method or status attribute at all (the connector omits absent optional attributes, S-04). Span-derived counts use `Int(AdjustedCount())`, so a span
  sampled with an OTel threshold counts its adjusted weight. The **writer** maps a point with `otel.metric.overflow = true`, and every route beyond the cardinality
  guard (§g.6), to `{overflow}` (C-16, C-89). `scf.ingest.dropped` points carry `scf.reason` (§h.3) and `service.name`.

### g.3 Idempotency key and responses

- **Batch key** (C-23): `SHA-256` of the decompressed request body bytes. The writer splits the batch by
  `scf.tenant.id` and commits **one transaction per tenant**, inserting `(tenant_id, batch_key)` into the ledger first;
  a conflict means that tenant's part was already applied (counted `duplicate_batch`, skipped). The ledger keeps 7 days.
- `200` (empty response) after every tenant transaction committed, was a duplicate, belonged to a
  removed/purged/unknown tenant (nothing written, writer metrics only), or was rolled back because of its data
  (classes 22, 23, `XX000`, other 42: counted `tenant_write_error`), or is a poison part (timed out ≥ 5 times over ≥
  10 min on one writer: `tenant_write_error`) (C-112(1), C-141); other tenants of the request are unaffected; the
  request is not retried for ever. Before any SQL, a histogram point
  whose bucket count — or whose merge into the stored row — would exceed int4 is rejected and counted
  `count_overflow` (data-model §8.11).
- `400` for undecodable bodies (non-retryable; the Collector drops and counts).
- `503` + `Retry-After` when the database is **unavailable** (connection lost; classes 08, 25, 53, 57 except 57014,
  58; `XX001`/`XX002`; `42501`; or the probe finds it in recovery or read-only) — the writer **closes its listener**
  until the probe succeeds, so the Collector's dialer moves to the other writer (§g.1, C-107) — or **busy** (no
  pooled connection or no turn within the request budget; transaction deadline, `57014`, `55P03`, `40001`/`40P01`
  after 3 retries) — the listener stays open (C-141). The writer's request budget (`SCF_WRITER_WORK_TIMEOUT`, 12 s) is
  below the Collector exporter timeout (15 s); a retry of a request in flight on the same writer waits for it.
- **Never `429`** and never a failure because of one tenant's quota (over-quota points are dropped and counted).
- The key is stable across in-process retries and crash replays only because exporter-side batching is off (§g.1).
  Duplicates after a crash are limited to the requests in flight (S-04: 4 of 50 with `num_consumers: 4`), and the
  ledger skips them.

### g.4 Cumulative streams

Stream key = `SHA-256( "scf-stream-v1" ‖ lp(tenant_id) ‖ lp(service.name) ‖ lp(instance) ‖ lp(scope.name) ‖
lp(scope.version) ‖ lp(metric name) ‖ lp(k1=v1) ‖ … ‖ lp(layout) )` over the data-point attributes sorted by key
(values rendered as strings: ints in decimal, bools `true`/`false`), where `lp(x)` = uint32 BE byte length ‖ UTF-8
bytes, **`layout` = `"{layout}=x:" ‖ bounds` for an explicit histogram and `"{layout}=e"` for an exponential one**
(C-116: two points of one stream with different explicit bounds keep separate state), and **`instance` = `scf.stream.instance` when it is not `"_"`, else `"st:" ‖`
the point's `start_time_unix_nano` in decimal** (C-105). `service.instance.id` is missing by default in Go
(`resource.Default()`), Rust, the Java agent's declarative mode and Next.js (S-06a/b): without the fallback, two
replicas would merge into one cumulative stream and corrupt its deltas. With it, a new start time is a **new stream**,
never a counter reset to subtract. Delta = current − previous per bucket, count, sum, with the reset and stale-replay
rules of data-model §9.4 (an exponential **scale decrease** with the same start time is a continuation, down-scaled
exactly and subtracted; an increase is a reset, C-116); the state row is locked `FOR UPDATE` in the tenant transaction. **First point of a stream
(C-122, replaces C-112(3)):** the stream's **source** is identified by `SHA-256("scf-source-v1" ‖ lp(tenant_id) ‖
lp(service.name) ‖ lp(instance) ‖ lp(scope.name) ‖ lp(scope.version) ‖ lp(metric name) ‖ lp(scf.rules_version))` —
the stream key without the data-point dimensions and the layout, `instance` as above. The first point of a stream is
**counted in full** when (a) its source already had a row before this transaction — SDKs stamp every cumulative stream
with the process (or instrument) start time and export every stream at every interval, so a stream absent from the
source's earlier exports (a new route, the first 404 ever) holds only requests we have never counted — or (b) the
source is unseen and `time − start_time ≤ 10 min` (a fresh process: a brand-new service, or a restart without
`service.instance.id`; 10 min equals the backfill bound of §g.6). Otherwise (an unseen source whose stream started
earlier: the first export of a long-running process, or a process whose state aged out after 7 idle days) it only
seeds state (`cumulative_first_point`); a point without `start_time` always only seeds. The rules version is part of
the source, so a new path-rule set (which renders existing routes anew) seeds instead of re-counting history — the
requests of the one export interval between the last old-rule and the first new-rule export are not counted. Source
rows live in `api_stream_state` (`last_layout = {"kind":"source"}`), are touched by every request of the source and age
out with its streams (`stream_gc`). Tests: new route on a known source, first 404 ever, restart without instance
id, stale replay, brand-new service, rules-version change, concurrent first exports. The writer never assumes
arrival order: a Collector replays queued requests after newer ones (S-04). Delta points (all span-derived points,
which carry no start time) are applied as they come; they need no stream state.

### g.5 Stream groups and scope priority (C-22)

Group = (kind, metric name, scope name). Preferred group per service and UTC day = smallest `rank_key` =
`kind rank (sdk_stable 1, sdk_legacy 2, span_derived 3) | scope priority (3 digits) | scope name`. Scope priority list
(prefix match on scope name, first match wins; versioned with the writer):

| Priority | Scope name prefixes |
|---|---|
| 010 | framework server instrumentations: `@opentelemetry/instrumentation-express`, `@fastify/otel`, `@opentelemetry/instrumentation-fastify`, `@opentelemetry/instrumentation-koa`, `@opentelemetry/instrumentation-nestjs-core`, `opentelemetry.instrumentation.django`, `opentelemetry.instrumentation.fastapi`, `opentelemetry.instrumentation.flask`, `Microsoft.AspNetCore`, `io.opentelemetry.spring-webmvc`, `io.opentelemetry.spring-webflux`, `go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic`, `go.opentelemetry.io/contrib/instrumentation/github.com/gorilla/mux`, `go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo`, `opentelemetry-instrumentation-actix-web`, `opentelemetry-instrumentation-tower` (observed with `axum`, S-06b), `tower-http`, `axum` |
| 050 | generic HTTP server layers: `@opentelemetry/instrumentation-http`, `opentelemetry.instrumentation.asgi`, `opentelemetry.instrumentation.wsgi`, `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp`, `io.opentelemetry.tomcat`, `io.opentelemetry.netty`, `io.opentelemetry.jetty` |
| 100 | anything else (incl. `scf/signal_to_metrics`, the writer's name for the connector scope, §g.2) |

Prefixes match the scope name without its version (Java agent versions carry `-alpha`). Scopes observed in S-06a/b:
`@opentelemetry/instrumentation-http`, `opentelemetry.instrumentation.fastapi`, `next.js` (spans only),
`go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp`, `opentelemetry-instrumentation-tower`,
`io.opentelemetry.tomcat-10.0` (Java agent server metrics), `Microsoft.AspNetCore.Hosting` (C-102, C-105).

Span-derived counts are weighted by the sampling threshold when present; otherwise labelled "sampled, lower bound".

### g.6 Writer-side rules

Receipt age (C-112(8)): a point whose `scf.received_at_unix_nano` is more than 72 h before the writer's clock is
dropped and counted `undeliverable_72h`. Service resolution: `service.name` → existing service, else auto-register up to `max_services_per_tenant` (L0: 1,
known from `scf.tenant.level`, §g.2)
(C-21) with an audit row `service.auto_registered`, else `service_quota_exceeded`; a name that fails the
`api_services` check `^[!-~]{1,128}$` → `malformed_point` (C-116). Backfill: points with time <
`registered_at − 10 min` → `before_registration`; a service is never registered before its tenant exists, so this
bound also excludes data from before the tenant's creation (C-116). Points whose bucket has no partition are dropped
before insertion (`too_old`/`future`, data-model §10). Routes: cardinality guard 1 000 per service/day, 5 000 per
tenant/day (L0: 100/tenant/day), 200 siblings per prefix → `{overflow}` (`route_overflow`, C-24). Histograms per
data-model §9 (`exp_scale_coarse`, `hist_layout_approx`, `negative_value`): span-derived points arrive at scale 20 and
are down-scaled to exp3 (`i3 = i_s >> (s − 3)`); a scale < 3 point is split across every explicit bound a bucket
straddles (C-103). Two points of the same stream key with different explicit bounds in one request (§g.2, C-113) are
both processed — neither is dropped as a duplicate of the other; each keeps its own cumulative state, because the
bucket layout is the last element of the stream key (§g.4, C-116). **Counters:** writer-side drop and outcome counters
are dated by the writer's UTC day, the Collector's `scf.ingest.dropped` by the point time; `duplicate_batch`,
`tenant_write_error` and every other writer reason count **points** (`{point}`) (C-116). Stored histograms are
`int4[]` (C-103). Writes per S-05: one transaction per tenant, stream-state
keys sorted and locked `FOR UPDATE`, one multi-row upsert per (kind × resolution), 8–16 pooled connections.

### g.7 Writer stream `stellar_client` (C-153, data-model `0080`)

The Stellar client metrics that `scfsanitize` keeps under step 4a of §f.5 (`rpc.client.call.duration`,
`http.client.request.duration`, `stellar.tx.submissions`, `stellar.tx.polls`, `stellar.tx.simulations`) arrive in the
same batches as API metrics but are a **separate stream**: the writer stores them only in `scf.stellar_client_1m`,
`_1h` and `_1d` (dimensions `metric`, `network`, `operation`, `variant`, `outcome` as listed in the migration header;
`''` = not applicable) and their cumulative-to-delta state only in `scf.stellar_client_stream_state`; **never in an
`api_*` table**, so they never count as API usage, never consume the API's route or stream-state caps and are not read
by trust scoring, public metrics or snapshots. Durations are stored as count, `duration_sum` (seconds) and the
`explicit15` histogram (data-model §9.1); counters as `count` only. Cumulative points follow §g.4 (first point seeds
state, `cumulative_first_point`; a reset is `cumulative_reset`); the service, receipt-age, time-bound and overflow
rules of §g.6 apply unchanged (`before_registration`, `too_old`, `future`, `count_overflow`, `malformed_point`). Order
of the upserts: `_1d`, `_1h`, `_1m`; a point refused at `_1d` is left out of the finer ones (C-112(1)). RLS is forced on
all four tables; only `scf_writer` inserts or updates; tenants read them (portal panel "Stellar RPC/Horizon");
`retention` deletes `_1m` after 35 days and `_1h`/`_1d` after 25 months; `stream_gc` deletes state idle 7 days.
**Caps** (settings): at most `stellar_client_series_cap_per_tenant_day` (5,000) new series (`_1d` rows) per tenant and
UTC day and `stellar_client_stream_cap_per_tenant` (20,000) cumulative streams per tenant; beyond them the point is
dropped and counted `stellar_series_overflow` (§h.3). A writer without this stream drops the points as
`metric_not_allowed`.

### g.8 Writer stream `integration` (C-170, data-model `0085`)

The metrics of §f.5 steps 4b–4d are a third **separate stream**: the writer stores them only in
`scf.integration_metrics_1h` and `_1d` and their cumulative-to-delta state in `scf.integration_stream_state`; never in an
`api_*` or `stellar_client_*` table, so they never count as API usage and are not read by trust scoring, public
metrics, snapshots or the Usage Map. Columns: `metric`, `network` (`stellar.network`, or `payment.network` for
payments) and up to seven ordered dimensions `d1`…`d7` per metric (`''` = not applicable / not sent) — the per-metric
mapping is the normative list in the header of migration `0085` (data-model §12.5). Partner and anchor request
durations keep count, `duration_sum` (seconds) and the `explicit15` histogram; the two transfer durations (minutes to
days) keep count and `duration_sum` only; counters keep `count`. Order of the upserts `_1d`, `_1h`; a point refused at
`_1d` is left out of `_1h` (C-112(1)). §g.4 and §g.6 apply as for §g.7. **Caps** (settings):
`integration_series_cap_per_tenant_day` (5,000) and `integration_series_cap_per_service_day` (2,000) new series per UTC
day, `integration_stream_cap_per_tenant` (20,000) streams; beyond them the point is dropped and counted
`stellar_series_overflow` (§h.3). Retention: `_1h` 35 days, `_1d` 25 months, state 7 days idle. Tenant reads:
`getPartnerCalls`, `getPaymentEvents`, `getAnchorFunnel`. A writer without this stream drops the points as
`metric_not_allowed`.

## h. Verdicts and reason codes (closed lists)

### h.1 Web verdicts

`verified` — valid challenge and proof, no suspect reason. `suspect` — at least one suspect reason, no reject reason.
`rejected` — at least one reject reason; never forwarded, counted only. Multiple reasons are all counted (`reason`
counter); the verdict is the worst.

**`dev` (C-136, §a.8)** is a class, not a verdict: an event from a dev origin. It is never forwarded and never
counted; its would-be verdict (`verified`/`suspect`/`rejected` by the rules below, ignoring `origin_mismatch` and
`domain_unverified`) is kept only in the dev-event buffer and the `X-Scf-Debug` header.

### h.2 Web reason codes

| Code | Verdict | Meaning |
|---|---|---|
| `ua_bot` | rejected | `isbot` (Umami's pinned version) matches the raw UA (C-36) |
| `origin_mismatch` | rejected | `Origin`/`Referer` host is not a declared domain of the site |
| `fetch_impossible` | rejected | header combination a browser cannot produce on `/v1/c`/`/v1/e`: `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Site: none`, or `Sec-Fetch-Dest` `document`, `iframe` or `frame` (C-39, C-118) |
| `challenge_missing` | rejected | no or malformed token (`t` absent, not a string or not 123 b64u characters); the batch is still answered `202` — no oracle (§a.5, C-118) |
| `challenge_invalid` | rejected | bad MAC with a known key, or token for another site |
| `challenge_expired` | rejected | token older than 30 min or from the future |
| `proof_invalid` | rejected | `c` present but wrong |
| `token_flood` | rejected | events per token over the cap |
| `tenant_pending` | rejected | tenant awaiting approval (C-08) |
| `tenant_suspended` | rejected | tenant suspended |
| `proof_missing` | suspect | no `c` (page hidden before solving, or no WebCrypto) (C-35) |
| `challenge_unverifiable` | suspect | token epoch key unknown on this node |
| `ctx_moved` | suspect | subnet/UA class differs from the token's |
| `domain_unverified` | suspect | origin is a declared but not yet verified domain (L0) |
| `automation_flag` | suspect | `sg.wd = 1` or headless UA token (standard only) |
| `hidden_or_prerender` | suspect | `sg.vis ∈ {h, p}` on a pageview (standard only) |
| `net_datacenter` | suspect | ASN class `datacenter` (C-38: `tor`/`vpn` only lower thresholds). As built (C-118) every class, the eyeball classes included, comes only from the configured range lists (`GW_RANGELISTS_DIR`); an address in none of them is `unknown`, which uses the larger of the `unknown` and `eyeball_mobile` thresholds (§b.4, C-124) — recorded deviation |
| `multiplicity_high` | suspect | bucket `high` **and** low engagement, exactly as defined in §b.4; only in `enforce` mode — in `shadow` mode counted as `multiplicity/high_shadow` instead (C-124) |
| `transport_mismatch` | suspect | the UA claims a browser engine whose transport the connection does not have (§a.6 "Transport fingerprint", C-124): e.g. Go, Node, Python or curl TLS stacks claiming Chrome; Firefox's NSS claiming Chrome; no `h2` offered first; a foreign HTTP/2 pseudo-header order. **Known limits:** (1) a determined attacker can mimic a browser's TLS and HTTP/2 stack (curl-impersonate, uTLS, or simply driving a real browser) — the signal catches default library stacks, not adversaries who invest; (2) false positives: TLS-intercepting corporate proxies and antivirus HTTPS scanning re-originate TLS with their own stack, a user who disabled HTTP/2, and browsers newer than the rule set if they change the classified features; (3) no signal behind a TLS terminator. Never `rejected` on this alone; its share is visible per site in the installation check |
| `header_inconsistent` | suspect | as built (C-118): empty `User-Agent`; or `Sec-Fetch-Mode`/`Sec-Fetch-Site` missing for a browser that always sends them — Chrome/Edge ≥ 80, Opera ≥ 67, Samsung Internet ≥ 13, Firefox ≥ 90, Safari ≥ 17; or `Accept-Language` missing for any known browser family; or a `Referer` without `Origin` from such a browser (C-140). Client hints are not checked |
| `origin_missing` | suspect | no `Origin` and no `Referer`; the event's hostname is then the site's **first declared domain** (C-118) |
| `rate_anomaly` | suspect | site event rate > 10× its 28-day p99 in the last 10 min, counting only events with no batch-level rejection and a solved proof (C-140). As built (C-118) each node keeps the history **in memory** (28 days of 10-minute counts per site); the rule applies only once a node has ≥ 1 day of history and starts over after a restart. Open item: a per-site `rate_p99_10min` in the snapshot (§e.3), computed centrally |

Engine outcomes are not reasons; they are `drop` labels (`engine_bot_drop`, `engine_rejected`, §c.6, C-69). The full
`drop` list is data-model §8.9.

### h.3 API data-quality reasons (`api_ingest_counters.reason`, `scf.reason`)

`service_not_allowed`, `service_quota_exceeded`, `before_registration`, `too_old`, `future`, `metric_not_allowed`,
`client_metric_ignored`, `span_not_server`, `span_not_local_root`, `logs_rejected`, `route_overflow`, `route_redacted`,
`cumulative_first_point`, `cumulative_reset`, `duplicate_batch`, `hist_layout_approx`, `exp_scale_coarse`,
`quota_exceeded`, `malformed_point`, `negative_value`, `rate_limited`, `payload_too_large`, `tenant_pending`,
`tenant_suspended`, `token_expired`, `undeliverable_72h` (writer: received more than 72 h earlier, C-112(8)),
`count_overflow`, `tenant_write_error` (C-112(1)), `hist_unit_suspect` (explicit bounds are the OTel millisecond
default layout under unit `s`; stored as coarse, C-141), `route_seed_redacted` (subset of `route_redacted`: data points
whose route held a Stellar secret seed (`S…`); kept, the seed replaced by `{redacted}` and never stored in any form;
drives the tenant's rotate-your-key warning, C-148).
`stellar_series_overflow` (a Stellar client-metric point beyond the per-tenant series or stream cap of §g.7; dropped,
C-153).

### h.4 Trust-score reason codes (`web_trust_scores.reason_codes`)

`proof_coverage_low`, `network_datacenter_share_high`, `multiplicity_share_high`, `engagement_low`,
`hidden_share_high`, `duration_entropy_low`, `mix_divergent_device`, `mix_divergent_country`, `night_share_high`,
`step_change`, `burstiness_high`, `pow_latency_implausible`, `cross_signal_inconsistent`, `insufficient_data`.
Each code in `components` carries `{value, p, eco_percentile|null}` (percentiles only with ≥ 20 active tenants, C-44).
`insufficient_data` is the only code of a row whose score is `NULL` (fewer than `op_min_count` raw page views in the
window, data-model §8.10).

### h.5 API assurance reason codes

`a1_rate_implausible`, `a1_status_mix_implausible`, `a1_latency_implausible`, `a1_route_profile_implausible`,
`a2_no_base_url`, `a2_probe_failed`, `a3_no_verified_contract`, `a3_onchain_inconsistent`, `a3_not_applicable`.

## i. Programme outputs (ADR-0032)

**Web semantics in every output (C-73).** Page views and unique visitors come as `verified` and `raw`; visits,
bounces, bounce rate and visit duration come once, as `visit_metrics`, with `suspect_pageview_share` (fraction 0–1 of
raw page views that are not verified). **Exact values (C-95):** the minimum count and rounding apply only to web
breakdown rows, and these outputs contain no breakdown rows, so every figure is exact. No trust score (C-47).

### i.1 Per-tenant `metrics_endpoint`

`GET https://<portal>.<domain-a>/public/v1/projects/{slug}/metrics.json`

Access (C-14): anonymous if the tenant enabled public stats; otherwise `Authorization: Bearer scfa_pub_…` (that
tenant's share key) or `Bearer scfa_op_…` (scopes `web:read` **and** `api:read`, tenant restriction honoured, CR-21).
Otherwise `404` (no existence oracle). **Only `active` tenants: `pending`, `suspended` and `removed` tenants answer
`404`** (C-94). `Cache-Control: public, max-age=3600` for anonymous, `private` otherwise; `ETag`. Rebuilt hourly.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/metrics-endpoint-1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "project", "generated_at", "window", "web", "api", "links"],
  "$defs": {
    "count": { "type": "integer", "minimum": 0 },
    "pvVisitors": {
      "type": "object", "additionalProperties": false,
      "required": ["pageviews", "visitors_sum"],
      "properties": { "pageviews": { "$ref": "#/$defs/count" }, "visitors_sum": { "$ref": "#/$defs/count" } }
    },
    "visitMetrics": {
      "type": "object", "additionalProperties": false,
      "required": ["visits", "bounces", "bounce_rate_pct", "avg_visit_duration_s", "suspect_pageview_share"],
      "properties": {
        "visits": { "$ref": "#/$defs/count" }, "bounces": { "$ref": "#/$defs/count" },
        "bounce_rate_pct": { "type": ["number", "null"], "minimum": 0, "maximum": 100, "description": "null when visits = 0" },
        "avg_visit_duration_s": { "type": ["number", "null"], "minimum": 0, "description": "null when visits = 0" },
        "suspect_pageview_share": { "type": ["number", "null"], "minimum": 0, "maximum": 1, "description": "null when raw page views = 0" }
      }
    }
  },
  "properties": {
    "schema": { "const": "scf-analytics/metrics-endpoint/1" },
    "project": {
      "type": "object", "additionalProperties": false, "required": ["slug", "name", "verification_level"],
      "properties": { "slug": { "type": "string" }, "name": { "type": "string" },
                      "verification_level": { "enum": ["L0", "L1", "L2", "L3", "L4"] } }
    },
    "generated_at": { "type": "string", "format": "date-time" },
    "window": { "type": "object", "additionalProperties": false, "required": ["start", "end", "days"],
                "properties": { "start": { "type": "string", "format": "date-time", "description": "inclusive, midnight UTC" },
                                "end": { "type": "string", "format": "date-time", "description": "exclusive, midnight UTC" },
                                "days": { "type": "integer", "minimum": 1 } } },
    "web": {
      "type": "object", "additionalProperties": false,
      "required": ["verified", "raw", "visit_metrics", "daily"],
      "properties": {
        "verified": { "$ref": "#/$defs/pvVisitors" }, "raw": { "$ref": "#/$defs/pvVisitors" },
        "visit_metrics": { "$ref": "#/$defs/visitMetrics" },
        "filtered": {
          "type": "object", "additionalProperties": false,
          "description": "optional (C-148): absent from documents built before 2026-11-19",
          "required": ["events_received", "verified", "suspect", "rejected", "not_counted_share", "suspect_share",
                       "rejected_share", "reasons", "reasons_suppressed"],
          "properties": {
            "events_received": { "$ref": "#/$defs/count" }, "verified": { "$ref": "#/$defs/count" },
            "suspect": { "$ref": "#/$defs/count" }, "rejected": { "$ref": "#/$defs/count" },
            "not_counted_share": { "type": ["number", "null"], "minimum": 0, "maximum": 1 },
            "suspect_share": { "type": ["number", "null"] }, "rejected_share": { "type": ["number", "null"] },
            "reasons": { "type": "array", "items": { "type": "object", "additionalProperties": false,
              "required": ["code", "verdict", "count"],
              "properties": { "code": { "type": "string", "description": "§h.2" },
                              "verdict": { "enum": ["suspect", "rejected"] },
                              "count": { "$ref": "#/$defs/count", "description": "op_count: k-threshold + rounding (C-95)" } } } },
            "reasons_suppressed": { "$ref": "#/$defs/count" }
          }
        },
        "daily": { "type": "array", "items": { "type": "object", "additionalProperties": false,
          "required": ["start", "pageviews_verified", "pageviews_raw", "visitors_sum_verified", "visitors_sum_raw"],
          "properties": { "start": { "type": "string", "format": "date-time", "description": "the UTC day, as its midnight" },
                          "pageviews_verified": { "$ref": "#/$defs/count" }, "pageviews_raw": { "$ref": "#/$defs/count" },
                          "visitors_sum_verified": { "$ref": "#/$defs/count" }, "visitors_sum_raw": { "$ref": "#/$defs/count" } } } }
      }
    },
    "api": {
      "type": "object", "additionalProperties": false,
      "required": ["label", "requests", "error_rate_5xx", "p95_ms", "accuracy_class", "assurance_level", "daily"],
      "properties": {
        "label": { "const": "self-attested telemetry" },
        "requests": { "$ref": "#/$defs/count" },
        "error_rate_5xx": { "type": ["number", "null"] },
        "p95_ms": { "type": ["number", "null"] },
        "accuracy_class": { "enum": ["exp3", "explicit15", "explicit15_approx", "coarse", null] },
        "assurance_level": { "enum": ["A0", "A1", "A2", null] },
        "onchain_consistent": { "enum": ["consistent", "inconsistent", "not_applicable", "unavailable", null] },
        "daily": { "type": "array", "items": { "type": "object", "additionalProperties": false,
          "required": ["start", "requests"],
          "properties": { "start": { "type": "string", "format": "date-time" }, "requests": { "$ref": "#/$defs/count" } } } }
      }
    },
    "links": { "type": "object", "additionalProperties": false, "required": ["definitions"],
               "properties": { "definitions": { "type": "string", "format": "uri" } } }
  }
}
```

Example:

```json
{"schema":"scf-analytics/metrics-endpoint/1",
 "project":{"slug":"example","name":"Example","verification_level":"L3"},
 "generated_at":"2026-11-12T10:00:00Z",
 "window":{"start":"2026-10-13T00:00:00Z","end":"2026-11-12T00:00:00Z","days":30},
 "web":{"verified":{"pageviews":48213,"visitors_sum":9118},"raw":{"pageviews":51034,"visitors_sum":9802},
        "visit_metrics":{"visits":12010,"bounces":5044,"bounce_rate_pct":42.0,"avg_visit_duration_s":91.5,"suspect_pageview_share":0.0553},
        "daily":[{"start":"2026-11-11T00:00:00Z","pageviews_verified":1602,"pageviews_raw":1700,"visitors_sum_verified":301,"visitors_sum_raw":322}]},
 "api":{"label":"self-attested telemetry","requests":1204513,"error_rate_5xx":0.0031,"p95_ms":182.0,"accuracy_class":"exp3",
        "assurance_level":"A2","onchain_consistent":"not_applicable","daily":[{"start":"2026-11-11T00:00:00Z","requests":40120}]},
 "links":{"definitions":"https://portal.example.org/docs/metric-definitions/1"}}
```

`web.filtered` (optional, C-148): events by gateway verdict over the window from `web_edge_counters` (exact); reason
rows are a breakdown and pass `scf.op_count` (below k left out, counted in `reasons_suppressed`) — the one place in
this document where the minimum count applies. The field is additive and optional, so the schema id stays
`metrics-endpoint/1` (C-148 records why).

`visitors_sum` is the sum of daily unique visitors (ADR-0007), exact per site and day (counted by job `web_rollup`
over the `scf_ro` view, §j.5; programme outputs read only `scf` rollups, never Umami). Window = last `public_metrics_window_days` (30) complete UTC days.

### i.2 Platform `health_endpoint`

`GET https://<portal>.<domain-a>/public/v1/health` — public (C-14), no tenant data, `Cache-Control: no-store`. `200`
when `status` is `ok` or `degraded`, `503` when `down`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/health-1.json",
  "type": "object", "additionalProperties": false,
  "required": ["schema", "status", "checked_at", "version", "components"],
  "properties": {
    "schema": { "const": "scf-analytics/health/1" },
    "status": { "enum": ["ok", "degraded", "down"] },
    "checked_at": { "type": "string", "format": "date-time" },
    "version": { "type": "string" },
    "components": {
      "type": "object", "additionalProperties": false,
      "required": ["web_ingest", "otlp_ingest", "dashboards", "processing"],
      "properties": {
        "web_ingest":  { "enum": ["ok", "degraded", "down"] },
        "otlp_ingest": { "enum": ["ok", "degraded", "down"] },
        "dashboards":  { "enum": ["ok", "degraded", "down"] },
        "processing":  { "enum": ["ok", "degraded", "down"], "description": "spool drain / writer / freshness" }
      }
    },
    "ingest_hostnames": {
      "type": "array", "description": "per-hostname availability in the last probe rounds (C-78)",
      "items": { "type": "object", "additionalProperties": false, "required": ["host", "status"],
                 "properties": { "host": { "type": "string" }, "status": { "enum": ["ok", "down"] } } }
    },
    "edge_nodes": {
      "type": "array", "description": "per-edge-node availability (C-78, C-92)",
      "items": { "type": "object", "additionalProperties": false, "required": ["node", "status"],
                 "properties": { "node": { "type": "string", "description": "e.g. edge-a1" },
                                 "status": { "enum": ["ok", "down", "draining"] } } }
    },
    "freshness_p99_seconds": { "type": ["integer", "null"], "description": "last hour, accepted → visible" },
    "status_page": { "type": "string", "format": "uri" }
  }
}
```

Example:

```json
{"schema":"scf-analytics/health/1","status":"degraded","checked_at":"2026-11-12T10:00:30Z","version":"1.4.2",
 "components":{"web_ingest":"degraded","otlp_ingest":"ok","dashboards":"ok","processing":"ok"},
 "ingest_hostnames":[{"host":"i.example.org","status":"ok"},{"host":"i.example.net","status":"ok"}],
 "edge_nodes":[{"node":"edge-a1","status":"ok"},{"node":"edge-a2","status":"down"},{"node":"edge-b1","status":"ok"},{"node":"edge-b2","status":"draining"}],
 "freshness_p99_seconds":41,"status_page":"https://status.example.org/"}
```

`status` = worst component. `web_ingest`/`otlp_ingest` = `down` when the last round by 2-of-3 quorum (C-30, C-78)
found no ingest hostname accepting, `degraded` when any hostname or edge node is `down`; a round for which fewer than
two probe sources reported is "unknown" and does not change the status. `edge_nodes` follows the health controller's
view (C-92; `draining` = listener closed for maintenance). `processing` = `degraded` when the oldest unacknowledged
spool record is > 5 min old, `down` > 1 h.

### i.3 Signed traction snapshot (C-47)

**Versions (C-136).** Two document schemas exist: **v1** (`scf-analytics/traction-snapshot/1`, below, §i.3.1) and
**v2** (`scf-analytics/traction-snapshot/2`, §i.3.2). Both are signed and verified by the same
procedure, keys and endpoints. **Versioning rule:** a verifier dispatches on `snapshot.schema`; every issued snapshot
stays verifiable for the life of the service whatever its version; both schemas are closed, so a new field means a
new schema version; the API creates v2 by default and still accepts `schema_version: 1` (v1 creation is deprecated
and will be withdrawn by a later design decision, never v1 verification).

#### i.3.1 Version 1

Created by a tenant `admin`/`owner` (`POST /v1/tenants/{tenantId}/traction-snapshots`); returned and downloadable as:

```json
{
  "snapshot": {
    "schema": "scf-analytics/traction-snapshot/1",
    "snapshot_id": "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12",
    "issued_at": "2026-11-12T10:00:00Z",
    "issuer": "<portal>.<domain-a>",
    "project": { "slug": "example", "name": "Example", "verification_level": "L3", "registry_matches": ["stellarlight"] },
    "period": { "start": "2026-08-01T00:00:00Z", "end": "2026-11-01T00:00:00Z" },
    "web": { "verified": { "pageviews": 48213, "visitors_sum": 9118 },
             "raw": { "pageviews": 51034, "visitors_sum": 9802 },
             "visit_metrics": { "visits": 12010, "bounces": 5044, "bounce_rate_pct": 42.0, "avg_visit_duration_s": 91.5,
                                "suspect_pageview_share": 0.0553 },
             "monthly": [ { "start": "2026-08-01T00:00:00Z", "pageviews_verified": 15021, "visitors_sum_verified": 2903 } ] },
    "api": { "label": "self-attested telemetry", "requests": 1204513, "error_rate_5xx": 0.0031, "p95_ms": 182.0,
             "accuracy_class": "exp3", "assurance_level": "A2", "onchain_consistent": "not_applicable",
             "monthly": [ { "start": "2026-08-01T00:00:00Z", "requests": 390104 } ] },
    "definitions": "https://<portal>.<domain-a>/docs/metric-definitions/1"
  },
  "signature": { "alg": "Ed25519", "kid": "snap-2026-11", "sig": "<b64u, 64 bytes>" }
}
```

Field rules: exact values (C-95), web shape as §i.1; no trust score; no per-route or per-referrer detail. `period`
follows C-86 (`end` exclusive): at most 400 days, `end` ≤ today 00:00 UTC; `monthly[].start` is the first instant of
each calendar month in the period (stored as `traction_snapshots.period_start`/`period_end`).

Signing: `sig = Ed25519(snapshot_key[kid], JCS(snapshot))` where `JCS` is RFC 8785 canonical JSON (UTF-8). The
snapshot key is separate from all peppers and the edge-snapshot key.

**Verification procedure** (anyone can run it):
1. Fetch the public keys from `https://<portal>.<domain-a>/.well-known/scf-snapshot-keys.json` — a JWKS:
   `{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"snap-2026-11","x":"<b64u>","use":"sig","not_before":"…","not_after":"…"|null}]}`.
2. Select the key whose `kid` equals `signature.kid` and whose validity covers `snapshot.issued_at`.
3. Compute `JCS(snapshot)` and verify `signature.sig` with Ed25519. Any change to the snapshot breaks it.
4. Optionally fetch `GET https://<portal>.<domain-a>/public/v1/snapshots/{snapshot_id}` — returns the stored
   `{snapshot, signature, status: "valid"|"revoked", revoked_at}`; it must be byte-identical after JCS and `status`
   must be `valid`. A snapshot revoked by the tenant still verifies cryptographically but is reported `revoked`.
5. (v2, C-136, C-137) Optionally check that the snapshot is in the project's public list (§i.3.3) at position
   `series.seq`, that the list has no gap up to it and that the entry before it has the hash `series.previous_sha256`;
   and, when `seal.enabled`, its seal inclusion proof (§m.2).

#### i.3.2 Version 2 (C-136)

Same request operation (`createTractionSnapshot`) with `schema_version: 2` (the default) and a `preset` (default
`custom`); the period is always given by the request; signed by job `public_metrics` like v1 (F16), which also sets
`methodology_version` and `signed_at`. Document (inside the same `{snapshot, signature}` envelope):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/traction-snapshot-2.json",
  "type": "object", "additionalProperties": false,
  "required": ["schema", "snapshot_id", "issued_at", "issuer", "project", "series", "period", "preset", "methodology", "web",
               "api", "onchain", "coverage", "confidence", "anomaly_flags", "seal", "links", "text"],
  "$defs": {
    "count": { "type": "integer", "minimum": 0 },
    "week": { "type": "string", "format": "date-time", "description": "Monday 00:00 UTC of an ISO week" }
  },
  "properties": {
    "schema": { "const": "scf-analytics/traction-snapshot/2" },
    "snapshot_id": { "type": "string", "format": "uuid" },
    "issued_at": { "type": "string", "format": "date-time" },
    "issuer": { "type": "string" },
    "project": { "type": "object", "additionalProperties": false, "required": ["slug", "name", "verification_level", "registry_matches"],
      "properties": { "slug": { "type": "string" }, "name": { "type": "string" },
                      "verification_level": { "enum": ["L0", "L1", "L2", "L3", "L4"] },
                      "registry_matches": { "type": "array", "items": { "enum": ["stellarlight", "pg_atlas", "scf_site", "operator"] } } } },
    "series": { "type": "object", "additionalProperties": false, "required": ["seq", "previous_sha256"],
      "description": "C-137: position in the project's series of signed snapshots (public list §i.3.3)",
      "properties": { "seq": { "type": "integer", "minimum": 1 },
                      "previous_sha256": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$",
                                           "description": "hex SHA-256(JCS) of snapshot seq − 1; null for seq 1" } } },
    "period": { "type": "object", "additionalProperties": false, "required": ["start", "end", "days"],
      "properties": { "start": { "type": "string", "format": "date-time" }, "end": { "type": "string", "format": "date-time" },
                      "days": { "type": "integer", "minimum": 1, "maximum": 400 } } },
    "preset": { "enum": ["build_tranche", "growth_hack_before", "growth_hack_during", "pg_renewal_quarter", "custom"] },
    "methodology": { "type": "object", "additionalProperties": false, "required": ["version", "url"],
      "properties": { "version": { "type": "string", "pattern": "^scf-methodology/[0-9]+\\.[0-9]+\\.[0-9]+$" },
                      "url": { "type": "string", "format": "uri" } } },
    "web": { "type": "object", "additionalProperties": false,
      "required": ["verified", "raw", "visit_metrics", "weekly"],
      "properties": {
        "verified": { "type": "object", "additionalProperties": false, "required": ["pageviews", "visitors_sum"],
                      "properties": { "pageviews": { "$ref": "#/$defs/count" }, "visitors_sum": { "$ref": "#/$defs/count" } } },
        "raw": { "type": "object", "additionalProperties": false, "required": ["pageviews", "visitors_sum"],
                 "properties": { "pageviews": { "$ref": "#/$defs/count" }, "visitors_sum": { "$ref": "#/$defs/count" } } },
        "visit_metrics": { "type": "object", "additionalProperties": false,
          "required": ["visits", "bounces", "bounce_rate_pct", "avg_visit_duration_s", "suspect_pageview_share"],
          "properties": { "visits": { "$ref": "#/$defs/count" }, "bounces": { "$ref": "#/$defs/count" },
                          "bounce_rate_pct": { "type": ["number", "null"] }, "avg_visit_duration_s": { "type": ["number", "null"] },
                          "suspect_pageview_share": { "type": ["number", "null"] } } },
        "weekly": { "type": "array", "items": { "type": "object", "additionalProperties": false,
          "required": ["start", "days", "pageviews_verified", "pageviews_raw", "visitors_sum_verified"],
          "properties": { "start": { "$ref": "#/$defs/week" }, "days": { "type": "integer", "minimum": 1, "maximum": 7 },
                          "pageviews_verified": { "$ref": "#/$defs/count" }, "pageviews_raw": { "$ref": "#/$defs/count" },
                          "visitors_sum_verified": { "$ref": "#/$defs/count" } } } } } },
    "api": { "oneOf": [ { "type": "null" }, { "type": "object", "additionalProperties": false,
      "required": ["label", "requests", "error_rate_5xx", "p95_ms", "accuracy_class", "assurance_level", "onchain_consistent", "weekly"],
      "properties": {
        "label": { "const": "self-attested telemetry" }, "requests": { "$ref": "#/$defs/count" },
        "error_rate_5xx": { "type": ["number", "null"] }, "p95_ms": { "type": ["number", "null"] },
        "accuracy_class": { "enum": ["exp3", "explicit15", "explicit15_approx", "coarse", null] },
        "assurance_level": { "enum": ["A0", "A1", "A2", null] },
        "onchain_consistent": { "enum": ["consistent", "inconsistent", "not_applicable", "unavailable", null] },
        "weekly": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["start", "days", "requests"],
          "properties": { "start": { "$ref": "#/$defs/week" }, "days": { "type": "integer", "minimum": 1, "maximum": 7 },
                          "requests": { "$ref": "#/$defs/count" } } } } } } ] },
    "onchain": { "oneOf": [ { "type": "null" }, { "type": "object", "additionalProperties": false,
      "required": ["network", "data_source", "verified_contracts", "invocations", "successful_invocations",
                   "distinct_invokers_daily_sum", "daily", "weekly"],
      "properties": {
        "network": { "enum": ["mainnet", "testnet"] },
        "data_source": { "enum": ["ledger_files", "hubble", "mixed"] },
        "verified_contracts": { "$ref": "#/$defs/count" },
        "invocations": { "$ref": "#/$defs/count" }, "successful_invocations": { "$ref": "#/$defs/count" },
        "distinct_invokers_daily_sum": { "$ref": "#/$defs/count" },
        "daily": { "type": "array", "items": { "type": "object", "additionalProperties": false,
          "required": ["day", "invocations", "successful_invocations", "distinct_invokers"],
          "properties": { "day": { "type": "string", "format": "date" }, "invocations": { "$ref": "#/$defs/count" },
                          "successful_invocations": { "$ref": "#/$defs/count" }, "distinct_invokers": { "$ref": "#/$defs/count" } } } },
        "weekly": { "type": "array", "items": { "type": "object", "additionalProperties": false,
          "required": ["start", "days", "invocations", "successful_invocations", "distinct_invokers_daily_sum"],
          "properties": { "start": { "$ref": "#/$defs/week" }, "days": { "type": "integer", "minimum": 1, "maximum": 7 },
                          "invocations": { "$ref": "#/$defs/count" }, "successful_invocations": { "$ref": "#/$defs/count" },
                          "distinct_invokers_daily_sum": { "$ref": "#/$defs/count" } } } } } } ] },
    "coverage": { "type": "object", "additionalProperties": false,
      "required": ["days_in_period", "web_days_with_events", "web_days_final", "api_days_with_data", "onchain_days_complete"],
      "properties": { "days_in_period": { "$ref": "#/$defs/count" }, "web_days_with_events": { "$ref": "#/$defs/count" },
                      "web_days_final": { "$ref": "#/$defs/count" },
                      "api_days_with_data": { "type": ["integer", "null"], "minimum": 0 },
                      "onchain_days_complete": { "type": ["integer", "null"], "minimum": 0 } } },
    "confidence": { "type": "object", "additionalProperties": false, "required": ["level", "reasons"],
      "properties": { "level": { "enum": ["high", "medium", "low", "insufficient"] },
                      "reasons": { "type": "array", "uniqueItems": true,
                                   "items": { "enum": ["few_events", "partial_coverage", "days_not_final", "high_suspect_share",
                                                       "open_anomaly_flags", "domain_unverified", "no_verified_contracts"] } } } },
    "anomaly_flags": { "type": "object", "additionalProperties": false, "required": ["open_web", "open_api"],
      "properties": { "open_web": { "$ref": "#/$defs/count" }, "open_api": { "$ref": "#/$defs/count" } } },
    "seal": { "type": "object", "additionalProperties": false, "required": ["enabled", "network", "proof_url"],
      "properties": { "enabled": { "type": "boolean" }, "network": { "enum": ["testnet", "mainnet", null] },
                      "proof_url": { "type": ["string", "null"], "format": "uri" } } },
    "links": { "type": "object", "additionalProperties": false, "required": ["verify", "public_list", "definitions"],
      "properties": { "verify": { "type": "string", "format": "uri" }, "public_list": { "type": "string", "format": "uri" },
                      "definitions": { "type": "string", "format": "uri" } } },
    "text": { "type": "string", "maxLength": 4000, "description": "pasteable plain-text rendering, §i.3.4" }
  }
}
```

Field rules (C-136):
- **Presets.** `pg_renewal_quarter`: the period must be exactly one calendar quarter (start 1 Jan/Apr/Jul/Oct;
  `400` otherwise). `build_tranche`, `growth_hack_before`,
  `growth_hack_during`, `custom`: the tenant gives the period (an SCF tranche's dates, the weeks before a campaign,
  the campaign itself). The preset is a label the reader can rely on, never a computed claim; every period follows
  §i.3.1's rules (C-86, ≤ 400 days, `end` ≤ today 00:00 UTC).
- **Weekly series** are ISO weeks (Monday 00:00 UTC) clipped to the period; `days` < 7 marks a partial first or last
  week. Exact values (C-95); no breakdowns; **no trust score** (C-47).
- **On-chain** (`null` unless the tenant enabled on-chain correlation and has ≥ 1 verified contract on the platform's
  network): sums over `onchain_daily` of **verified** contracts only; `network` `public` is written `mainnet`;
  `distinct_invokers_daily_sum` is the sum of daily distinct invokers (no cross-day de-duplication, like visitors);
  `daily` lists every day of the period with a complete row.
- **Coverage**: `web_days_with_events` = days with raw page views > 0 on any site; `web_days_final` = days whose
  rollup is final on every site (C-138: days with at least one `web_daily_totals` row, all of them `is_final`; a day
  without any rollup row is not final); `api_days_with_data` (`null` without API) = days with ≥ 1 request;
  `onchain_days_complete` (`null` without on-chain) = days with a row for every verified contract.
- **Confidence** (rule of methodology `scf-methodology/1.0.0`): `insufficient` when raw page views of the
  period < `op_min_count` and there is neither API nor on-chain data; otherwise `high` with no reason, `medium` with
  one, `low` with two or more. Reasons: `few_events` (raw page views < 10 × days), `partial_coverage`
  (`web_days_with_events` < 80 % of the days), `days_not_final`, `high_suspect_share` (> 0.30), `open_anomaly_flags`
  (> 0), `domain_unverified` (level L0), `no_verified_contracts` (on-chain enabled, none verified).
- **Open anomaly flags (counts only, never details).** `open_web` = (site, day, reason code) triples of
  `web_trust_scores` (window 1) in the period, code ≠ `insufficient_data`, not covered by a `trust_annotations` row of
  that site whose range contains the day and that lists the code in `explains_reason_codes` or has
  `marks_explained`; `open_api` = the same over `api_service_assurance.reason_codes` with `a1_*` or
  `a3_onchain_inconsistent` codes. The snapshot never names a code, a day or a site.
- **Seal**: `enabled` = the tenant's `seal_enabled` at issue time; `network` = the platform's seal network (testnet
  by default, C-135) or `null`; `proof_url` = `https://<portal>.<domain-a>/public/v1/snapshots/{snapshot_id}/seal`
  (answers `404` until the day's seal is built, at most ~25 hours after issue) or `null`. The proof itself is not in
  the signed document (it exists only after the day ends); §m.2.
- **Series (C-137).** `seq` numbers the tenant's signed snapshots 1, 2, 3, … in signing order (v1
  and v2 alike, from C-136 on; earlier ones are outside the series); `previous_sha256` is the `sha256` of snapshot
  `seq − 1` as listed in §i.3.3 (`null` for 1). The signing job (`public_metrics`, the only signer) assigns both
  before it signs; the database refuses a number that is not the tenant's next one (data-model §12.1). Anyone holding
  snapshot *n* can therefore tell that *n − 1* others were issued and check each against the list: a deleted or
  withheld snapshot shows as a gap or a broken hash link. This makes cherry-picking visible to every holder of a later
  snapshot, not only to readers of the list.
- **Methodology and on-chain source (C-138).** `methodology.url` = `https://<portal>.<domain-a>/docs/methodology/1.0.0`
  (the document is `docs/methodology/scf-methodology-1.0.0.md`); `onchain.data_source` = `ledger_files` when every
  counted row of the period is from ledger files, `hubble` when every one is from Hubble, else `mixed`.
- **Links**: `verify` = `https://<portal>.<domain-a>/verify?snapshot={snapshot_id}`; `public_list` =
  `https://<portal>.<domain-a>/public/v1/projects/{slug}/snapshots`; `definitions` = the metric definitions.
- **Wording rule (C4).** No field, label or text says or implies "verified by SCF/SDF", "endorsed", "approved" or
  "genuine". "Verified" in this document always means *our measurement class* (challenge and proof passed) or *a
  contract whose ownership we checked*, and `text` says so.

#### i.3.3 Public list of issued snapshots (C-136)

`GET https://<portal>.<domain-a>/public/v1/projects/{slug}/snapshots` — public, no key; every signed snapshot of the
tenant that has a series number (§i.3.2: every snapshot signed from C-136 on), in series order, **revoked ones
included** (append-only: a signed snapshot is never changed and is deleted only when the tenant is purged, data-model
§12.1), each with `seq` and `previous_sha256`, so a reader checks that `seq` runs 1, 2, 3, … without a gap and that
each `previous_sha256` equals the entry before it. `404` for unknown slugs, for tenants that are not `active` or
`suspended`, **and for a tenant with no listed snapshot yet** (C-138): an empty list would tell anyone which slugs
exist, so the list exists only from `seq` 1 on, and the three cases answer the same `404`. `Cache-Control: public,
max-age=300`. A pending (unsigned) request is not listed.

**Consent and older snapshots (C-137).** The list is public **whether or not the tenant enabled
public stats**: creating a snapshot publishes its id, period, preset and hash in the list (the document itself is
served to anyone who has the id). The create form and `createTractionSnapshot` say so before the tenant confirms.
Snapshots signed **before** C-136 (no series number) were issued when a snapshot was shared by its id only; they are
not listed and stay verifiable by id (decision recorded in C-137).

```json
{"schema":"scf-analytics/snapshot-list/1","project":{"slug":"example"},"generated_at":"2026-11-16T10:00:00Z",
 "snapshots":[{"snapshot_id":"0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12","seq":1,"previous_sha256":null,"schema_version":2,
   "preset":"pg_renewal_quarter","period":{"start":"2026-07-01T00:00:00Z","end":"2026-10-01T00:00:00Z"},
   "signed_at":"2026-11-16T09:59:58Z","sha256":"<hex of SHA-256(JCS(snapshot))>","status":"valid","revoked_at":null,
   "url":"https://portal.example.org/public/v1/snapshots/0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12"}]}
```

#### i.3.4 Pasteable text (`text`, C-136)

Plain UTF-8, `\n` line ends, ≤ 4,000 characters, generated deterministically from the other fields of the same
document (so it is covered by the signature). Template (lines without data are left out; numbers with thousands
separators `,`; percentages with one decimal):

```
<name> — measured usage, <start date> to <end date − 1 day> (<days> days, <preset label>)
Snapshot <seq> of this project (all are listed at the link below)
Web: <verified pageviews> verified page views (<raw> raw; <suspect share>% suspect); <verified visitors_sum> daily visitors (sum)
API (self-attested telemetry): <requests> requests; 5xx <rate>%; p95 <p95> ms; assurance <A-level>
On-chain (<network>, <n> verified contracts): <invocations> invocations, <success>% successful, <invokers> daily invokers (sum)
Coverage: <web_days_with_events>/<days> days with web events; confidence <level><: reasons>
Open anomaly flags: web <open_web>, API <open_api>
Measured by <issuer> (methodology <version>). "Verified" means passed our bot checks, not endorsed by SCF or SDF.
Verify: <links.verify>   All snapshots of this project: <links.public_list>
```

Preset labels: `build_tranche` "SCF Build tranche", `growth_hack_before` "before Growth Hack campaign",
`growth_hack_during` "during Growth Hack campaign", `pg_renewal_quarter` "Public Goods renewal quarter", `custom`
"custom period".

#### i.3.5 Traction snapshot schema v3 — the SCF Evidence Link (C-156, migration `0078`)

`schema: "scf-analytics/traction-snapshot/3"`. Every v2 field (§i.3.2) with the same meaning and rules, plus:

- `funnel` (always): `network` (`mainnet`|`testnet`, the deployment's), `min_count` (= `op_min_count`), `stages`
  [`web_visitors`, `wallet_connects`, `signatures`, `onchain_calls`] each `{stage, verified, raw}`; `conversion`
  `{connects_per_visitor, signatures_per_connect}` (4 digits; no on-chain ratio, D5); `daily[]` one row per UTC day
  of the period `{day, web_visitors_verified, web_visitors_raw, wallet_connects_verified, wallet_connects_raw,
  signatures_verified, signatures_raw, onchain_calls, onchain_calls_successful}`; `suppressed_cells`.
  Sources: `web_daily_totals` visitors; `web_event_property_daily` `_total` rows of `wallet_connect` / `sign_approved`
  on `network`, verified = verdict verified, raw = verified + suspect; on-chain = the v2 `onchain.daily` complete
  days (null otherwise; verified = raw: ledger facts). Floor (C-137): any daily cell and the wallet totals with
  0 < n < `min_count` are null. Web and on-chain totals exact (C-95).
- `programme` (null, or): **`growth_hack`** for `growth_hack_during` — `campaign`/`baseline` `{start, end, weeks}`
  (baseline = the same number of whole ISO weeks right before), `active_account_definition`, `weekly[]` (`start`,
  `window`, `onchain_calls`, `active_accounts_min` = largest daily distinct invokers of one contract,
  `active_accounts_max` = sum of daily distinct invokers over contracts and days, `web_visitors_verified`,
  `api_requests`), `averages` `{baseline, campaign, change, ratio}` (sum of weekly values ÷ weeks, 1 decimal; ratio
  of the rounded averages, 4 digits), `cohort_share` `{status: shown|not_enough_projects|no_increase|no_cohort|
  no_onchain_data, cohort, projects, share}` = max(Δ,0)/Σmax(Δ,0) of average weekly on-chain calls over the first SCF
  cohort's eligible members with on-chain data in both windows, ≥ 5 members, 2 decimals; `ambiguities[]`.
  **`public_goods`** for `pg_renewal_quarter` — `quarter`, `previous_quarter` `{label, start, end}`, `figures[]`
  `{metric, value, previous, change}` for onchain_calls, onchain_successful_calls, onchain_invokers_daily_sum,
  web_visitors_verified, web_pageviews_verified, api_requests, api_error_rate_5xx, api_p95_ms (`change` null for the
  two API reliability figures), `monthly[]`, `not_measured` [uptime, downloads, direct_dependents, pony_factor],
  `ambiguities[]`.
- `comparison`: `status` (`ok`|`no_registry_link`), `method`, `min_projects` (max(cohort_min_tenants, 5)),
  `min_value` (op_min_count), `positions[]` `{cohort {kind round|category, id}, metric web_visitors_verified|
  onchain_calls, status, projects, percentile}`. Members: active, not purged, not canary, level ≥ 1, confirmed
  registry link. Gates in order: `low_confidence` (confidence low/insufficient), `not_eligible`, `not_enough_data`
  (own figure < min_value), `not_enough_projects` (< min_projects members incl. self reach min_value). Shown:
  mid-rank percentile (others below + ½ ties) ÷ others × 100, rounded to a multiple of 5.
- `wording` `{statement, seal}`: the C4 statement and `sealed on Stellar testnet: a demonstration, not a permanent
  record` | `sealed on Stellar mainnet` | `not sealed`.
- `links.evidence` = `<portal>/evidence/<snapshot_id>`.
- `text` (v3, ≤ 4000 chars): v2's lines plus `Evidence page: …`, `Funnel (verified, <net>): …` (withheld = "fewer
  than k"), a Growth Hack or Public Goods line, `Position in SCF cohort: …` ("not enough projects to compare" /
  "no confirmed SCF registry link"), the C4 statement, `Seal: …` when sealed.
- Request rule (createTractionSnapshot, `schema_version: 3`): `growth_hack_before|during` need whole ISO weeks
  (Monday 00:00 UTC to Monday); `growth_hack_during` ≤ 200 days.

Documented ambiguities: A1 weekly distinct accounts are an interval, not a number; A2 accounts = invokers of the
verified footprint, not every operation; A3 the retention rule is worded three ways (30 % / ≤ 70 % decline /
≥ 30 %) — users snapshot the retention weeks; A4 cohort share uses the SCF cohort measured here, on-chain calls only
(TVL out of scope); P1 PG Score signals we do not measure; P2 invoking accounts are a sum of daily counts.

### i.4 SCF cohort vocabularies (C-136)

Registry projects carry the SCF category and award vocabulary as slugs (data-model §12.1); APIs return the slugs, the
portal shows the labels:

| Field | Slug → label |
|---|---|
| `scf_categories[]` | `end_user_application` "End-User Application" · `financial_protocols` "Financial Protocols" · `applications` "Applications" · `developer_tooling` "Developer Tooling" · `infrastructure_services` "Infrastructure & Services" |
| `award_stage` | `t0_prelaunch` "Pre-Launch #0 Awarded" · `t1_mvp` "#1 MVP" · `t2_testnet` "#2 Testnet" · `t3_mainnet` "#3 Mainnet" |
| `award_round` | integer, the round of the project's latest award |

A value the source does not state is empty/`null`, never inferred from the name or description. Cohort reads
(`/op/v1/cohorts`, `/v1/operator/cohorts`, `scf.op_cohorts`) show a cohort's figures only when it has at least
`cohort_min_tenants` (5) tenants; smaller cohorts are listed with `suppressed: true` and no figures. In a shown cohort
(C-137) a figure below `op_min_count` (10) is `null`, and the on-chain figures are `null` unless at least
`cohort_min_tenants` of its tenants have on-chain data. This is a floor for statistical comparison, not a privacy
boundary: the same operator scope reads each tenant's exact totals (`op_web_metrics`, C-95).

## j. Umami adapter contract (`packages/umami-adapter`) and the rollup read path

These are the **only** Umami calls we depend on; the engine proxy's per-caller path allow-list and deny-list (§c.5,
C-60, C-104) and the contract tests pin exactly this list against the real pinned container on every change and
nightly against upstream's newest tag (ADR-0003, C-69). Every shape below was **verified against Umami 3.5.0 in spike
S-01** (C-99; `spikes/s01-umami-integration/run.sh` items 1, 3 and 5 become contract tests). The only SQL read of
Umami data is the rollup view of §j.5.

**Engine image and configuration (C-104, C-99).** Two images built from `vendor/umami/` (source at commit `d3c62a8`,
frozen-lockfile install, no geo database): `umami` (runs `node server.js`) and `umami-migrate` (one-shot
`prisma migrate deploy` as `umami_app`; `umami` starts only after it completed successfully, C-40). Runtime:
read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, uid 1001, an `internal: true` network with no
egress, tmpfs `/tmp` and `/app/.next/cache`. Environment: `CLIENT_IP_HEADER=x-scf-surrogate-ip`, `SALT_ROTATION=day`,
`TZ=UTC`, `DISABLE_TELEMETRY=1`, `DISABLE_UPDATES=1`, `PRIVATE_MODE=1`, `SKIP_DB_MIGRATION=1`, `APP_SECRET` (32 random
bytes, **identical on every Umami instance** (both cores; the cache tokens and session ids must agree), stable for the
life of the deployment; rotating it is a planned event — every session id and every cache token changes, so sessions
and visits split at the rotation, C-112(11)). Never set: `CLOUD_MODE`, `SKIP_LOCATION_HEADERS`, `TRUSTED_PROXIES`, `DISABLE_BOT_CHECK`,
`ENABLE_CLIENT_SALT`, `GEOLITE_DB_PATH`, `MCP_ENABLED`, `COLLECT_API_ENDPOINT`, `TRACKER_SCRIPT_NAME`,
`TRACKER_SCRIPT_URL`. Exact values: `spikes/s02-umami-hardened-image/README.md`.

### j.1 Identities

| Caller (mTLS identity) | Umami credential | Allowed calls |
|---|---|---|
| edge forwarders | none (the engine proxy adds only the cache token) | `POST /api/send` |
| provisioning worker (job `umami_reconcile`) | **provisioning admin** session token (P1; its password in SOPS, held in memory) for P2–P4, P7–P9, P11–P13; **the tenant user's own session** (P5, password decrypted from `umami_credentials`) for P6 and P10 | j.2 (and B1–B5 once) |
| control plane (reads for the live window) | per-tenant API key, `Authorization: Bearer umami_<32 chars>` | j.3 |
| job `web_rollup` | PostgreSQL role `scf_umami_ro` (no Umami credential) | the `scf_ro` view, §j.5 |
| health checks | none | `GET /api/heartbeat` |

### j.2 Provisioning calls

**Bootstrap (C-99, C-104; restartable, C-112(7)).** Umami seeds an `admin` user (id
`41e2b680-648e-4b09-bcd7-3e2b10c06264`) with password `umami`, and its "change required" flag is a UI modal only — the
default password works over the API. Both new passwords — the seed admin's interim password (B2) and the provisioning
admin's (B3) — come from SOPS, never generated on the fly, so a crash between steps never strands an unknown password.
On every start the worker first tries **P1** (provisioning admin login); if it works, it checks B4/B5 and finishes any
incomplete step; if not, it resumes from the first incomplete step (B1 with `umami`, or B1 with the B2 password from
SOPS when B2 already ran). The engine proxy refuses every other caller until B5 has been seen (§c.5).

| # | Method, path | Session | Body | Result |
|---|---|---|---|---|
| B1 | `POST /api/auth/login` | — | `{"username":"admin","password":"umami"}` | token T |
| B2 | `POST /api/me/password` | T | `{"currentPassword":"umami","newPassword":<from SOPS, ≥ 8 chars>}` | `200` with a new token T2; T is now `401` |
| B3 | `POST /api/users` | T2 | `{username: <provisioning admin>, password: <from SOPS>, role: "admin"}` | provisioning admin; log in as it → T3 |
| B4 | `DELETE /api/users/41e2b680-648e-4b09-bcd7-3e2b10c06264` | T3 | — | `200`: the seed admin is gone |
| B5 | `POST /api/auth/login` | — | `{"username":"admin","password":"umami"}` | must be `401` (bootstrap check; opens the engine proxy's gate) |

| # | Method, path | Session | Body / params | Fields read |
|---|---|---|---|---|
| P1 | `POST /api/auth/login` | — | `{username, password}` (provisioning admin) | `token` |
| P2 | `POST /api/users` | admin | `{username: "scf-t-<tenant hex>", password: <random 32 B>, role: "view-only"}` — **global role `view-only`** (C-99: with role `user` the tenant's key could create personal websites and teams, S-01 §6) | `id` |
| P3 | `POST /api/teams` | admin | `{name: "scf-t-<tenant hex>"}` | the response is an **array** `[team, membership]`: read `[0].id`; the admin becomes `team-owner` of every tenant team. `[0].accessCode` is never logged or stored |
| P4 | `POST /api/teams/{teamId}/users` | admin | `{userId, role: "team-view-only"}` | status only |
| P5 | `POST /api/auth/login` | — | as the tenant user, with the stored password | `token` |
| P6 | `POST /api/me/api-keys` | tenant user | `{name: "scf-control-plane"}` | `id` and `key` (`umami_<32 chars>`, shown once; both stored, the key encrypted) |
| P7 | `POST /api/websites` | admin | `{id: <umami_website_id>, name: <site_id>, domain: <first declared host or "invalid.example">, teamId}` | `id` (`400 ID already in use.` on a repeated id) |
| P7t | `POST /api/websites` | admin | twin website (C-73): `{id: <umami_twin_website_id>, name: "<site_id>/twin", domain: <as P7>, teamId}` | `id` |
| P8 | `POST /api/websites/{websiteId}` | admin | `{name, domain}` | status only |
| P9 | `DELETE /api/websites/{websiteId}` | admin | — (main and twin) | status only (site removal / tenant purge); preceded by P13 and by the token purge of §c.5 on every core |
| P10 | `DELETE /api/me/api-keys/{keyId}` | tenant user | — | `{"ok":true}` (key rotation; the old key is `401` afterwards) |
| P11 | `DELETE /api/users/{userId}`, `DELETE /api/teams/{teamId}` | admin | — | tenant purge |
| P12 | `GET /api/admin/websites` | admin | `page`, `pageSize` | `data[].id`, `count` (reconciliation); `data[].team.accessCode` is never logged |
| P13 | `GET /api/users/{userId}`, `GET /api/teams/{teamId}`, `GET /api/websites/{websiteId}` | admin | — | existence only, **before every P9/P11 delete** (C-113): Umami answers `500` when deleting a user, team or website that is already gone, so a retried purge would never finish. A missing user or website answers `200` with body `null`, a missing team `404`; in those cases the delete is skipped and counted as done |

**Credentials (C-85, superseding the password rule of C-69; CR-05).** Creating an API key in Umami needs that user's
own login, so the random password of P2 is **kept**, encrypted like the key (`umami_credentials.password_ciphertext`,
data-model §8.7), and decrypted only by the provisioning worker. Provisioning: P1 → P2 → P3 → P4 → P5 → P6 → store
team id, user id, password and key (both encrypted) → P7 per site (P7t when the site first needs a twin). **Rotation**:
P5 → P6 (new key) → store it and its id → verify a read with the new key → P10 (old key id) → audit
`umami.key_rotated`. S-01 verified the P5/P6/P10 sequence; Umami has no admin route to another user's keys
(`GET /api/users/{id}/api-keys` → `404`), so nothing relies on one. Isolation verified in S-01: the tenant's key gets
`401` for another team's websites, for creating or changing websites, for minting keys and for admin routes.

**Twin provisioning on demand** (C-73, data-model §8.4): when `umami_reconcile` finds a site with
`umami_twin_website_id` set and `twin_provisioned_at` null (on `NOTIFY scf_umami` or its 5-minute pass), it calls P7t
and sets `twin_provisioned_at`; the next snapshot carries the twin id.

Never called: every route of the one deny-list in §c.5 (C-112(11)).

### j.3 Read calls for the live window (per-tenant key) and the tag-filter rule (C-73, C-99, C-109)

Live reads cover only the **live part** of a requested range — the site's live window (data-model §8.9:
`[today 00:00 UTC − (live_window_days − 1) days, now)`, at least the current UTC day) — because Umami cannot answer
longer ranges fast enough at the design load (S-11: the largest site's `/stats` p95 is 3.8 s for 7 days and 24–43 s
for 30–90 days). Everything earlier comes from the rollups (§j.5, §j.6). The live window is sized so that a live
query is **expected** to cover at most `web_live_events_budget` (250,000) engine events — from max(the 28-day average,
today's count projected to a full day), data-model §8.9 — but that is an estimate, not a guarantee (a surge within the
day, the 24-hour rule). Hard bounds (C-112(6)): every Umami call has a **5 s timeout**; on timeout or error the live part
is answered from the rollups instead (today from its hourly rows, earlier live days from the daily rows), with
`range.source = rollup` and `range.partial_today = true` when today is in the range; and the `umami_app` role has
`statement_timeout = 30s` (data-model §16.1), so an abandoned query does not keep loading the database.

Common parameters: `startAt` and `endAt` in Unix ms and `timezone=UTC` (always). **Umami's `endAt` is inclusive**
(`created_at BETWEEN …`, S-01), so for our exclusive `end` (C-86) the adapter sends **`endAt = end − 1`** ms.
`period` is never sent with an explicit range. Tag filter (S-01 §2, C-99): verified figures use **`tag=v`**; raw
figures use **no tag parameter** (equivalent to `tag=v,s`, i.e. "tag in (v, s)"); no other filter value is used, and
C-82's tag fallback is not needed.

| # | Method, path | Extra params | Fields read |
|---|---|---|---|
| R1 | `GET /api/websites/{websiteId}/stats` | optional `tag=v` | `pageviews`, `visitors`, `visits`, `bounces`, `totaltime` (JSON numbers) |
| R2 | `GET /api/websites/{websiteId}/pageviews` | `unit` ∈ `hour`,`day` only (C-113: never `month` — month series are composed by the adapter from `day` buckets, §j.6); optional `tag=v` | `pageviews[].x` (bucket start, ISO time), `pageviews[].y`, `sessions[].x`, `sessions[].y` |
| R3 | `GET /api/websites/{websiteId}/metrics` | `type=event`; `limit` (≤ 500); optional `tag=v` | `[].x` (event name), `[].y` (events: `count(*)`) |
| R4 | `GET /api/websites/{websiteId}/metrics/expanded` | `type` ∈ `referrer`,`country`,`device`,`browser`,`os`,`path`; `limit` (≤ 500); optional `tag=v` | `[].name`, `[].pageviews`, `[].visitors`, `[].visits`, `[].bounces`, `[].totaltime` — **numbers may arrive as JSON strings** (`"pageviews":"4"`), so the adapter parses number-or-string |
| R5 | `GET /api/heartbeat` | — | HTTP 200 |
| R6 | `GET /api/websites/{websiteId}/funnels/stats` (ad-hoc funnel, nothing stored in Umami) | `window` (minutes, 1–1440); `steps` = JSON array of 2–8 `{"type": "path"\|"event", "value"}` (value 1–500 characters, no control characters, `*` = any run of characters; no step filters); optional `tag=v` — Umami applies range and tag to the **first step only**, so "verified" means "first step verified" | `[i].visitors` per step (distinct sessions reaching the step in order, each within `window` of the previous) |
| R7 | `GET /api/websites/{websiteId}/goals/stats` | `type` ∈ `path`,`event`; `value` (as R6); optional `tag=v` (applies to both figures) | `num` (sessions that reached the goal), `total` (sessions with any event in the range) |
| R8 | `GET /api/websites/{websiteId}/journeys` | `steps` 2–7; optional `startStep`, `endStep` (as R6 values); optional `tag=v` | `[].items` (page paths or custom event names, consecutive repeats collapsed; trailing `null`s of shorter visits dropped), `[].count` (visits); Umami returns the 100 most frequent |

R6–R8 (C-148) read the **main website only** (twin events carry no visit), cover the live window only and have **no
rollup**: a timeout or engine error answers `503`, never an estimate; earlier days are left out. They return
aggregates only (never a session or visitor id); the control plane applies the tenant floor (`tenant_min_count`,
`tenant_round_to` with anonymous reports) and hides journeys followed by fewer visits than the minimum count. The
engine proxy's `reader` allow-list admits exactly these parameters (`services/engine-proxy/README.md`).

`/stats` always runs a second query for the comparison period (S-11), doubling its cost; the adapter calls R1 only
for figures that need it (totals and visit metrics), and uses R2 for charts. Semantics measured in S-01 (C-99), which
the metric definitions state: page views = events of type 1; visitors = sessions with ≥ 1 page view; visits =
`(session, visit)` groups with ≥ 1 page view; bounce = exactly one page view and no custom event; `totaltime` = Σ per
visit of (last − first **page view**) — custom events do not extend it; visits made only of custom events are neither
visits nor visitors. List metrics' `y` (and R4 `visitors`) = distinct sessions for referrer, country, device, browser,
OS and path, and events for `type=event`.

Which call feeds which figure (M = main website, T = twin website):

| Figure | Calls | Tag filter |
|---|---|---|
| Page views, verified | R1/R2 on M **+** R1/R2 on T, `pageviews` | `tag=v` |
| Page views, raw | R1/R2 on M **+** R1/R2 on T, `pageviews` | **none** |
| Unique visitors, verified | R1 `visitors` / R2 `sessions` on M only | `tag=v` |
| Unique visitors, raw | R1 `visitors` / R2 `sessions` on M only | **none** |
| Visits, bounces, visit duration | R1 `visits`, `bounces`, `totaltime` on M only — **one call** | **never** |
| Breakdowns (referrer, country, device, browser, OS, path), verified | R4 on M (`pageviews`, `visitors`) + R4 on T (`pageviews`) | `tag=v` |
| Breakdowns, raw | R4 on M (`pageviews`, `visitors`, `visits`) + R4 on T (`pageviews`) | **none** |
| Event counts, verified / raw | R3 on M + R3 on T | `tag=v` / none |
| Share of page views that are suspect | `1 − verified ÷ raw` page views from the rows above | — |

Rules: a call filtered with `tag=v` is never used for `visits`, `bounces` or `totaltime` (those fields of its response
are ignored; S-01 showed the distortion: a visit with one `v` and one `s` page view becomes a bounce under `tag=v`);
for the **same days**, visit metrics are never added across responses (not across `tag`-filtered responses, not M + T)
— adding the live and rollup parts of **disjoint** UTC days (§j.6) is allowed, because visits never cross 00:00 UTC; the twin's `visitors`, `visits`, `bounces` and `totaltime` are never
read. Raw unique visitors are therefore exact, not an upper bound. Additive page-view and event counts are summed across
M and T.

### j.4 Write call

`POST /api/send` exactly as §c.2, through the engine proxy. Umami's answers (S-01): stored → `200
{"cache","sessionId","visitId"}` (the engine proxy keeps `cache` and strips all three before answering the edge, §c.5);
bot → `200 {"beep":"boop"}` (nothing stored; the forwarder's `engine_bot_drop`); unknown website → `400 {"error":
{"message":"Website not found."}}`; schema error → `400`; missing country header with no geo database → `500` (never
happens: §c.2 always sends `cf-ipcountry`). Accepted `timestamp`: any integer 0 … 2,147,483,647 (also numeric strings);
Umami has no plausibility check, so ours is the gateway's receipt time.

### j.5 Rollup read path: the `scf_ro` view (C-109; replaces C-82's fallback)

Job `web_rollup` reads Umami's event and session data **only** through the two read-only views of data-model §16.3,
as PostgreSQL role `scf_umami_ro` from the core nodes:

| View | Columns (Umami 3.5.0 names) |
|---|---|
| `scf_ro.website_event` | `website_id`, `session_id`, `visit_id`, `created_at`, `event_type` (1 page view, 2 custom/wallet event), `event_name`, `tag` (`v`/`s`), `url_path` (normalised by the gateway), `referrer_domain` |
| `scf_ro.session` | `session_id`, `website_id`, `browser`, `os`, `device`, `country` |

Contract: the view definitions and the rollup SQL are contract-tested against the pinned image like the calls above:
for S-01's fixture day the rollup of each figure equals Umami's own R1/R4 answer for the same day and tag (S-01 §4
showed the SQL reproduces the API exactly). Each query is bounded by `website_id = ANY(main, twin)` and one UTC hour
or day of `created_at`. Semantics and schedule: data-model §8.9 (hourly for the current day and, until 02:00 UTC, the
previous day; 01:30 UTC for D-1; daily re-runs for D-2…D-3; ~35 s per closed day for 300 sites at 1M page views/day,
S-11). The views are dropped and recreated around every Umami migration (data-model §16.3).

As built: a **page view** is `event_type = 1`; Umami's own queries use `event_type NOT IN (2, 5)`, so any other
type found in the view is not counted and is reported as anomaly `unexpected_event_type` (none occurs with our
forwarder). **Known difference — self-referrals:** Umami's live referrer breakdown leaves out a referrer equal to the
page's own host, which needs the event's `hostname`; the `scf_ro` view does not expose it, so a rollup day can list a
self-referral that the live answer omits — in particular one whose host differs from the page host only by a `www.`
prefix. Recorded as a known difference of rolled-up referrer rows; adding `hostname` to the view is the open fix
(data-model §16.3).

### j.6 Composing a tenant range from live and rollup parts (C-109)

For a tenant web request over `[start, end)` (C-86) on site S, the control plane computes `L =
scf.web_live_window_days(S)` and the live boundary `b = today 00:00 UTC − (L − 1) days`:
- if `start ≥ now − 24 h` (the `24h` preset and any shorter recent range), the **whole range is live** — so the last
  24 hours are always answered by Umami, C-109's minimum;
- otherwise the **live part** is `[max(start, b), end)` when `end > b`, read through §j.3 (M and T as tabled), and the
  **rollup part** is `[start, min(end, b))` when `start < b`, read from `web_daily_totals` / `web_daily_breakdowns`
  (whole UTC days) and, for `unit=hour` series, `web_hourly_totals`. Both parts meet at a UTC midnight. The rollup part
  must consist of whole UTC days — `start` at 00:00 UTC, and `end` at 00:00 UTC unless it lies in the live part —
  because unique visitors, visit metrics and breakdowns are not additive within a day; a custom range that violates
  this is answered `400` (`validation_failed`, pointer `/start` or `/end`, with the site's live boundary `b` in the
  detail). The day-aligned presets (`7d`, `30d`, `90d`, `12m`, `all`) always satisfy it. Hourly series are per bucket
  and need no alignment.

Composition, figure by figure:
- Page views, events, visits, bounces, total duration, breakdown `pageviews`/`events`/`visits`: **sum** of the two
  parts (all additive; visits never cross 00:00 UTC, S-01 case F). Bounce rate and average duration are recomputed
  from the summed counts.
- Unique visitors: live part (Umami's figure) **plus** rollup part (`web_daily_totals.visitors_*` summed over the
  days). Multi-day unique visitors are **the exact sum of daily unique visitors** (C-110): the surrogate key rotates at
  00:00 UTC (ADR-0007, S-01 case F), so no visitor is ever recognised across days, and a live Umami range over several
  days returns the same sum. Nothing is estimated.
- Breakdown `visitors` per value: sum of the parts' per-value counts (per-day distinct sessions); values outside a
  day's stored top-N contribute nothing for that day (as before, merged rows are flagged `is_other`).
- The response states the split: `range.source` = `live` (no rollup part), `rollup` (no live part, or the live part
  fell back after a 5 s timeout, §j.3, with `range.partial_today`) or `mixed`, and `range.live_start` = `max(start,
  b)` (or `start` for a fully live range) when a live part was answered by Umami.
- **Time series (C-112(4)):** page views and visitors per hour, day or month (hourly rows before the live window,
  R2 in it). R2 is only ever called with `unit=hour` or `unit=day`; a **month** bucket is the sum of its days — daily
  rollup rows plus R2 `unit=day` buckets for the live days — composed by the adapter (C-113). Visits, bounces, bounce rate and duration exist for `unit=day|month` only — `unit=hour` with those metrics
  is `400 validation_failed` — with complete days from `web_daily_totals` and today from a live R1 (`/stats`) call for
  today (or today's rollup on timeout).
- **Comparison ranges (C-112(5)):** `compare=previous` composes the preceding range of equal length by exactly these
  rules (its own live part, rollup part and alignment check). When it cannot be composed (for example its rollup part
  is not whole UTC days), the response has `previous: null` and `comparison_unavailable: true`; the main range is
  unaffected.
- SCF-operator functions, programme outputs and the trust score never use the live part (data-model §11).

**Deviations as built (control plane, C-117):**
- **CSV export** needs a range that starts at 00:00 UTC (whole-day rows); the `24h` preset is therefore `400
  validation_failed` for the export (the JSON reads accept it).
- **Fallback for a leading partial day:** when a live read times out (§j.3) and the range starts inside today, the
  partial day is taken from `web_hourly_totals`: page views and events are exact, visitors are the **sum of hourly
  visitors — an upper bound** (a visitor active in two hours counts twice), and visit metrics and breakdowns are not
  available for that part (`range.partial_today`).
- **`share_pct`** of a breakdown row is its share of the **sum of the returned rows** (top-N plus `is_other`), not of
  the site total.
- **`range.anonymized`** echoes the site's anonymisation setting at read time; it does not describe how older rows
  were collected.

## k. Key and token formats (ADR-0016, C-05, C-14, C-21, C-81)

```
key     = "scfa_" kind "_" id "_" secret crc
kind    = "op" | "ing" | "pub" | "reg"
id      = 12 * base62            ; public lookup id
secret  = 27 * base62            ; 160 bits from a CSPRNG (base62 of a 20-byte random integer, zero-padded)
crc     = 6 * base62             ; CRC-32 (IEEE) of the ASCII bytes "scfa_" kind "_" id "_" secret, base62, zero-padded
base62  = "0"-"9" / "A"-"Z" / "a"-"z"     ; alphabet order 0-9, A-Z, a-z
regex   = \bscfa_(op|ing|pub|reg)_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}\b
```

Stored: `id` (plain), `last4` (last 4 characters of `secret`), `HMAC-SHA-256(pepper_<kind>[pepper_version], secret)`
and `pepper_version` (C-81). Four peppers — `ing` (core and edge nodes), `op`, `pub` and `reg` (core only). `reg` (footprint registration
keys, migration 0081) is `SCF_PEPPER_REG` when set, otherwise derived per `pub` version as
HKDF-SHA-256(pepper_pub[v], salt = empty, info = "scfa_reg/1", 32 bytes). The key string
does not carry the pepper version. Display after creation: `scfa_<kind>_<id>_…<last4>`. A wrong CRC is rejected
offline (`401`, audit `api_key.rejected_bad_checksum` for `op`). Keys are accepted **only** in `Authorization:
Bearer`; a key seen in a URL is treated as compromised.

Footprint registration key `scfa_reg_…` (C-166): one tenant,
optionally one network (`mainnet`|`testnet`), single scope `footprint:register`. Accepted only by
`registerFootprintContract` (`POST /v1/tenants/{tenantId}/footprint/register`), which adds one contract as `claimed`;
it never verifies, removes or reads. Created/revoked by a tenant `admin`/`owner` with a recent sign-in; ≤ 5 usable per
tenant; acts for its creator and stops (`401`) once the creator is no longer `admin`/`owner`. Another tenant's path =
`404` (as unknown); network mismatch = `403`. Rate limits: 60/min per client subnet, 30/min and 500/day per key id.
Audited `footprint_key.created`, `footprint_key.revoked`; registrations `footprint.item_added` with actor `system` /
`footprint_key:<id>` and details `{via: "footprint_key", key_id}`.

Delegated OAuth token (C-168): `scfa_odt_` + 43 `b64u` characters (256 bits), stored as SHA-256, lifetime ≤ 5 minutes;
issued only to the hosted MCP server by token exchange (RFC 8693) and accepted only on the tenant read operations of
`services/control-plane/src/oauth/principal.ts` or, for operator grants, on `/op/v1`. OAuth access and refresh tokens of
MCP clients are opaque 256-bit values, stored as SHA-256 (data-model `0083`).

Site key (public, not an authenticator): 22 base62 characters. Invitation code: `scfi_` + 22 base62 (128 bits),
stored as SHA-256. Session cookie value: 43 `b64u` characters (256 bits), stored as SHA-256.

## l. Edge counter delivery

The forwarder sends each spool counter record (§d.3) to `POST https://<core>/internal/v1/edge/counters` through the
core's engine proxy (mTLS, node certificate; body = the record, `application/json`); the proxy forwards it to the
control plane's internal listener over a second mutual-TLS hop (§c.5, C-114). The control plane verifies that
`node_id` equals the certificate's node — the `X-Scf-Edge-Node` header set by the engine proxy from the CN (§c.5,
C-113) — and applies the record in **one transaction per tenant plus one for the spool accounting**, each idempotent
on its own (C-113):
- per tenant: inserts `(node_id, part id)` into `edge_report_ledger`, where the part id is a UUID derived from
  `(record_id, tenant_id)`; a conflict means that tenant's part was already applied (skipped). It then applies that
  tenant's `web` rows to `web_edge_counters` (every counter of the §d.3 enum, `tracker_version` included; rows of sites
  not belonging to the tenant are dropped and counted),
  `otlp` rows to `api_ingest_counters` (service all-zero UUID) and `tokens` entries (by their `tenant_id`, §d.3) to
  `ingest_tokens.last_used_at` (≤ 1 update/min/token); `props` rows (C-136; present only when advertised, §d.3) to
  `web_event_property_daily` as
  `count = count + EXCLUDED.count`; `dev` entries (C-136) to `web_dev_events`, then trims each touched site to the
  newest `dev_event_buffer_size` rows (rows of sites not belonging to the tenant are dropped and counted, as for
  `web`);
- spool accounting: inserts `(node_id, record_id)` into `edge_report_ledger` (conflict → already applied), then adds
  the deltas into `edge_spool_accounting`, sets `queued_end`, and counts a `boot_id` different from the stored
  `last_boot_id` as a restart before storing it (data-model §8.13, migration `0051_edge_boot_id`).

A retry after a partial failure therefore applies only the missing parts. `200` acknowledges (also for a complete
duplicate); `5xx` keeps the record in the spool (72-h rule applies).

## m. Audit-chain anchor (C-63) and daily seal (C-136)

### m.1 Audit-chain anchor document

Job `audit_anchor` (daily 00:15 UTC and hourly retry) writes `audit-anchors/<YYYY-MM-DD>.json` to the public evidence
repository (egress per C-10): every day missing since the first published one (≤ 400 days back), oldest first; files
are created with link(2), never replaced (an existing or unreadable file answers "exists"; C-144):

```json
{"schema":"scf-analytics/audit-anchor/1","date":"2026-11-12","generated_at":"2026-11-13T00:15:04Z",
 "chains":[{"chain_id":"00000000-0000-0000-0000-000000000000","seq":10422,"row_hash":"<hex>"},
           {"chain_id":"0193…","seq":88,"row_hash":"<hex>"}],
 "sha256":"<hex of JCS of this object without sha256>"}
```

Tenant chain ids are tenant UUIDs (already pseudonymous; no names). Anyone can recompute a chain head from an exported
chain and compare.

**Superseded (C-136): the per-day `manage_data` entry.** Before C-136 the same `sha256` could be written to the
Stellar ledger from the platform anchoring account as a `manage_data` operation, name `scf-audit-<YYYYMMDD>`, value =
the 32 raw bytes. Each entry locks a 0.5 XLM base reserve and the account reaches the 1,000-subentry limit after about
2.7 years, so this publisher is withdrawn (`SCF_AUDIT_ANCHOR_STELLAR_*` is no longer read). **Entries already written
stay on the ledger and stay verifiable exactly as before** (read the account's data entry or the transaction that set
it); they are not removed. From C-136 on, the anchor document's `sha256` is the **audit leaf** of the daily seal
(§m.2); the file publisher is unchanged.

### m.2 Daily seal (C-136, C-135)

**What it is — and is not.** One Stellar transaction per UTC day whose `MEMO_HASH` is the root of a Merkle tree over
(a) the previous day's root, (b) the day's audit-anchor document and (c) a salted hash of every traction snapshot
signed that day by a tenant that opted in (`tenants.seal_enabled`). It is **tamper-evidence of published numbers**:
it proves that a given snapshot existed unchanged no later than the day's ledger close, and that the platform has not
rewritten earlier days without breaking the chain. **It never proves that the numbers are genuine**, and no API, page
or document may say so.

**Network (C-135).** Configuration, testnet by default: `SCF_SEAL_NETWORK` (`testnet` | `mainnet`, default
`testnet`; the seal and snapshot vocabulary — `mainnet`/`testnet` — is the one of §a.3.1, C-137), `SCF_SEAL_NETWORK_PASSPHRASE`
(default: that network's passphrase), `SCF_SEAL_HORIZON_URL` (required: submission and the reset check) and
optionally `SCF_SEAL_RPC_URL`, `SCF_SEAL_FRIENDBOT_URL` (testnet only), `SCF_SEAL_SECRET_FILE` (the sealing account's key, a file, never logged); `mainnet` additionally
requires `SCF_SEAL_MAINNET_APPROVED=1` (an explicit operator decision and a funded key, C-135). `SCF_SEAL_NETWORK_PASSPHRASE`
must be one of the two public passphrases and agree with `SCF_SEAL_NETWORK`; the passphrase alone selects its network
(mainnet ⇒ approval gate); all seal URLs are https; the Horizon root must name the configured passphrase (C-144). Without a key the job builds and
stores the day (`status = built`) but submits nothing. **Testnet is reset 2–4 times a year**: a testnet seal is a
demonstration, not durable evidence; every API response and page that shows a seal states the network and, for
testnet, this sentence: *"Stellar testnet is reset several times a year; this seal is a demonstration, not durable
evidence."*

**Tree (RFC 9162 §2.1, the Certificate Transparency v2 Merkle tree).** `H` = SHA-256. Leaf hash = `H(0x00 ‖ data)`,
node hash = `H(0x01 ‖ left ‖ right)`, the root of `n` leaves splits at the largest power of two below `n`. Leaves in
this order:

| Index | Leaf | `data` (bytes; strings ASCII, `‖` concatenation) |
|---|---|---|
| 0 | chain | `"scf-seal/1 chain"` ‖ `0x00` ‖ network (`testnet`/`mainnet`) ‖ `0x00` ‖ day (`YYYY-MM-DD`) ‖ previous day's root (32 bytes; 32 zero bytes for the first day of a network's chain) |
| 1 | audit | `"scf-seal/1 audit"` ‖ `0x00` ‖ day ‖ the anchor document's `sha256` (32 raw bytes, §m.1) |
| 2 … n−1 | snapshot | `"scf-seal/1 snapshot"` ‖ `0x00` ‖ salt (32 random bytes per leaf) ‖ snapshot id (16 bytes, RFC 9562 byte order) ‖ `H(JCS(snapshot))` (32 bytes) |

Snapshot leaves are sorted by leaf hash (bytewise ascending). A day without snapshots has two leaves. The chain is
continuous: day D's chain leaf holds day D−1's root whatever D−1's submission status, and the database refuses a day
whose `prev_root` is not the previous day's root, a skipped day, or a day before the chain's first (C-137).

**Head path (C-137).** Leaves 0 and 1 are siblings in every tree (the left subtrees of an RFC 9162
tree are full), so both share one path above their parent node: `head_path` = the sibling hashes from the node
`H(0x01 ‖ chain leaf hash ‖ audit leaf hash)` up to the root, bottom-up, `⌈log₂ leaf_count⌉ − 1` of them (none for two
leaves), and **every one of them is a right sibling**. It is stored in `seal_days` and published with every day, so
anyone can recompute the root from public data alone: `r = H(0x01 ‖ chain_leaf ‖ audit_leaf)`, then `r = H(0x01 ‖ r ‖
p)` for each `p` of `head_path`. That is what makes `prev_root` and the audit-anchor hash checkable on every day, and
lets one transaction (the first after a testnet reset, below) re-anchor every earlier day through the chain.

**Known-answer vectors (C-137).** `docs/contracts/vectors/seal-v1.json` (generated and re-checked by
`node docs/contracts/vectors/seal-vectors.mts [--check]`) pins the three leaf encodings byte for byte, RFC 9162 roots
and inclusion paths for 2 to 9 leaves at every index (cross-checked against the RFC 6962 reference roots of the
Certificate Transparency code), and a three-day chain with head paths, a segment change and snapshot proofs. The job
`daily_seal` and the browser verifier both test against this file; neither may change it, only regenerate it with the
script when this section changes.

**Which days and which snapshots (C-137).**
- **Days.** Each run builds **every missing day in ascending order**: from the day after the network's last
  `seal_days` row up to D−1 (the first run of a network starts its chain at D−1). A day is built only after
  `audit_anchor` has written that day's document (§m.1); a missing document stops the run at that day (retried hourly).
  So an outage of several days leaves no gap, and "the previous day's root" always exists.
- **Snapshots of day D.** Every **signed** snapshot (`signature` present; `signed_at` < D+1 00:00 UTC — rows signed
  before `0065` were back-filled with `signed_at = created_at`) of a tenant whose `seal_enabled` is on when D is built,
  that has **no final leaf** on that network. "Sealed before" means *has a leaf whose (network, day) has a `seal_days`
  row*; a leaf without such a row is **provisional**. So a snapshot signed during an outage is sealed in the first day
  built after its signing, and a tenant that opts in late has all its earlier signed snapshots sealed in the next day
  built (each once per network). Revoked snapshots are sealed too (they were published). Snapshots of tenants that did
  not opt in never become leaves.
- **Interrupted builds.** Before it builds day D the job **deletes every provisional leaf of D** (all tenants, each
  under its tenant's context; job `daily_seal` may delete a leaf only while its day has no row — trigger
  `seal_leaves_guard`), then builds D afresh with fresh salts. A crash between the per-tenant leaf transactions and the
  day row therefore leaves nothing behind that could be served: `public_seal_proof` returns final leaves only.

**Job `daily_seal`** (00:30 UTC, after `audit_anchor`; retried hourly until every missing day is built and submitted):
per day, builds the tree in memory, deletes D's provisional leaves, then in one transaction per tenant writes that
tenant's `seal_leaves` (salt, leaf hash, audit path), then the global `seal_days` row (`built`, with `head_path` and
`segment`) — the row makes the day's leaves final —, then submits: source = the sealing account, one operation
**`BUMP_SEQUENCE` with `bumpTo` = 0** (a no-op that creates no ledger entry and locks no reserve — the fix for §m.1's
subentry limit), `memo` = `MEMO_HASH(root)`, base fee, 5-minute time bounds; `submitted` → `confirmed` with
`tx_hash`, `ledger`, `confirmed_at` (resubmitted with fresh sequence/time bounds until confirmed; `failed` after
24 hours, which leaves the chain intact and is published). Days are submitted in day order. Audit `seal.published`
(platform chain) on build and on confirmation. A tenant purged mid-build loses its leaves with its snapshots
(cascade); the other leaves' stored paths stay valid.

**Testnet reset (C-137).** Testnet is reset 2–4 times a year (C-135); every account, including
the sealing account, disappears.
1. *Detect* (C-144): the hourly check reads the sealing network's Horizon root. A reset is proven only when a ledger
   numbered below the newest confirmed day's ledger closed after that day's `confirmed_at`
   (`history_latest_ledger_closed_at`, else `GET /ledgers/{latest}`), or that very ledger closed more than 60 s from
   `confirmed_at`; a lagging, catching-up or bounded Horizon proves nothing. The proof must hold again ≥ 50 minutes
   later; meanwhile no day is built. Then every `confirmed` day of that network whose transaction can no longer be
   found is marked `network_reset` (its row, leaves and proofs stay; the transaction is gone). A mark is reverted when
   the newest `network_reset` day's ledger is found on the same network instance and a day's own transaction is found
   unchanged.
2. *Re-create*: on testnet only, the job funds the **same** sealing key again through friendbot
   (`SCF_SEAL_FRIENDBOT_URL`, default `https://friendbot.stellar.org`; egress allowed by C-10 for testnet only).
   No key change, so the published `source_account` stays the same.
3. *Continue the chain*: the first day **built** after the reset was detected gets `segment` + 1 (the database allows
   only + 0 or + 1). Its chain leaf holds the previous day's root as always, so its transaction on the new testnet
   commits — through the chain leaves and head paths — every earlier day of every earlier segment. Days built but not
   yet confirmed when the reset happened are simply submitted to the new network.
4. *Mark it*: `/public/v1/seals` returns `segment` per day; the page shows a "testnet reset" marker between
   segments and says that days before it were confirmed on a network that no longer exists and are now anchored only
   through the first transaction of the next segment.
5. On mainnet, step 1 never fires (no resets); a `failed` day is resubmitted until confirmed as above.

As built (C-138; `services/jobs/src/seal/daily-seal.ts`):
- A reset detected while the network has **no confirmed day** (only `built`/`submitted` days, or none) bumps no
  segment: nothing confirmed was lost, so the next built day continues the current segment and the account is simply
  funded again (as on the first testnet run).
- The reset itself writes **no audit action**; it is visible in `seal_days` (`network_reset` days, the next
  segment) and in the job's log and run outcome. `seal.published` stays the only seal audit action.
- On testnet a `failed` day (24 hours unconfirmed) is final; only mainnet resubmits it until confirmed.
- Snapshots of **removed** tenants (purging or purged) never become leaves, even if `seal_enabled` was on.
- `network.lookup.ledger_files` for testnet has no default (the store moves with every reset): the control plane
  publishes `SCF_SEAL_LEDGER_FILES_URL` when set, else `null`; mainnet defaults to the AWS `pubnet` store. The
  explorer link is `SCF_SEAL_EXPLORER_URL` (a template with `{tx_hash}`; default stellar.expert for that network).

**Where a transaction is looked up (C-137).** Per network the proof and the day objects name the lookup sources in
`network.lookup`: the configured Horizon (`SCF_SEAL_HORIZON_URL`); an explorer link; and the public ledger-file
store of §p.1 for that network (AWS Open Data `v1.1/stellar/ledgers/pubnet`, or the testnet directory of the reset
segment, `v1.1/stellar/ledgers/testnet/<reset-date>/`). **Not RPC alone**: Stellar RPC keeps about seven days of
history, and a public Horizon may also be bounded (its root reports `history_elder_ledger`). The verifier asks Horizon
first; when Horizon answers `404` for a ledger older than its `history_elder_ledger` it reports **"outside this
endpoint's history"** (not "not found") and offers the ledger file covering `ledger` as the fallback (decode the
`LedgerCloseMetaBatch`, find the transaction, check source, memo and success). RPC is used only for a ledger inside
its own retention window (`getTransaction` returns `oldestLedger`).

**Inclusion proof** — `GET https://<portal>.<domain-a>/public/v1/snapshots/{snapshot_id}/seal` (public; `404` until
the day is built, for unknown ids and for snapshots of tenants that did not opt in or are not active/suspended). Only
the holder of a snapshot id receives that snapshot's salt; the audit path holds sibling hashes only. Response
`{"proofs": [ … ]}`, one entry per network on which the snapshot was sealed (one, unless the platform moved from
testnet to mainnet); each entry:

```json
{"schema":"scf-analytics/seal-proof/1",
 "network":{"name":"testnet","passphrase":"Test SDF Network ; September 2015","durable":false,
            "notice":"Stellar testnet is reset several times a year; this seal is a demonstration, not durable evidence.",
            "lookup":{"horizon":"https://horizon-testnet.stellar.org","explorer":"https://…/tx/{tx_hash}",
                      "ledger_files":"https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/testnet/<reset-date>"}},
 "snapshot_id":"0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12","snapshot_sha256":"<hex>","day":"2026-11-16","segment":1,
 "leaf_index":3,"leaf_count":5,"salt":"<hex, 32 bytes>","leaf_hash":"<hex>","audit_path":["<hex>","<hex>","<hex>"],
 "head_path":["<hex>","<hex>"],"root":"<hex>","prev_root":"<hex>","audit_anchor_sha256":"<hex>",
 "status":"confirmed","source_account":"G…","tx_hash":"<hex>","ledger":1234567,"confirmed_at":"2026-11-17T00:31:05Z",
 "explorer_url":"https://…/tx/<hex>",
 "statement":"Tamper-evidence of a published snapshot. It does not show that the numbers are genuine."}
```

**Seal days** — `GET https://<portal>.<domain-a>/public/v1/seals?start=…&end=…` (midnight UTC bounds, ≤ 400 days;
`{network, days: [ … ], statement}`) and `GET …/public/v1/seals/{day}` (`{seal, statement}`), each day `{day, network,
segment, prev_root, audit_anchor_sha256, leaf_count, head_path, root, status, source_account, tx_hash, ledger,
confirmed_at}` with the
`network` object above and `statement` = *"Tamper-evidence of a published snapshot. It does not show that the numbers
are genuine."*; public; no tenant data.

**Verification (the `/verify` page; also by hand).**
1. Verify the snapshot's signature (§i.3.1 steps 1–3) and compute `h = H(JCS(snapshot))`; it must equal
   `snapshot_sha256`.
2. Leaf hash = `H(0x00 ‖ "scf-seal/1 snapshot" ‖ 0x00 ‖ salt ‖ snapshot_id ‖ h)`; it must equal `leaf_hash`.
3. Recompute the root from `leaf_index`, `leaf_count` and `audit_path` (RFC 9162 §2.1.3.2); it must equal `root`.
4. Fetch the transaction `tx_hash` from the lookup sources of the named network (above): successful, source
   `source_account`, memo type `hash` with value `root`, in ledger `ledger`. Outside the endpoint's history the page
   says so and offers the ledger file; on testnet after a reset (`status` `network_reset`) the transaction no longer
   exists and the page says so, then continues with step 5 to the first confirmed day of a later segment.
5. **Recompute the day's root from public data alone (C-137):** chain leaf = `H(0x00 ‖ "scf-seal/1 chain" ‖ 0x00 ‖
   network ‖ 0x00 ‖ day ‖ prev_root)`, audit leaf = `H(0x00 ‖ "scf-seal/1 audit" ‖ 0x00 ‖ day ‖
   audit_anchor_sha256)`, then fold `head_path` (every sibling on the right); the result must equal `root`. Optionally
   walk the chain forward with `/public/v1/seals`: day D+1's `prev_root` equals day D's `root`, and recompute each
   day's root the same way up to a confirmed day — a later confirmed transaction then also anchors every earlier day.
   Check the audit leaf against the published anchor file of §m.1 (`sha256` = `audit_anchor_sha256`).
6. **History walk (C-144).** For every distinct `source_account` of the network's days
   (`/public/v1/seals`, paged by ≤ 400 days), read every page of `GET
   {horizon}/accounts/{G}/transactions?order=asc&limit=200&include_failed=false` (follow `_links.next.href` on the
   same host until a page has < 200 records). Keep transactions with that `source_account`, `successful`, `memo_type`
   `hash`. Then: each `confirmed` day's `tx_hash` is listed with memo (base64→hex) = `root` and the same `ledger`
   (unless `ledger` < `history_elder_ledger`: "outside this endpoint's history"); every listed memo is a published
   day's `root`; listed seals in ledger order follow day order; every `prev_root` is the previous day's `root` and
   step 5 recomputes `root`. `network_reset` days are skipped. Any failure: "the published seal history does not
   match the ledger" with day and transaction. The reference logic is `compareSealHistory` in
   `services/jobs/src/seal/verify.ts`; job `daily_seal` runs the same walk on its daily and start runs (problem codes
   `chain_break`, `root_mismatch`, `memo_mismatch`, `ledger_mismatch`, `confirmed_tx_missing`, `unknown_seal_tx`,
   `out_of_order`; metric `scf_seal_history_problems`, any problem fails the run).

The sealing account is the platform's own; it holds no tenant or end-user data and its address is published in the
seal responses. **What the seal does not cover (C-137):** on the lean single-VM profile (C-123) the seal key, the
snapshot-signing key and the database share one host, so an attacker with root on it can sign and seal new snapshots;
the seal shows only that what was sealed on a day has not changed since (threat model TM-D1-04).

## n. Gateway peer key exchange (C-04, C-68, C-89)

Dedicated port on the private mesh (TLS 1.3, per-node mTLS), protocol `scf-keyx/1`, JSON messages over a single
request/response. Three key kinds, all 32 random bytes, all memory-only:

| `kind` | Key | `id` | Rotation | Held |
|---|---|---|---|---|
| `day` | `K_day` (visitor surrogate, ADR-0007) | UTC date `YYYY-MM-DD` | daily at 00:00 UTC | current and next |
| `mult` | `K_mult` (multiplicity cells, §b.4) | UTC date `YYYY-MM-DD` | daily at 00:00 UTC | current and next |
| `chal` | `K_chal` (challenge tokens, §b.1) | hour epoch `floor(unix/3600)` | hourly | current, previous and next |

- `GET /keyx/v1/keys` → `{"node_id":"edge-a1","keys":[{"kind":"day","id":"2026-11-12","key":"<b64u 32 B>","fp":"<hex sha256(key)>"},
  {"kind":"mult","id":"2026-11-12","key":"…","fp":"…"},{"kind":"chal","id":"494574","key":"…","fp":"…"}]}`.
- `POST /keyx/v1/push` with the same body (the generator pushes to peers).
- Start-up: ask every peer; adopt their keys; if none answers and no peer is known alive, generate all three.
- At 23:50 UTC the live node with the lowest node id generates the next day's `day` and `mult` keys and pushes them;
  nodes missing them pull at 23:55; all switch at 00:00 UTC by time of receipt. Challenge keys: generated at hh:50 for
  the next hour the same way.
- Conflict (two keys for one `kind` and `id` after a partition): keep the key with the smaller `fp`; count and alert;
  for `day` that day's uniques are over-counted, for `mult` multiplicity cells restart.
- Liveness from this exchange is also the gateway's count of **live edge nodes** for the rate-limit and quota shares
  (§a.6, C-90).
- Keys live in locked memory (`mlock`), core dumps disabled; never logged, never written to disk.

## o. Probe canary events (C-76, C-78, C-43)

Probes (`mon-c`, `probe-d` and the edge nodes' cross-provider probes, C-30) behave like the pinned tracker (`standard`
build, challenge + proof) and post canary page views for the **canary site** of a canary tenant (data-model §8.3,
`is_canary`, `path_folding = relaxed`, `visitor_id = on`). Canary data is excluded from every tenant and SCF-operator
aggregate unless named, and its volume is published.

| Probe | Every | Target | Canary path (`u`) |
|---|---|---|---|
| Availability round (the SLI) | 30 s per source | ingest hostname A, then B on failure (one retry), as the tracker does | `/canary/<source>/round` |
| Per-hostname | 30 s per source | each ingest hostname, no fallback | `/canary/<source>/host-<a\|b>` |
| Per-node | 30 s per source | each edge node's own hostname (ADR-0005), no fallback | `/canary/<source>/<node_id>` |

`<source>` ∈ `mon-c`, `probe-d`, `edge-a1`, `edge-a2`, `edge-b1`, `edge-b2`. A round is good when the canary is
answered `202` within 2 s (C-78); rounds for which fewer than two sources reported are "unknown", excluded from both
counts and published. Dashboard journeys run every 60 s from the same sources (C-93) and are not canary events.

**Known hourly count** (C-76). Each probe exports `scf_probe_canary_accepted_total{source, path}` (count of `202`
answers) to Prometheus on `mon-c`. Job `durability_reconcile` reads, over the private mesh, the hourly increase per
`(source, path)` and compares it with Umami's page views for that path and hour on the canary site's main website
(R4 `type=path`, unfiltered — every canary is counted whatever its verdict). Each source gives one
`durability_reports` row per day (`subject = canary:<source>`), with the hourly differences in `details`. Canary
events sent within the last 72 hours of the window are re-checked the next day, so delivery delays are not counted
as loss.

## p. On-chain reader output (C-42, CR-39, C-132) and the ledger-file fetcher (C-136)

**Source order (C-135/C-136; reverses ADR-0028):** public ledger files are the **primary** source,
Hubble/BigQuery the secondary one (not built). A complete `ledger_files` day replaces a `hubble` row of the same
contract and day; a `hubble` row never replaces a `ledger_files` row.

`/services/onchain-reader` (Go; built into the jobs image as `/usr/local/bin/onchain-reader`) is run by job
`onchain_correlation` for the primary data source (`ledger_files`). It reads public Stellar ledger data files (Galexie
`LedgerCloseMetaBatch`, zstd) from a local mirror for the UTC days `-from-day`…`-to-day`, takes the contracts to count
from `-contract C…` (repeatable) or `-contracts FILE`, where **`-contracts -` reads them from stdin** (how the jobs
service passes them: one strkey per line, `#` comments and blank lines ignored), and writes **JSON Lines to stdout** —
one line per requested contract and per UTC day seen in the files, including days without invocations, sorted by day,
then contract — plus a one-line summary with counts only on stderr. It needs no port, database or network.

Exit codes: **`0`** success; **`1`** failure with no usable output (a file or ledger could not be read, or a
transaction result matched no envelope — wrong `-network` passphrase); **`2`** usage error. The job stores nothing from
a run that did not exit `0`.

The JSON names are the `scf.onchain_daily` columns. The reader never sees tenant ids and never outputs account
addresses (invoker keys are held in memory for one run only, to count distinct values).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://<domain-a>/schemas/onchain-reader-line-3.json",
  "type": "object", "additionalProperties": false,
  "required": ["contract", "day", "invocations", "successful_invocations", "distinct_invokers", "data_source",
               "ledgers_in_day", "ledger_first", "ledger_last", "complete", "anchor_ledger", "anchor_hash"],
  "properties": {
    "contract": { "type": "string", "pattern": "^C[A-Z2-7]{55}$", "description": "contract strkey; the job maps it to contract_ref" },
    "day": { "type": "string", "format": "date", "description": "UTC day" },
    "invocations": { "type": "integer", "minimum": 0, "description": "top-level InvokeHostFunction/InvokeContract operations on the contract" },
    "successful_invocations": { "type": "integer", "minimum": 0, "description": "of those, in successful transactions (fee bumps judged by the inner result)" },
    "distinct_invokers": { "type": "integer", "minimum": 0, "description": "count only (operation source, else transaction source); a lower bound of end users" },
    "data_source": { "const": "ledger_files" },
    "ledgers_in_day": { "type": "integer", "minimum": 0, "description": "distinct ledgers of that day that were read" },
    "ledger_first": { "type": "integer", "minimum": 0 },
    "ledger_last": { "type": "integer", "minimum": 0 },
    "complete": { "type": "boolean", "description": "the day's ledgers are contiguous and the neighbouring days' boundary ledgers were seen" },
    "anchor_ledger": { "type": ["integer", "null"], "minimum": 0, "description": "ledger_last + 1 (the first ledger after the day) when complete; else null" },
    "anchor_hash": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$", "description": "that ledger's hash (hex) when complete; else null" }
  }
}
```

Example line:

```json
{"contract":"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","day":"2026-11-10","invocations":2,"successful_invocations":2,"distinct_invokers":2,"data_source":"ledger_files","ledgers_in_day":17280,"ledger_first":65408000,"ledger_last":65425279,"complete":true,"anchor_ledger":65425280,"anchor_hash":"07b759d78a73dbca17de63d0b0a3117c1467ddfe33a8e40c3b65e1644286aeaa"}
```

Job `onchain_correlation` maps `contract` to the verified declared contracts of opted-in tenants and upserts only lines
with `complete: true` into `onchain_daily` under each tenant's context (data-model §6.3); a complete line replaces a
`hubble` row (C-136).

**Day anchor (C-144 open item, closed by C-150).** Every ledger is checked against its own header and chained to its
predecessor, which a store serving a whole forged but self-consistent chain would still pass. A complete line
therefore names `anchor_ledger` (= `ledger_last` + 1) and `anchor_hash` (that ledger's hash, 64 lowercase hex); through
the verified chain this one hash commits to every header, transaction set and result set of the day. Both are `null`
on an incomplete line; a line where they disagree with `complete` is invalid output. Before the job uses a complete day
it compares `anchor_hash` with Horizon `GET /ledgers/{anchor_ledger}` `hash` (`SCF_ONCHAIN_HORIZON_URL`, default
`SCF_HORIZON_URL`): a mismatch refuses the day and fails the run (`OnchainLedgerAnchorMismatch`); a Horizon that cannot
answer leaves the day unused and retried. Only on testnet may `SCF_ONCHAIN_LEDGER_HASH_CHECK=off` skip the check (the
synthetic development lake). The two fields are required, so the line schema is version 3.

**The contract list** (how the reader gets it): the job reads, under each tenant's context, `declared_contracts` with
`status = 'verified'`, `removed_at IS NULL`, **`conflict_since IS NULL`** (C-137: a contract verified for two tenants
is counted for neither until an operator resolves it, data-model §12.1) and `network` = `SCF_STELLAR_NETWORK` of
tenants with `onchain_correlation_enabled` that are not removed — the **verified contracts of the Registered
Footprint**; `claimed` and `rejected` items are never counted — de-duplicates the strkeys and writes them to the
reader's stdin (`-contracts -`). **Footprint accounts and WASM hashes: a later release, not counted until then** (C-137);
when they are, an instance of a verified WASM hash counts only if a verified deployer account or factory
contract of the tenant created it.

### p.1 Ledger-file fetcher (C-136)

`onchain-reader fetch` fills the local mirror the reader counts from, so the pipeline runs without an operator copying
files. Inputs: `-source URL` (`SCF_ONCHAIN_LEDGER_SOURCE_URL`: the root of a public Galexie ledger-data store, SEP-54
layout — verified 2026-11-16: AWS Open Data `https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/pubnet`
(mainnet from genesis, one ledger per file, anonymous HTTPS, not requester-pays; testnet under
`…/ledgers/testnet/<reset-date>/`, one directory per reset) and Lightsail `https://galexie.lightsail.network/v1`
(mainnet only, eight ledgers per file, rate-limited); default AWS), `-dest DIR`
(`SCF_ONCHAIN_LEDGER_DIR`), `-from-day`/`-to-day` (UTC), `-network` (passphrase). It reads the store's config file
(ledgers per file, files per partition, compression), downloads only the files covering the requested days that are
not yet in the mirror, writes each atomically (temporary name, fsync, rename) and checks it decodes as a
`LedgerCloseMetaBatch` of the expected ledger range for the network. HTTPS only, no credentials, no tenant data in
any request (the fetcher never sees contract ids), bounded parallelism and retries. Exit codes as the reader's:
`0` all requested days present, `1` failure (a day could not be fetched or decoded — the counting run then stores
nothing for incomplete days), `2` usage error. Job `onchain_correlation` runs `fetch` for D−1 (and missing days of
the last 7) before counting; egress per C-10 to the configured store only. The mirror keeps
`SCF_ONCHAIN_LEDGER_KEEP_DAYS` (default 7) days. No new `onchain_daily` columns (CAP-67 metrics come later).
Builder notes from the facts check of 2026-11-16 (C-137): keys are by ledger sequence, not date — find a day's range
from the AWS object metadata (`x-amz-meta-start-ledger-close-time`) or by decoding, with a binary search on the day
boundaries; read `.config.json` (`ledgersPerBatch`, `batchesPerPartition`, `compression`, `networkPassphrase`) and
derive every key from it (the two mainnet stores differ); a store without `.config.json` (pre-v23, `.xdr.zstd`) is an
error (exit 1) unless explicit flags are given; check the config's passphrase against `-network`; about 3 GB and
17,000 objects per day from AWS, so bounded parallelism with backoff and a mirror disk of about 20 GB for 7 days.

As built (C-138; `services/onchain-reader/internal/fetch`, `services/jobs/src/jobs/onchain-correlation.ts`):
- **Boundary ledgers.** For each requested day the fetcher also downloads the last ledger of the day before and the
  first ledger of the day after, so the reader can mark the day `complete` (§p schema); those neighbours are fetched
  even when their own days are not requested.
- **Pruning.** At the end of every run the fetcher deletes mirror files of days older than
  `SCF_ONCHAIN_LEDGER_KEEP_DAYS` (default 7) before today; it never deletes a file of a requested day or its
  boundary ledgers.
- **Window.** Job `onchain_correlation` reads the last `SCF_ONCHAIN_LOOKBACK_DAYS` days (default **3**, 1–30) before
  today, not 7: a day is fetched and counted only while some target contract still lacks a `ledger_files` row for it,
  and a run that leaves the oldest day of the window missing fails (it would never be retried).
- **Testnet store.** `SCF_ONCHAIN_LEDGER_SOURCE_URL` may name the **parent** of the per-reset testnet stores
  (`…/v1.1/stellar/ledgers/testnet`): the fetcher then uses the **newest** `<reset-date>/` store, so the configured
  URL survives a reset. A mirror filled from an older store is refused loudly (the store moved: empty the mirror or
  use another `-dest`), never mixed with the new network's ledgers.

## Design choices made in this document

1. Tracker uses `text/plain` JSON bodies (no CORS preflight); CORS headers only for declared domains; page host from
   `Origin`.
2. Body limit 8 KiB, ≤ 10 events; name ≤ 50; ≤ 10 props, keys `^[a-z][a-z0-9_]{0,31}$`, string values ≤ 100.
3. Per-event id 128-bit `b64u`; retries reuse ids; 10-minute in-memory de-dup per node.
4. Strict profile sends only path + events + token/proof; no titles in any profile (C-89).
5. Width classes s/m/l/x mapped to fixed representative `screen` strings for Umami's device logic.
6. `202` also for suspended/pending tenants and GPC/DNT (counted); `404` for unknown keys and for sites not in the
   snapshot; `400` (`too_large`) for oversize; two `429` bodies (`rate_limited`, `quota_exceeded`).
7. Challenge token 92 bytes binary (layout §b.1) incl. `issued_ms` for the PoW latency signal and the site's profile;
   `site_ref` = hash of the site key so no internal id leaves the server.
8. Hourly `K_chal` and daily `K_mult` distributed like `K_day`; unknown challenge epoch → `suspect`.
9. PoW: PBKDF2-SHA-256 deterministic counter search with 4-byte prefix; `proof_invalid` is a reject reason.
10. `rejected` reasons include `tenant_pending`/`tenant_suspended` for web; OTLP uses `403` for them.
11. Multiplicity counted per page load (first event of a nonce), keyed by HMAC under `K_mult`, exact set → HLL p = 10,
    200,000-cell cap; event-count variant for sites without identifiers.
12. Wallets Kit presence as the page-view field `wk`, counted and stripped at the gateway.
13. Unidentified events: random surrogate per event, twin website, `x-scf-visit: none`; tags `v`/`s` only.
14. Synthetic UA template table with a contract test against Umami's parser and `isbot`.
15. Core chosen by rendezvous hashing of the surrogate; engine proxy map of `{token, last_event_ts}`, 500,000 entries
    per core, 30-min idle TTL as a memory bound, emptied at 00:00 UTC; the 30-minute visit rule on event timestamps
    (`|Δ| ≤ 1800 s`, C-99); `cache`, `sessionId` and `visitId` removed from responses to edges; token purge on website
    deletion on every core through `DELETE /internal/v1/visit-tokens/websites/{id}` plus a 72-hour in-memory list of
    deleted websites.
16. Spool framing (length, CRC-32C, JSON), 16 MiB / 60 s segments, ack bitmaps; each event record carries
    `segment` and `offset`; local disk only.
17. Counter records per node per minute carry web counters, OTLP rejections, token last-use and spool accounting.
18. Edge snapshot envelope (Ed25519 over exact payload bytes, two pinned `kid`s, 32 MiB cap); a node with no snapshot
    refuses ingest; sites carry twin id, rate limit, quota and `over_quota`.
19. OTLP limits 4 MiB compressed / 16 MiB decompressed; `403` for pending/suspended tenants; `x-scf-received-at` is the
    time-bound reference.
20. Collector metadata headers `x-scf-tenant-id`, `x-scf-token-id`, `x-scf-allowed-services`, `x-scf-tenant-level`,
    `x-scf-received-at`, `x-scf-node`.
21. Legacy `http.server.duration` keeps its name (own stream group) but is converted to seconds in `scfsanitize`.
22. Drops inside the Collector are reported as the synthetic metric `scf.ingest.dropped`.
23. Batch key = SHA-256 of the decompressed body; writer answers `200` for duplicates.
24. Scope-priority list for stream-group tie-breaks (§g.5).
25. `metrics_endpoint` at `/public/v1/projects/{slug}/metrics.json` with verified/raw page views and visitors,
    `visit_metrics` once, exact values; `404` when not readable or the tenant is not `active`.
26. Health status derivation rules (§i.2) with per-hostname and per-node lists.
27. Traction snapshots signed over RFC 8785 JCS; keys as JWKS under `/.well-known/scf-snapshot-keys.json`.
28. Umami per-tenant global role **`view-only`** + team role `team-view-only` (C-99; S-01 verified that this
    combination reads its team's websites and nothing else, while role `user` can create websites and teams); key
    rotation through the tenant user's own session.
29. Key `secret` = 27 base62 chars (160 bits), `crc` 6 chars; invitation code prefix `scfi_`; pepper version stored,
    not encoded in the key.
30. Audit anchor file format and optional `manage_data` anchor.
31. Canary paths per source, hostname and node; probe-side counts read from Prometheus by `durability_reconcile`.
32. On-chain reader writes JSON Lines with exit codes 0/1/2.
33. Gateway → Collector forwards only content headers and its own `x-scf-*` headers (C-107).
34. Collector → writers through one DNS name with two address records, SAN on both writer certificates, writer closes
    its listener without a database (C-107).
35. Stream identity falls back to `start_time_unix_nano` when `service.instance.id` is absent (C-105); the
    connector's scope name is stored as `scf/signal_to_metrics`.
36. Live window split at a UTC midnight, plus "the last 24 hours are always live"; rollup parts in whole UTC days
    (`400 validation_failed` otherwise); multi-day visitors are the exact sum of daily uniques (C-109, C-110).
37. Bootstrap B1–B5 replaces the seed admin by a provisioning admin before anything else may call Umami (C-99,
    C-104); restartable from SOPS passwords, and the engine proxy opens its other allow-lists only after forwarding a
    B5 check that Umami answered `401` (C-112(7)).
38. Writer failure classes: `count_overflow` (pre-upsert int4 check), `tenant_write_error` (non-transient SQL error,
    tenant rolled back, `200`), connection loss (only retryable case) (C-112(1)).
39. Collector-queue cap by receipt age: `scf.received_at_unix_nano` stamped by `scfsanitize`, writer drops > 72 h as
    `undeliverable_72h` (C-112(8)).
40. Live reads bounded by a 5 s timeout per Umami call with rollup fallback (`source: rollup`, `partial_today`); time
    series visit metrics for `unit=day|month` only; comparison ranges composed by the same rules or `null` with
    `comparison_unavailable` (C-112(4)–(6)).
41. The engine-proxy visit rule always stores the returned `cache`; token purge on every core before P9; one deny-list
    in §c.5 (C-112(9), C-112(11)).
42. Build decisions (C-113): node certificates carry one role OU and the node name as CN, the proxy passes the
    CN as `X-Scf-Edge-Node`; the proxy keeps the current visit's token against backlog events, runs its own B5 probe and
    validates `/api/send`; P13 existence lookups before deletes; R2 `unit` is `hour` or `day` only; `edge_snapshot` runs
    in the control-plane process; counter records idempotent per (record, tenant) part; `scfsanitize` stamps
    `scf.stream.instance`, drops the raw `http.route`, canonicalises method and status, merges identical points and has
    fail-closed metadata fallbacks.

43. Revision C-136: Stellar event schema v1 as `wl` + `sv: 1` with closed enums and a legacy mapping (§a.3.1);
    `tx_submitted` counted, never forwarded (D5); per-day property counts through the counter record into
    `web_event_property_daily`; dev/preview origins as a never-counted `dev` class with a 24-hour, 100-event buffer
    and a time-boxed `X-Scf-Debug` header (§a.8); traction snapshot v2 with presets, weekly series, coverage,
    confidence, on-chain counts, open anomaly-flag counts, seal reference and signed pasteable text, plus a public
    append-only list (§i.3); a daily `MEMO_HASH` seal over an RFC 9162 tree with salted snapshot leaves, chained by a
    leaf holding the previous root, submitted as a `BUMP_SEQUENCE` no-op (§m.2); ledger files primary with an
    in-reader fetcher (§p.1).
44. Review of the C-136 contracts (C-137): seal head path, provisional leaves, gap-free chain, every missing day
    built, testnet-reset segments, lookup sources and known-answer vectors (§m.2); counter-record parts behind a
    snapshot capability flag with a strip-and-retry fallback (§d.3, §e.3); a dev origin learns only `class=dev`
    outside debug mode, pays the per-subnet limit and gets tokens valid on dev batches only (§a.8, §b.1); signing,
    smart-wallet and passkey events counted only (§a.3.1); snapshot `series` (§i.3.2); cohort small-count floor
    (§i.4); footprint conflicts never counted (§p).

## Open points

1. **Closed (S-01, C-99): Umami behaviour this contract pins.** `tag=v` / unfiltered work on R1–R4; the key header
   is `Authorization: Bearer umami_…`; response shapes verified (with numeric strings in R4); cache-token replay
   works but keeps a visit open for ever, so the engine proxy enforces the 30-minute rule (§c.5); P5/P6/P10 verified;
   role `view-only` instead of `user`; `endAt` inclusive.
2. **Open: privacy-notice wording for discarded fields.** A site switched to `strict` while pages still embed the
   `standard` file keeps sending `sg`/`r`/`w`/`l`/`wk`, which the gateway discards and counts. The notice must say
   such fields are discarded server-side, not "not collected". *Closed by counsel review of the notice text.*
3. **Closed (S-04, C-107): Collector failover between two writers.** Not the `failover` connector; one `otlp_http`
   exporter with a name resolving to both writers (§g.1). Still to verify in the build: the same with mTLS and the
   real mesh DNS, and the writer closing its listener (S-04 open issues).
4. **Open: starting values** for the engine-proxy map size (500,000), the multiplicity cell cap (200,000) and the
   event-count thresholds. *Closed by the 10× load test and the bot simulations (ADR-0026).*
5. **Open: strict profile and L4 signals.** With no client booleans, hidden-tab and automation inflation on strict
   sites is detectable only by L6/L7. *Closed when the threat model states it (threat-model owner).*
6. **Closed (C-112(6)): Umami's own UI and long ranges.** The UI stays internal behind the engine proxy, and
   `umami_app` has `statement_timeout = 30s` (data-model §16.1), so no Umami query — from the UI or a live read — can
   load the shared database for longer; live reads also have the adapter's 5 s timeout (§j.3).

## Validation

**Executed** (Python 3 `jsonschema` 4.19.2 in a scratch directory outside the repository): every JSON block that has
a `$schema` key was checked against the draft 2020-12 metaschema (`Draft202012Validator.check_schema`), and every
example block was validated against its schema with format checking on (event batches → §a.3; event and counter
records → §d.2, §d.3; metrics document → §i.1; health → §i.2; on-chain line → §p). **Read only:** the HTTP, header
and binary layouts, the algorithms of §b.4 and §d.4, the snapshot envelope and key-exchange messages, the traction
snapshot and audit-anchor examples (no schema is published for them). **Measured by the spikes** (C-99 …
C-109): Umami behaviour of §c and §j (S-01, S-02, S-11), the tracker and PoW of §a/§b (tracker build, S-07), the
Collector pipeline, metadata, queue and failover of §f/§g (S-04), SDK payloads (S-06a/b), geo (S-12). Not yet
re-validated after this revision: the JSON Schemas are unchanged except descriptions.

**C-136 (2026-11-16).** Re-run with the same validator: all 10 published schemas (event batch with `$defs/stellar`,
counter record with `props`/`dev`, edge snapshot with `dev_origins`/`debug_until`, `traction-snapshot-2`, and the
unchanged ones) pass the 2020-12 metaschema; the 8 examples validate (including the new v1 Stellar batch); a counter
record with `props` and `dev`, a complete v2 snapshot, and three negative cases (a v1 event with a legacy `wid`, a
legacy-shaped event with a v1 field, a dev path with whitespace) were checked as well. Not executed: the Merkle
construction and proof of §m.2 (to be pinned by test vectors in the jobs build), the `X-Scf-Debug` grammar, the text
template of §i.3.4.

**C-137 (2026-11-16).** After the architecture review: the changed schemas (snapshot v2 with `series`, edge snapshot
with `counter_features`) were re-checked against the 2020-12 metaschema with the same validator and the examples
re-validated (results in the C-137 entry of the design-decision log). The Merkle construction of §m.2 is now pinned and executed:
`node docs/contracts/vectors/seal-vectors.mts --check` reproduces the RFC 6962 reference roots for 1–8 leaves,
verifies every inclusion path of 2–9-leaf trees with the RFC 9162 §2.1.3.2 algorithm and recomputes every head path.
Still not executed: the `X-Scf-Debug` grammar and the text template of §i.3.4.
