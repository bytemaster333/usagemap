# Gateway — web ingest path

The only public entry of an edge node: serves the pinned tracker files, issues challenges, accepts events, decides
`verified` / `suspect` / `rejected`, spools accepted events with fsync, and forwards them to Umami through a core's
engine proxy. Contracts: `docs/contracts/wire-formats.md` §a (protocol v1), §b (challenge, PoW, multiplicity),
§c (forwarder), §d (spool), §e (snapshot), §h (verdicts), §l (counter upload), §n (key exchange), §o (probes).
The OTLP front door (§f) is in `internal/otlp`.

Go, standard library first. Dependencies: `github.com/oschwald/maxminddb-golang/v2` v2.9.0 (ISC), `golang.org/x/sys`
v0.49.0 (BSD-3-Clause), `packages/pathnorm` (ours). Data: DB-IP IP to Country Lite 2026-11 (CC BY 4.0, attribution
in `NOTICE`), baked into the image by SHA-256.

## Binaries

| Binary | What |
|---|---|
| `gateway` | the service; `gateway healthcheck` (container health), `gateway templates` (synthetic UA table as JSON) |
| `probe` | protocol-level canary client (C-78, §o): challenge → PoW → page view; `-interval` + `-metrics` export `scf_probe_canary_accepted_total{source,path}`; library in `pkg/probe` for the health controller |
| `rangelist-updater` | weekly fetch of cloud / Private Relay / Tor-exit (/ VPN, configurable) range lists into `GW_RANGELISTS_DIR` (C-38); per-source SHA-256 logged; failed fetch keeps the previous list; the lists are never in an image. Scheduled form: one long-running process per edge node, `rangelist-updater -dir /var/lib/scf-rangelists -interval 168h` (same image, entrypoint `/usr/local/bin/rangelist-updater`, egress through `HTTPS_PROXY`, the range-list volume mounted read-write here and read-only into the gateway, which re-reads it every minute — no signal needed). Exit codes in once mode (`-interval 0`): 0 at least one source fetched, 1 all failed, 2 bad configuration |

## Processing order (§a.6)

1. size ≤ 8 KiB, closed JSON schema (`400 malformed`/`too_large`); site from the snapshot (`404`), withdrawn tracker
   version (`410`), node without snapshot or draining (`503`) — the `404` and early `503`s carry CORS so the tracker
   can read them; site `over_quota`, **or this node's share of the tenant's daily verified quota used up** → `429
   quota_exceeded` for every batch of the tenant, decided before any verdict (no verdict oracle).
2. per-(site, /24|/48) limit first — `web_requests_per_min_subnet`, capped at a quarter of the node's site share (at
   least 10/min), so one subnet can never spend the whole site budget — then the site budget: batches with a token
   this node verifies spend the per-site share (`429 rate_limited`); batches without one (missing, forged, expired,
   unverifiable) spend a separate per-site budget of the same size and, beyond it, are dropped silently (`202`,
   counted `drop/rate_limited`). The same two limits apply to `/v1/c` (own budgets). `Sec-GPC: 1` / `DNT: 1` → `202`,
   dropped, counted.
3. surrogate `2001:db8::/32` = HMAC(K_day, site ‖ full IP ‖ raw UA); country from DB-IP Lite on the truncated
   address (`XX` when unknown); network class from the range lists (full address, in memory); UA reduced to
   family/major/OS/device and replaced by a synthetic template; Umami's `isbot` list on the raw UA; multiplicity keys;
   the UA's browser engine against the connection's transport fingerprint (`transport_mismatch`, below). The raw IP
   and UA are then dropped.
4. `exclude_countries` → dropped, counted. 5. `visitor_id = off`/`off_in` → random surrogate, twin website.
6. multiplicity cell update (first event of a challenge nonce = one page load). 7. verdict (§h), path through
   `pathnorm` (`full`/`relaxed`), property guard (pathnorm's secret and personal-identifier detectors on the whole
   value, each word of it and each phone-shaped run: seeds, JWTs, API keys, e-mail, federation addresses, phone
   numbers, IP literals), profile stripping, `wk` counted and stripped → spool record (with the event key) →
   **fsync → `202`** (whatever the verdict). A batch with nothing to spool (all rejected or dropped) waits for the
   same group commit (and about as long as a data commit), and gets `503` too when the spool is not durable.

