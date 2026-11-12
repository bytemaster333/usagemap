# ADR-0005: Web ingest gateway

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** web.frontend-only-privacy-first, web.frontend-origin-only, bot.js-execution-proof, metric.referrers, metric.device, metric.browser, web.adblock-safe-script-name, web.adblock-safe-endpoints, privacy.gdpr-no-consent, enrol.operator-removal, slo.ingest-availability, support.public-issue-tracker

## Context
ADR-0003 keeps Umami off the internet, so something else must be the public web ingest. UsageMap accepts web events
only from frontend code, distinguishes real browser JS from pure server-side posts, reports country-level geography and
device and browser breakdowns, uses neutral endpoint names, and is GDPR-compliant without opt-in; the ingestion
availability target is 99.99 % with no mandatory on-call.

What research established:
- **Umami's `/api/send` must not see client input as-is.** `ip`, `userAgent`, `browser`, `os`, `device` and
  `timestamp` (any integer 0…2147483647, so back-dating to 1970) are accepted from anonymous clients with
  `skipAuth: true` (`route.ts:25`); `id` (distinct id) feeds the session hash, so one client can mint unlimited
  "unique visitors"; `hostname` is only syntax-checked and nothing compares it or `Origin` with the website's domain;
  there is no rate limit; the response returns `sessionId`, `visitId` and a signed cache JWT.
- **Header hygiene is a security control.** With `CLIENT_IP_HEADER` set and present, that header wins over 13 other IP
  headers; if no IP header is present Umami does **not** fall back to the TCP peer and all visitors with one UA
  collapse into one session. Country is read from the first non-empty provider header (`cf-ipcountry` first without
  `CLOUD_MODE`); `payload.ip` disables header geo; an invalid or "local" IP nulls the country.
- **TLS termination matters for detection and draining.** A TLS-client fingerprint (JA4, BSD-3-Clause; JA4+ is
  FoxIO License 1.1, not OSI) needs the raw ClientHello; Caddy has no module for it, Envoy and HAProxy (Lua plugin) do. The design question (Caddy at the edge vs fingerprinting
  vs drain-by-closing-listener) was resolved in favour of the gateway terminating TLS itself. The fingerprint itself is **removed
  from the first release** (C-77; kept as a later option); terminating TLS in the gateway stands for draining,
  certificate control and the shared OTLP front door.
- **Availability needs durable local acceptance.** A 2xx must mean the event is fsync'd on the receiving node; DNS
  failover alone takes 1–5 min for most clients; edges are drained by closing the listener (RST), never by dropping
  packets; no CDN in front of ingest, because it would see visitor IPs and become a single point of failure. Let's Encrypt allows **5 duplicate certificates (identical
  identifier set) per 7 days, no overrides**; four nodes requesting the same names would use four of them, and one
  rebuild drill could lock issuance out for days. Hence one certificate per node that includes the node's own hostname.

## Options considered
1. **Expose Umami's collect route behind a plain reverse proxy (Caddy/nginx) with header rewriting.** Pros: least
   code. Cons: cannot rebuild payloads, compute verdicts or hold in-memory multiplicity state; Umami's Next.js
   server is directly on the request path for every bot.
2. **Envoy or HAProxy at the edge + a small verdict sidecar.** Pros: mature TLS; a TLS fingerprint available natively
   (Envoy) or via a Lua plugin (HAProxy), which no longer matters for the first release (C-77). Cons: two processes and an internal protocol on every node; challenge, PoW,
   multiplicity and spool still need our own service; more to hand over.
3. **A TypeScript/Node gateway.** Pros: shares the tracker's language and types. Cons: no raw ClientHello access
   without native modules; weaker fit for an fsync'd segment log and long-running TLS on minimal images; two runtimes on the edge.
4. **A CDN/edge-worker front (Cloudflare, Fastly, Bunny).** Pros: global anycast, DDoS absorption. Cons: a US or
   third-party processor sees every visitor IP (conflicts with ADR-0017); a provider outage becomes our outage.
5. **One Go binary per edge node that terminates TLS and does everything in process** (chosen). Pros: one static
   binary; TLS, draining and certificates in one place; full control of what reaches disk; the OTLP front door (ADR-0009)
   shares TLS, auth and rate limiting. Cons: we own a security-critical, internet-facing service, including its ACME
   handling and TLS configuration.

## Decision
One Go binary per edge node (`/services/gateway`). It is the only public entry on edge nodes. Public routes (final
names subject to the filter-list check of ADR-0004): `GET /lib/…` (tracker files and signed manifest, compiled into
the binary), `POST /v1/c` (challenge), `POST /v1/e` (events), `GET /healthz`. Schemas and status codes are specified
in `docs/contracts/`.

