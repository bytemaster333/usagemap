# ADR-0007: Visitor identifier and salt policy

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** metric.unique-visitors, privacy.gdpr-no-consent, privacy.minimal-erasure-scope, privacy.strategy-docs, bot.ip-multiplicity

## Context
UsageMap reports unique visitors (privacy-first limitations on unique-visitor tracking across sessions are
acceptable), is GDPR-compliant without opt-in, and minimises the set of users who can exercise the right to
erasure. Umami needs *some* per-visitor input to compute sessions, visits, bounce and duration.

What research established:
- **Umami's own identifier is pseudonymous indefinitely.** `sessionId = uuidv5(sha512(websiteId ‖ ip ‖ userAgent ‖
  sessionSalt ‖ distinctId ‖ sha512(APP_SECRET)))` with no separators (`collection-session.ts:105-111`,
  `crypto.ts:49-67` at v3.5.0). The salt is `sha512(startOfMonth(createdAt).toUTCString())` by default — derived from
  the calendar date, not random, never deleted; `SALT_ROTATION=day` shortens the period but the only secret is the
  long-lived `APP_SECRET`. Anyone holding `APP_SECRET` can recompute past session ids from (IP, UA).
- **Vendor practice:** Plausible, Fathom, PostHog and Ackee use a daily salt that is
  deleted or never stored; GoatCounter keeps plaintext `UA-IP-siteID` keys in memory and writes them to its database on
  graceful shutdown. No regulator decision on any hash-based cookieless
  tool was found. Best practice distilled: random daily salt kept only in memory, destroyed at rotation, site
  component in the hash, publish the algorithm.
- **CNIL criterion** (self-assessment, July 2025): a fingerprint-derived identifier must "intégre[r] une composante
  spécifique au site lors du calcul du hash … ainsi qu'une composante temporelle"; no cross-site tracking; no
  cross-client de-duplication or "reach".
- **GDPR Art. 11.** Where the controller can demonstrate it cannot identify the data subject, Arts. 15–20 do not apply
  unless the subject supplies identifying information; Art. 21 (objection) still applies, so an opt-out remains
  mandatory. Once the salt is destroyed, nobody can supply information that locates their rows (§3.3; statutory text
  quoted from memory, EUR-Lex blocked — counsel to confirm).
- **UK caveat.** PECR Sch. A1 para 5(2) excludes "information automatically emitted by the terminal equipment" from the
  statistical exception; whether IP and UA used for a hash count as automatically emitted is open.
- **Umami integration constraints.** The surrogate must be a syntactically valid IP that `is-localhost-ip@3.0.1`
  classifies as non-local, sent in the header named by `CLIENT_IP_HEADER`, never as `payload.ip`; RFC 1918 and
  regex-matched ULA addresses null the country, compressed ULA forms slip through the regex, so ULA is fragile.
  `2001:db8::/32` (RFC 3849 documentation prefix) leaves 96 bits for a keyed hash, cannot be a real client and is never
  matched by the regex.

## Options considered
1. **Umami's own hashing with `SALT_ROTATION=day`.** Pros: no code. Cons: Umami receives the real IP; the identifier
   stays recomputable for as long as `APP_SECRET` exists; no Art. 11 argument.
2. **No identifier at all** (pageviews only, or referrer-based uniqueness as Simple Analytics does). Pros: strongest
   position under Art. 5(3) and GDPR. Cons: no unique visitors, sessions, bounce rate or duration, which UsageMap reports;
   kept as a per-site setting (`visitor_id`, register C-02), not the platform default.
3. **A random per-page-load id generated in the browser, held in memory.** Pros: avoids IP/UA processing (may help in
   the UK). Cons: no uniqueness across page loads on multi-page sites; uniques collapse to page views.
4. **Gateway-side keyed hash with a random daily key held only in memory, presented to Umami as a surrogate IP**
   (chosen). Pros: Umami never sees an address; identifiers become unlinkable to anyone, us included, once the key is
   destroyed; fits the CNIL site-plus-time criterion. Cons: key distribution between nodes; a restart of all nodes
   over-counts; uniques are per UTC day only.

## Decision
- `surrogate = 2001:db8::/32 address built from 96 bits of HMAC-SHA-256(K_day, site_id ‖ ip ‖ user_agent)`, where
  `ip` is the **full** client address and `user_agent` the **raw** User-Agent string, used in memory before the
  address is truncated and the string reduced (C-34).
- `K_day` is **random**, generated daily at **00:00 UTC**, **held only in gateway memory**, shared between gateway
  nodes over **mutually authenticated private links**, **never written to disk or to the database**, and **destroyed
  at rotation**.
- **Key sharing** (C-04): gateway nodes exchange `K_day` over a dedicated mutually authenticated port on the private
  mesh. On start a node asks its peers; if none answers and none is known alive it generates a key. At 23:50 UTC the
  live node with the lowest node ID generates the next day's key and pushes it; nodes missing it pull at 23:55; all
  switch at 00:00 by time of receipt. If two keys exist after a partition, nodes keep the one with the smaller
  SHA-256 fingerprint; the divergence is counted and alerted, and that day's uniques are over-counted. Keys live in
  locked memory; core dumps are disabled, and edge nodes run with no unencrypted swap (C-66).
- **Edge key bundle** (C-68): the same mechanism shares two further independent random keys, both memory-only — the
  daily multiplicity key and the challenge-token key `K_chal`, which rotates hourly (ADR-0008). `K_day` is used for the
  surrogate only; no key is derived from another. Exact layouts are in `docs/contracts/wire-formats.md`.
- **Per-site `visitor_id` setting** (C-02): `on`, `off` or `off_in: [countries]`, independent of the tracker profile
  but `off` by default on a `strict` site unless the tenant deliberately turns it on (C-53). For events without an
  identifier the gateway uses a fresh random surrogate per event, and the forwarder sends the event to the site's
  **twin Umami website**, created on demand (C-73). Tags stay `v` and `s`; the earlier `vn`/`sn` tags are replaced.
  The twin contributes page views and country and device counts only; unique visitors, visits, bounce rate and
  session duration come from the main website, i.e. from identified events only, and the dashboard says so.
- The surrogate is sent to Umami in `x-scf-surrogate-ip` (ADR-0005). **Umami then hashes the surrogate again with its
  own daily salt** (`SALT_ROTATION=day`, `TZ=UTC`, ADR-0003).
- Unique visitors are **per site per UTC day**. No cross-site or cross-day identity exists. After rotation nobody —
  including us — can recompute an identifier.
- If **every gateway node restarts at once**, the key is regenerated and **that day's uniques are over-counted**; this
  is documented, not hidden. The same holds for a key divergence after a partition (C-04).
- **Multi-day "unique visitors" are sums of daily uniques** and are labelled so in the portal and the API.

## Consequences
Positive:
- Umami's recomputability problem is neutralised: its input is a value derived from a key that no longer exists.
- The design supports an Art. 11 posture for visitor rows (ADR-0027, ADR-0030): after rotation the platform cannot
  locate a visitor's rows from anything the visitor could provide.
- `site_id` in the HMAC input means the same browser produces unrelated surrogates on two tenants' sites, so the
  SCF operator view cannot de-duplicate across tenants even by mistake (CNIL "no reach").

Negative / limits:
- On a given day the identifier is pseudonymous personal data for the service operator (processor) and the tenant
  while `K_day` exists;
  event-level rows should be treated as personal data for their retention period.
- Any change of IP or UA during a day (mobile handover, browser update) yields a new visitor; CGNAT and shared offices
  with identical UAs can merge visitors. These are inherent to IP+UA identifiers; using the full address and raw
  string (C-34) keeps such merges as rare as the inputs allow, at the cost of feeding the full inputs into the hash.
- Umami hashes the surrogate together with the synthetic reduced User-Agent the forwarder sends (ADR-0005). That
  string is a coarse function of the raw User-Agent already inside the surrogate, so the surrogate carries all
  differentiation; do not assume Umami's UA input adds any.
- Events without an identifier (`visitor_id = off`) make unique visitors, visits, bounce rate and duration undercount
  relative to page views; the dashboard labels those figures as computed from identified events only (C-02, C-73).
  A site with `off_in` has two Umami websites to provision and erase.
- A tenant whose dashboard uses a non-UTC time zone sees "days" that span two keys; per-day uniques are only exact on
  UTC days.
- Key sharing is a new failure mode: a network partition at 00:00 UTC can leave nodes with different keys until the
  fingerprint rule converges them (C-04), so a visitor served by two nodes counts twice; the all-nodes-restart case is
  the documented extreme. Both cause over-counting, never under-counting, and divergence is counted and alerted.
- `K_day` must be protected like any secret in memory: locked memory, core dumps disabled, no unencrypted swap
  (C-04, C-66), no debug endpoints.
- The engine proxy's visit-continuity memory on the core nodes (C-74, ADR-0003) holds Umami's cache token keyed by
  (site, surrogate) in memory only, for 30 minutes; it never reaches the browser or disk, so it adds no identifier
  that outlives the day.
- Opt-out cannot be carried by the identifier (it changes daily); the tracker's opt-out flag (ADR-0004) and GPC/DNT
  carry it.

Unproven: Umami's handling of the surrogate (session differentiation, country preserved, no IP persisted) is verified
by code reading only; spike **S-01** steps A, B, D–H test it.
The key-sharing protocol between nodes (C-04, C-68) has no spike yet; it is specified as a separate package with a
partition and clock-skew test plan before the gateway is built (ADR-0026).

Revisit if: counsel's view on UK para 5(2) or German §25 TDDDG requires more than the per-site
`visitor_id = off_in: [countries]` setting; S-01 shows Umami treats `2001:db8::/32` as local or drops the country.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Privacy analytics vendor positions: Umami salt, vendor schemes, best practice.
- Umami IP geo header integration: surrogate constraints, spike design.
- Umami ingest datamodel tracker: session and visit hashing, visitor caveats.
- Privacy EU UK law: Art. 11, CNIL hash criterion, UK para 5(2).
- Goatcounter deep dive: GoatCounter session keys persisted on shutdown.

## Open points
None outstanding. (The relation of `K_day` to the challenge and multiplicity keys is settled by C-68: three
independent keys shared by the C-04 mechanism.)