**Duplicates and idempotent delivery.** The tracker sends one random id per action and resends the same
body on every retry, on either host (also after its 3 s abort). The gateway drops an id repeated inside a batch or
seen on this node in the last 10 minutes (`drop/duplicate_event_id`). Every spooled event carries `event_key` = hex
of SHA-256("scf-evk1" ‖ site ‖ event id)[0..16] (never the id); unidentified events take their surrogate from
SHA-256("scf-unid1" ‖ site ‖ event id), so both copies of an event reach the same core; the forwarder sends the key
as `x-scf-event-key` and the engine proxy forwards only the first copy within its window (1 h). Not recognised:
copies split by a core failover or an engine-proxy restart, copies further apart than the window (stated).

**Rate anomaly.** The per-site rate history counts only events that can still be verified (no batch-level rejection,
proof solved), so posted junk never marks a site's genuine visitors `rate_anomaly`.

**Spool.** One site may hold at most `GW_SPOOL_SITE_SHARE_BYTES` of undelivered events (beyond it that site gets
`503`, others are unaffected), and the forwarder lets one site occupy at most three quarters of its workers (the rest
park and follow). Recovery keeps every readable frame: a damaged frame in the middle of a segment is skipped (counted
in `scf_gateway_spool_corrupt_frames`/`…_corrupt_bytes`, **alert on > 0**); only a torn tail of the newest segment is
truncated. An acknowledgement whose fsync fails is rolled back and retried.

**Transport fingerprint (C-124, `internal/transport`).** The public listener terminates TLS itself
(`transport.Listener`, not `net/http`): per connection it keeps, in memory only, a JA4 fingerprint of the ClientHello
and, on HTTP/2, the connection preface (SETTINGS, WINDOW_UPDATE, PRIORITY, pseudo-header order of the first request;
≤ 16 KiB inspected). `net/http` then serves the decrypted stream as HTTP/1.1 or HTTP/2 with prior knowledge (ALPN
`h2`), so OTLP/gRPC works unchanged. Rule set `scf-transport/1` classifies the hello as `chromium` (GREASE + ALPS),
`apple` (GREASE, no ALPS), `gecko` (`record_size_limit`) or `library`, and `transport_mismatch` (suspect, never
rejected) is added when the UA claims another engine, offers no `h2` first, or (HTTP/2) uses another engine's
pseudo-header order. Nothing of it is logged; metrics carry family labels only. Observed fingerprints of real clients:
`go test ./internal/transport -run TestRealClients -v` (Go, curl, Python, Node fetch/http2, Playwright Chromium and
Firefox; `SCF_TRANSPORT_OBSERVED=<file>` writes them as JSON, `SCF_TRANSPORT_REQUIRE_ALL=1` fails on a missing client).

**Multiplicity (C-124).** `unknown` addresses use `max(T[unknown], T[eyeball_mobile])`; `multiplicity_mode`
(`settings.multiplicity_mode`, per-site `sites[].multiplicity_mode`, default `enforce`) in `shadow` counts would-be
flags as `multiplicity/high_shadow` without adding the reason.

**K_day after a restart (C-04, C-124).** Keys are memory-only. A gateway that starts without a live peer generates
today's `K_day` itself, which re-keys the rest of the day (visitors before and after are counted twice): counted in
`scf_gateway_kday_regenerated_total` (+ a warning log line without key material), alert `KDayRegenerated`. On the
single-VM profile (C-123) that is every restart, accepted and annotated. A rolling deploy avoids it wherever a
second gateway can run beside the first with the key exchange configured (multi-node overlay; `GW_KEYX_ADDR`,
`GW_KEYX_PEERS`, an edge certificate each): start the new node, wait until `scf_gateway_keys_current` = 1 and
`scf_gateway_kday_fingerprint_info` matches the old node's, move traffic, then stop the old one.

**Snapshot hard expiry (§e.4).** `expires_at` (optional) + 5 min grace: past it, `/v1/c`, `/v1/e` and OTLP answer
`503 snapshot_expired` (`Retry-After: 30`); polling, forwarding and `/healthz` continue; a newer valid snapshot
re-opens ingest; an expired `snapshot.json` at boot counts as none. Gauges `scf_gateway_snapshot_expires_in_seconds`,
`scf_gateway_snapshot_expired`. **Tokens across a restart:** a bad MAC under a `K_chal` this node generated itself
after the token's claimed issue time is `challenge_unverifiable` (suspect), not `challenge_invalid` (§b.3, C-124).