Per event, in memory:
1. Parse a strict `v1` schema; reject unknown fields; cap sizes. Discard any query string or fragment in the page
   path (C-65). Drop a retry whose random per-event ID was already seen within a 10-minute in-memory window (C-37).
2. Resolve the site from the public site key; check the `Origin`/`Referer` host against the site's verified domains;
   check `Sec-Fetch-*` and client-hint/User-Agent consistency (no TLS fingerprint in the first release, C-77). Header
   combinations a browser cannot produce make the event `rejected` (C-39). Apply the site's per-minute rate limit
   and daily quota from the snapshot: each node enforces its share (limit ÷ number of live edge nodes) locally; a
   site the control plane has marked `over_quota` is refused (C-90). Quotas count verified events only (C-80).
3. Verify the challenge token and proof (ADR-0008); run the upstream `isbot` list — the version pinned by our Umami
   release — on the **raw** User-Agent (C-36); update multiplicity counters (distinct surrogates per truncated subnet;
   for sites with `visitor_id = off`, events per truncated subnet — C-80; algorithm in the wire-formats document,
   C-89).
4. Resolve country and ASN class from the truncated address (ADR-0006); events geolocated to a country in the
   site's `exclude_countries` are dropped here and only counted (C-58). Derive the surrogate address from the **full**
   IP and the **raw** User-Agent (ADR-0007, C-34) — or, where the site's `visitor_id` setting is `off` (or `off_in`
   the visitor's country), a fresh random surrogate for this event, and the event is marked for the site's twin
   Umami website (C-02, C-73). Then **discard the IP**; reduce the
   User-Agent to family + major version + OS + device class, **discard the raw string**.
5. Assign verdict `verified` / `suspect` / `rejected` with reason codes (ADR-0008).
6. Rebuild the record from allow-listed fields only: fields the site's configured tracker profile does not allow are
   discarded (C-37); the page path is passed through the same `pathnorm` rule set as API routes (ADR-0012), so
   identifier-shaped segments become typed placeholders and seeds, tokens, JWTs and e-mail addresses become
   `{redacted}`; custom-event names and property values pass the same server-side guard (C-52). Redaction of secrets
   and personal identifiers cannot be switched off; the per-site folding setting is `full` or `relaxed` (numbers,
   dates and slugs kept; StrKeys, hashes, tokens and e-mail addresses always folded or redacted — C-70, C-89). The
   `v1` schema has no page-title field: **page titles are not collected** (C-89). Append the rebuilt record to the
   fsync'd spool (ADR-0020) with its node ID, segment and offset (C-76) and answer `202`. `rejected` events are not
   spooled. Verdict and reason counters per site and day travel through the spool as **counter records**, which the
   forwarder uploads to the control plane's internal edge endpoint for storage in `scf`; tenants see them on an
   installation-check page (C-39, C-60).

**Responses** (C-39): `202` for every well-formed event whatever its verdict, so the response is not an oracle;
`400` malformed; `404` unknown site key; `410` withdrawn tracker version (ADR-0004, C-37); `429`/`503` with
`Retry-After`. `429` answers caused by a site's rate limit or quota are reported per site (C-80). Rejected events are
outside the availability SLI's denominator (ADR-0031).

**Forwarder:** drains the spool to Umami `POST /api/send` — through the **engine proxy** on the core nodes
(`/services/engine-proxy`, ADR-0003), authenticated by the node's mutual-TLS certificate and allowed that route and
the control plane's internal edge endpoints only (C-60) — with `x-scf-surrogate-ip`, `cf-ipcountry`, a synthetic
reduced User-Agent, `timestamp` = time of receipt, and `tag` ∈ {`v`, `s`} (verified / suspect; C-73), addressed to
the site's main Umami website or, for events without a visitor identifier, its twin (C-73). Client-supplied `ip`,
`userAgent`, `timestamp`, `id` and `hostname` never pass through. **Core choice and visit continuity** (C-74): the
forwarder picks the core by a consistent hash of the surrogate and falls back to the other core on failure; the engine
proxy on that core holds Umami's cache token per (site, surrogate) for 30 minutes, so a visit lasts until 30 minutes
of inactivity whichever edge node handled each event, and splits at most once at a core failover. The edge holds no
cache token. When Umami silently drops an event as a bot (`{"beep":"boop"}`, still `200`), the forwarder treats the
event as delivered and counts it as `engine_bot_drop` (C-69). Spool entries that cannot be delivered for 72 hours are
discarded and counted (C-18). There are no spool copies to object storage (C-77).

**Configuration:** site registry, token hashes, per-site rate limits and daily quotas and the `over_quota` marks
(C-90) come from a **signed snapshot** pulled from the control plane's internal edge endpoint every 30 s (through the
engine proxy, over the same node certificates, C-60) and kept on disk, so ingest continues when the core is down.
Snapshots carry a sequence number and issue time; a node never accepts an older sequence. No fresh snapshot for 15
minutes raises an alert, and the node keeps serving from the last good snapshot (C-62). Edge nodes hold only the
ingest-token pepper (`ing`); the `op` and `pub` peppers never leave the core, and the snapshot-signing key is separate
from all three (C-05, C-81).