**Stellar event schema v1 (§a.3.1, C-136, C-137; `internal/ingest/stellar.go`).** A `wl` event with `sv: 1` is
checked against the closed v1 lists; one without `sv` is a legacy ADR-0029 event and is mapped to v1 (names, `wid` →
`wt` aliases, `net` `public` → `mainnet`, `err` → `ec`). Fields not placed for the event are discarded and counted
(`drop/profile_field_stripped`); a missing `wt`/`net` is recorded as `unknown`. Every accepted (`verified`/`suspect`)
wallet event adds its property cells (`_total`/`all` + one per property, keyed by event, network and verdict) to the
counter record's `props`. **Counted-only events** — `sign_requested`, `sign_approved`, `sign_rejected`,
`tx_submitted`, `smart_wallet_created`, `passkey_used` — produce `props` rows and nothing else: no spool record, no
Umami forward, no web counter, not counted against the quota. The other wallet events are forwarded under their v1
name with `data` keyed by the rollup keys (`wallet`, `network`, `connect_kind`, `outcome`).

**Dev origins and debug mode (§a.8, C-136, C-137).** A request whose `Origin` (fallback `Referer`) matches one of the
site's `dev_origins` (`localhost`/`127.0.0.1` on any port and scheme; an exact host or a one-`*` leftmost-label
pattern on `https:443`) and whose host is not a declared domain is a **dev** request. `/v1/c` issues it a token with
the dev bit (`prof` 0x02) under the same per-subnet limit and adaptive proof cost; such a token is
`rejected/challenge_invalid` on any non-dev batch, as is any unknown `prof` bit. A dev batch pays the per-subnet
limit (a dev `429` is not counted), then `dev_events_per_min_site` (default 120; beyond it dropped silently); each
event's would-be verdict is computed in memory (no `origin_mismatch`/`domain_unverified`, no rate-history,
difficulty, nonce, multiplicity, event-id, per-site rate or quota state) and reported only in the counter record's
`dev` array (≤ 20 per site and record: kind, name, `full`-folded path, time, would-be verdict, worst reason). Never
spooled, forwarded or counted; always `202`. `X-Scf-Debug` outside debug mode is exactly
`v=1; class=dev; reasons=dev_origin[,dev_rate_limited]` on dev requests and absent otherwise; while `debug_until` is in
the future every answer of the site carries the class and reasons (batch's worst event; `dropped` for GPC/DNT,
duplicates, excluded countries and 429s) and CORS for any origin, with the header exposed.

**Optional counter-record parts (§d.3 upgrade rule).** `props` and `dev` are written only while the current snapshot
lists them in `settings.counter_features` (entries of a part not listed are dropped in memory) and are omitted when
empty. When the control plane answers `400`/`422` to a record carrying them, the forwarder re-sends it once without
them (same `record_id`; logged with the dropped entry counts, `scf_gateway_forward_total{outcome="stripped_retry"}`)
before the discard rule applies.