**TLS:** the gateway terminates TLS itself (ACME DNS-01 via an embedded library, one certificate per node that
includes the node's own hostname). The edge DNS credential can only write a delegated `_acme-challenge` zone; edge
nodes cannot change service records — only the health controller on `mon-c` and `core-b` can (C-61).

## Consequences
Positive:
- No client-chosen value reaches Umami's session hash, timestamp or hostname; the inflation vectors in Umami's
  collect route are closed at one place, and the header hygiene list becomes testable code.
- The raw IP and raw User-Agent exist only inside one request's memory (privacy.gdpr-no-consent, privacy.minimal-erasure-scope); the spool holds only the
  rebuilt record, with page paths scrubbed by `pathnorm` — a wallet address in a page URL is never stored (C-52).
- Every well-formed event gets the same `202`, so an attacker cannot learn from responses which verdict it earned;
  tenants instead see verdict and reason counts on the installation-check page (C-39).
- Bounce rate (metric.bounce-rate) and duration (metric.session-duration) are not distorted by clock-hour visit splits or by which edge node
  handled an event: the cache token lives on the core the surrogate hashes to (C-74). A visit can split once at a
  core failover or restart; the effect of spool delay on Umami's visit logic is measured in S-01, with the C-82
  fallback if replay does not work.
- Ingest keeps answering while the database, Umami or the control plane is down: the spool buffers and the snapshot
  keeps the site registry; freshness degrades and is reported (ADR-0031). Ingest tokens, site state and tenant
  suspension or removal reach the edge through the same snapshot within 60 s (enrol.operator-removal, ADR-0015, C-06).
- One binary is simple to deploy and hand over; the same process fronts OTLP (ADR-0009).

Negative / risks:
- The gateway is the most security-sensitive code we write: TLS, ACME, parsing untrusted input, keys in memory
  (ADR-0007, ADR-0008). It needs fuzzing of the `v1` parser and the full header-hygiene test list (the
  integration spike's steps A–J) as a regression suite on every Umami bump.
- Because the forwarder sends a synthetic User-Agent, Umami's browser/OS/device breakdowns depend on that string
  being parsed by `detect-browser` and `ua-parser-js` as intended; this is part of S-01.
- `timestamp` = time of receipt means a spool backlog does not shift events in time, but events queued in a browser
  are stamped when they arrive.
- A 30 s snapshot interval bounds how quickly a new site or a revoked token takes effect (≤ 60 s target, ADR-0016).
  **Residual risk:** a node cut off from the core keeps serving from its last good snapshot (availability first), so
  revocations do not reach that node until it reconnects; the 15-minute staleness alert makes this visible (C-62).
- No TLS-client fingerprint in the first release (C-77, S-13 dropped): L4 rests on `Sec-Fetch-*`, client hints and
  the `standard` profile's client booleans, which a scripted client can forge more cheaply.
- No spool copies to object storage (C-77): an event accepted by a node that is permanently lost (disk and all)
  before it forwards is lost. The exposure is that node's undrained backlog — normally seconds, longer only while
  the core is unreachable — and it is stated in the SLA.
- ACME DNS-01 puts a DNS-provider credential on every edge node; it is limited to a delegated `_acme-challenge` zone,
  so a compromised edge node cannot redirect service records (C-61).
- The retry-ID window and the per-node rate-limit share are per node and in memory; a retry that lands on another
  node within 10 minutes can be stored twice, and the daily quota is exact only within about a minute (C-90).

Revisit if: a TLS-client fingerprint is wanted after the first release (C-77; option 2 for TLS only is the fallback if
the Go standard library cannot expose the ClientHello); S-01 shows Umami needs a value we
do not send; load tests (ADR-0026, 10× design target) show the single binary is the bottleneck.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Umami ingest datamodel tracker: collect pipeline, allow-list, routes to block.
- Umami IP geo header integration: header order, local-IP trap, spike steps A–J.
- Bot detection anti inflation: sanitisation, consistency checks, JA4 licence (deferred, C-77).
- SLA availability engineering: SLI, fsync-before-ack, DNS and drain behaviour.
- Ops tooling iac PostgreSQL ha backup: Let's Encrypt rate limits, per-node DNS-01 issuance.
- Research synthesis: gateway terminates TLS.

## Open points
None outstanding. (Umami's silent bot-drop reply is settled by C-69: counted as `engine_bot_drop`; visit continuity
by C-74; rate limits and quotas by C-90.) Still to be proven: S-01 (synthetic User-Agent parsing, cache-token replay
through the engine proxy) with the C-82 fallbacks.