A missing or malformed `t` is not a schema error: it is `rejected/challenge_missing` and the batch is answered `202`
(a clarification of the wire contract). Counters, de-dup ids and the quota are committed only when a batch is
accepted, so a `429`/`503` followed by the tracker's retry never counts twice.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `GW_NODE_ID` | — | node name, `^[a-z0-9][a-z0-9-]{1,31}$`, = CN of the node certificate |
| `GW_LISTEN_ADDR` | `:8443` | public listener (TLS 1.2+, HTTP/2) |
| `GW_TLS_CERT`, `GW_TLS_KEY` | — | listener certificate (reloaded on `SIGHUP`); `GW_ALLOW_PLAINTEXT=1` only behind a TLS terminator / tests |
| `GW_METRICS_ADDR` | `:9464` | `/metrics`, `/healthz` (internal) |
| `GW_NODE_CERT`, `GW_NODE_KEY`, `GW_CA` | — | edge certificate (OU `edge`) for the cores and the peers |
| `GW_CORES` | — | `core-a=https://engine-proxy:8443,core-b=…` (rendezvous order by surrogate, failover) |
| `GW_SNAPSHOT_KEYS` | — | `kid=/path/pub.pem[,kid2=…]` Ed25519 SPKI public keys (control plane `SCF_EDGE_SIGNING_KID`, default `edge-1`) |
| `GW_SNAPSHOT_INTERVAL` | `30s` | poll interval (± 5 s jitter); 1 s…45 s |
| `GW_KEYX_ADDR`, `GW_KEYX_PEERS` | — | key-exchange listener (mTLS) and peers `edge-a2=https://edge-a2:9443,…` |
| `GW_STATE_DIR` | `/var/lib/scf-gateway` | `snapshot.json` + `spool/<node>/` (a volume) |
| `GW_SPOOL_MAX_BYTES` | 20 GiB | size cap → `503` |
| `GW_SPOOL_SITE_SHARE_BYTES` | a quarter of the cap | undelivered event bytes one site may hold → `503` for that site |
| `GW_OTLP_MAX_INFLIGHT`, `GW_OTLP_MAX_INFLIGHT_TENANT` | `16`, `4` | concurrent OTLP requests per node (`503`) and per tenant (`429`), taken before any body byte is read |
| `GW_GEO_DB`, `GW_GEO_SHA256` | image paths | DB-IP Lite; `database_type` must be `DBIP-Country-Lite` |
| `GW_RANGELISTS_DIR` | `/var/lib/scf-rangelists` | `<class>.txt` from the updater; empty → every address `unknown` |
| `GW_TRACKER_DIR` | `/usr/share/scf-gateway/tracker` | `dist/<semver>/` built in the image; bytes verified against the manifest at start |
| `GW_COUNTER_PERIOD` | `1m` | counter-record period (tests use seconds) |
| `GW_FORWARD_WORKERS` | `16` | concurrent deliveries |
| `GW_REQUIRE_MLOCK` | `1` | refuse to start when key memory cannot be locked |
| `GW_OTLP_ENABLED` | `1` | OTLP front door on the same listener: `POST /v1/metrics`, `/v1/traces` (HTTP), the two gRPC `Export` methods (h2 over TLS); `/v1/logs` → `404`, gRPC logs → `UNIMPLEMENTED` |
| `GW_PEPPER_ING_FILE` | — | file with the `pepper_ing` set, same format as the control plane's `SCF_PEPPER_ING` (`<version>:<base64 ≥ 32 B>`, comma-separated, C-81) |
| `GW_COLLECTOR_HTTP`, `GW_COLLECTOR_GRPC` | `http://127.0.0.1:4318`, `http://127.0.0.1:4317` | the edge node's Collector (gRPC leg is h2c); Compose sets `http://otlp-collector:4318` / `:4317` on the private `otlp` network (C-130) |
| `GW_LOG_LEVEL` | `info` | JSON logs; never an address, UA, header value, path, token or key |

Keys (K_day, K_mult, K_chal) live in one `mlock`ed, `MADV_DONTDUMP` page outside the Go heap; the process sets
`RLIMIT_CORE=0` and `PR_SET_DUMPABLE=0` at start. Nothing key-related is ever written to disk.

## OTLP front door (§f)

`Authorization: Bearer scfa_ing_<id>_<secret><crc>` only: CRC checked offline, token looked up in the snapshot,
HMAC-SHA-256 under `pepper_ing[pepper_version]` compared in constant time, `expires_at`, tenant status (`401`, `403`
pending/suspended; a vendor credential without an SCF token gets a `401` saying so; nothing is logged). Bodies ≤ 4 MiB
compressed and ≤ 16 MiB decompressed (bounded while inflating) → `413`/`RESOURCE_EXHAUSTED` without `RetryInfo`;
per-tenant token buckets (`otlp_requests_per_s`/`otlp_burst`, `otlp_bytes_per_s` on compressed bytes) → `429` +
`Retry-After` / `RESOURCE_EXHAUSTED` + `RetryInfo`; well-formedness check (protobuf wire format, JSON) → `400`;
Collector down, queue full or memory limiter → `503` + `Retry-After` / `UNAVAILABLE`. Forwarded to the Collector:
`Content-Type`, `Content-Encoding` (HTTP) or `content-type`, `te`, `grpc-encoding`, `grpc-accept-encoding`,
`grpc-timeout` (gRPC), plus `x-scf-tenant-id`, `x-scf-token-id`, `x-scf-allowed-services` (`*` or percent-encoded
list; empty list = none allowed), `x-scf-tenant-level` (`L0`…`L3`, C-116; L4 is sent as `L3`), `x-scf-received-at`
(Unix ns), `x-scf-node`. Nothing else — no `Authorization`, `User-Agent`, vendor key or incoming `x-scf-*`.
Rejections are counted per tenant in the counter record's `otlp` array; token use in `tokens`. Order: authentication,
the in-flight bounds (`GW_OTLP_MAX_INFLIGHT[_TENANT]`) and the request rate limit come **before** the body is read or
decompressed, so an over-limit tenant costs no body memory; the byte budget is charged after reading. The `Bearer`
scheme is case-insensitive (RFC 9110). HTTP/2 connections carry at most 100 concurrent streams.

## Metrics (closed label sets)

`scf_gateway_requests_total{route,status}`, `scf_gateway_request_duration_seconds{route}`,
`scf_gateway_events_total{verdict}`, `scf_gateway_reasons_total{reason}`, `scf_gateway_drops_total{label}`,
`scf_gateway_forward_total{kind,outcome,core,error_kind}`, `scf_gateway_snapshot_{sequence,age_seconds,stale}`
(**alert on `stale == 1`**: no fresh snapshot for 15 min), `…_snapshot_rollback_refused_total`,
`…_snapshot_verify_failures{reason}`, `scf_gateway_spool_{events{counter},queued,pending,oldest_age_seconds,bytes,
segments,durable,corrupt_frames,corrupt_bytes}`, `scf_gateway_otlp_inflight_refused_total`, `scf_gateway_keys_{held,mlocked,current}`, `scf_gateway_core_dumps_disabled`,
`scf_gateway_keyx_conflicts{kind}` (alert), `scf_gateway_live_edge_nodes`, `scf_gateway_multiplicity_{cells,evicted}`,
`scf_gateway_rangelist_entries{class}`, `scf_gateway_otlp_requests_total{signal,protocol,status,outcome,reason}`
(outcome `accepted`/`rejected`/`unavailable`; reason `none`, `auth`, `tenant`, `logs`, `schema`, `size`, `rate_limit`,
`unavailable`), `scf_gateway_otlp_collector_errors_total{protocol}`; since C-124: `scf_gateway_spool_max_bytes`,
`scf_gateway_forward_ambiguous_retries_total{core}` (delivered after an attempt that may already have reached Umami:
request written, then a transport error or 500/502/504), `scf_gateway_sites_limited{kind}` (sites answered 429 in the
last hour, counts only), `scf_gateway_kday_regenerated_total`, `scf_gateway_kday_fingerprint_info{fingerprint}`
(16 hex of SHA-256("scf-key-fp/1" ‖ "day" ‖ K_day) — never the key), `scf_gateway_start_time_seconds`,
`scf_gateway_transport_checks_total{claimed,observed,result,why}`, `scf_gateway_multiplicity_flags_total{mode}`.
Alerts: `ops/alerts/edge.rules.yaml`.

## Tests

```sh
eval "$(mise env -s bash)"; cd services/gateway
go test ./...                        # unit + process-level tests (binary vs. fake core over mTLS, kill -9 crash test)
go test -race ./...
SCF_GEO_DB=<dbip-country-lite-2026-11.mmdb> go test ./internal/geo     # against the real DB-IP file
SCF_UMAMI_PARITY=1 go test ./internal/uabot -run Live                    # isbot parity re-run inside the Umami image
go test ./cmd/gateway -run 'TestDevNever|TestUpgrade'  # end to end: dev never counted, counted-only never
                                     # forwarded, dev token refused on production, old control plane (422) upgrade
go test ./cmd/gateway -run OTLP        # gateway → real Collector (built from collector/_build, or SCF_COLLECTOR_BIN) → mTLS writer sink
services/gateway/integration/run.sh  # real stack (project scf-wsb, ports 56200–56202): Chromium → gateway →
                                     # engine proxy → Umami, control plane snapshot + counters, Umami/DB down, privacy scan
services/gateway/integration/upgrade.sh  # real previous image (built from git, PREV_REF/PREV_IMAGE) ↔ current image on
                                     # one state volume: spooled events survive upgrade and rollback, exactly once in
                                     # Umami; tracker 1.0.0 byte-identical (project scf-wsu, ports 56210–56213)
```

`internal/uabot/testdata/gen-parity.sh` regenerates Umami's own `isbot` verdicts for the corpus inside the Umami image.
