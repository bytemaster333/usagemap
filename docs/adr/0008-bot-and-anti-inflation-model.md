# ADR-0008: Bot and anti-inflation model

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** web.frontend-origin-only, bot.anti-inflation-strategy, bot.js-execution-proof, bot.ip-multiplicity, bot.engine-bot-detection, trust.verified-vs-raw, test.automated-suite

## Context
UsageMap's web events originate only from frontend code, and the platform needs a concrete strategy for detecting and
mitigating bot traffic and artificial metric inflation: at minimum, distinguish real browser JS execution from pure
server-side posts, and treat multiple distinct fingerprints from the same IP with scepticism, building on the base
project's existing bot detection. The reason is the product's purpose: a unified, trusted source of end-user usage
data instead of self-reported metrics.

**Threat.** The adversary is the **tenant inflating its own numbers** (for example to look more used to a grant
programme or investor). It controls its site, can read
all our code, and can run real browsers, headless farms, residential proxies and paid humans. Inflation cannot be made
impossible. The aim is to make cheap inflation fail, make expensive inflation cost money, and make what gets through
visible to SCF operators with explainable reasons (threat model).

What research established:
- **Umami's existing detection** is one `isbot(userAgent)` call (`route.ts:96-99`, `isbot@5.2.2`, Unlicense), answered
  with HTTP 200 `{"beep":"boop"}` and silently dropped, plus a static `IGNORE_IP` list. `payload.userAgent` replaces
  the header, so the check is bypassable; `timestamp`, `id` and `hostname` are client-controlled.
- **Proof of JS execution.** A signed challenge kills zero-effort server-side posting, but a scripter who reads our
  open tracker can fetch and answer it in about 20 lines, and **a real or headless browser always passes**. Privacy
  Pass, Private Access Tokens, Private State Tokens and Web Bot Auth are not usable by an independent first-party
  service without a big-tech issuer or attester.
- **Proof-of-work is metering, not a barrier.** At a tracker-tolerable W = 2¹⁹ PBKDF2-HMAC-SHA-256 iterations: GPU
  ≈ $0.01–0.02 and a 16-thread CPU ≈ $3.5 per 1 M solves (Cap's measured rates: RTX 5060 Ti 6,150 MH/s, Ryzen 3700X
  41 MH/s). The attacker's real cost is network realism: residential proxies at $1–8/GB give ≈ $10–80 per 1 M
  non-browser sessions and ≈ $300–16,000 per 1 M headless sessions. Mobile solve time is an estimate
  (≈ 175–525 ms on a low-end Android core) until measured.
- **ALTCHA** (MIT; widget v3.6.0, altcha-lib v2.8.0) offers a KDF-based PoW v2 wire format; its widget is 34 kB gz, too
  large for a tracker. Anubis needs a cookie; Cap generates a fresh script per challenge, which conflicts with
  "no dynamic remote updates"; Turnstile/hCaptcha are third-party processors.
- **Headless signals in 2026** catch only lazy automation: `navigator.webdriver` can be removed; `HeadlessChrome`
  appears only with `--headless`; stealth forks (rebrowser-patches, Camoufox) target the rest. Visibility/prerender,
  framing and `userActivation.hasBeenActive` are the valuable signals against self-inflation.
- **Consistency checks**: `Sec-Fetch-*` are forbidden headers (Baseline March 2023); `Sec-Fetch-Mode: navigate` or
  `Sec-Fetch-Site: none` on an event endpoint is impossible from our tracker; client hints vs UA; a JA4 (BSD-3) TLS
  family vs UA family (not used in the first release, C-77). curl-impersonate (MIT), tls-client (BSD-3) and got-scraping forge all of these cheaply.
- **Network data and carve-outs**: Apple Private Relay egress is real users; mobile CGNAT needs high thresholds; the
  MRC IVT addendum (June 2020) says proxy and data-centre traffic "must be known to be invalid in order to be filtered,
  otherwise it must be treated as unknown" — so datacentre means `suspect`, not `rejected`. Tenant self-inflation is
  textbook MRC SIVT ("incentivized human invalid activity: self-directed activity to benefit self").
- **Multiplicity** without storing IPs: per-node in-memory keyed counters, ≤ 10 MB per node at the design target,
  hard cap ≈ 160 MB under attack; an attacker spreading over N nodes cuts apparent multiplicity by up to N.
- **Law.** CNIL's criteria forbid reuse "pour le propre compte du prestataire … (… lutte contre la fraude, etc.)",
  which collides with anti-inflation; the defensible framing is accuracy of the tenant's own statistics, per tenant,
  in memory, with scores computed from aggregates only — **counsel must review**.

## Options considered
1. **Umami's `isbot` only.** Pros: meets "build on" literally. Cons: fails bot.js-execution-proof and bot.ip-multiplicity outright.
2. **Third-party bot management or CAPTCHA (Turnstile, hCaptcha, Friendly Captcha).** Pros: strong signals. Cons:
   third-party script and processor on every tenant page, non-EU processing, supply-chain exposure, user friction.
3. **Hard blocking with heavy PoW and aggressive fingerprinting.** Pros: raises cost. Cons: seconds of CPU per page
   on cheap phones; high-entropy fingerprints contradict the privacy posture; false positives delete real traffic.
4. **Layered, mostly soft model: few hard rejects, labelled verdicts, raw kept, advisory score** (chosen). Pros:
   honest about limits; nothing real is deleted; fits privacy constraints. Cons: verified numbers can still be gamed
   by a well-funded tenant; SCF operators must read reason codes rather than trust a single figure.

## Decision
Eight layers, each with a stated limit. All run per tenant on that tenant's own traffic, in memory (L0–L6) or on
aggregates (L7). Thresholds are published. Layer numbers follow the register (research's §6 table numbers them
differently); other documents use the register's numbering.

| Layer | Mechanism | What it stops | What it only detects | What it cannot do |
|---|---|---|---|---|
| L0 | Payload rebuild and field stripping (ADR-0005) | Back-dating, `id`-rotation "visitors", client-chosen IP/UA/hostname reaching Umami, unknown fields | Malformed or oversize requests (counted) | Anything sent with plausible values through the real protocol |
| L1 | Origin/domain binding (verified domains, CORS for registered origins) | Browser-based posting from unregistered sites; events for foreign domains | Missing `Origin` | A non-browser client that sets `Origin` itself |
| L2 | **Signed JS-execution challenge**: stateless HMAC token bound to site, coarse time window, subnet and UA digest, keyed with `K_chal` (rotated hourly, previous epoch still accepted; a token from an unknown epoch makes the event `suspect`, not `rejected` — C-68); one per page load; fetched by both tracker profiles (C-33) | Blind server-side POSTs; replay of tokens outside the window | Token used from another subnet or UA family | A script that fetches a challenge first; any headless browser; a fresh challenge per fake session |
| L3 | **Proof-of-work as metering**: ALTCHA-v2-style, own ~1 kB solver, adaptive difficulty; solved before the first event, reused for later events of the page load up to a per-token cap (C-35) | Nothing absolutely; turns free inflation into metered inflation and throttles abnormal subnets | Implausibly fast or uniform solve latency | Resist GPU or native solvers (≈ $0.01–4 per 1 M) |
| L4 | Request consistency: `Sec-Fetch-*`, client hints, minimal client booleans (`webdriver`, visibility, user activation — `standard` profile only; their absence is never a reason for `suspect`, C-33) | Lazy non-browser clients and default automation; header combinations a browser cannot produce (`rejected`, C-39) | Header/UA mismatches, hidden or prerendered pages, no user activation | Defeat curl-impersonate/tls-client with copied headers, or stealth browsers with synthetic input; no TLS-client fingerprint in the first release (C-77) |
| L5 | The upstream `isbot` list Umami uses, at the version pinned by our Umami release, applied at the gateway to the **raw** User-Agent before reduction (parity test against Umami's function); **and** Umami's own `isbot` check left enabled as a backstop, though it only sees the reduced string (C-36, design trade-off DV-08) | Self-declared crawlers; scripts with default UAs | — | Anything that sends a browser UA |
| L6 | In-memory multiplicity, keyed with the daily multiplicity key (C-68): distinct surrogates per truncated subnet per site per window; for sites with `visitor_id = off`, **events** per truncated subnet per window instead (C-80); thresholds by ASN class (`datacenter`, `tor` and `vpn` lower them, C-38); Private Relay and carrier NAT carved out; per node; counting algorithm in `docs/contracts/wire-formats.md` (C-89) | — (soft signal) | Visitor-identity rotation from few subnets; for unidentified sites, event volume from few subnets | Proxy pools with one IP per session; spreading over nodes divides the count by up to N; without identifiers it cannot tell many visitors from one busy one |
| L7 | Daily anomaly detection and an **advisory trust score** with reason codes, from aggregates (ADR-0028) | — (advisory; never deletes data) | Inflation that is not coherent across mix, time-of-day, engagement, network and cross-signal dimensions | Detect paid humans on real devices behaving realistically |

**Verdicts** (assigned at the gateway, ADR-0005 step 5):
- `verified` — valid proof and consistent signals.
- `suspect` — datacenter ASN (of the network classes, only `datacenter` alone yields `suspect`; `tor` and `vpn` only
  lower multiplicity thresholds, C-38), multiplicity over threshold, inconsistent signals, a challenge token from an
  unknown key epoch (C-68), or missing proof (`proof_missing`, e.g. a page hidden before the proof completed, C-35).
- `rejected` — no valid challenge, origin mismatch, known bot, header combinations a browser cannot produce, or
  malformed request (C-39). Not forwarded to Umami.

Every well-formed event is answered `202` whatever its verdict, so responses are no oracle (C-39). Verdict and reason
counters per site and day — for `suspect` and `rejected` alike — travel through the spool as counter records, are
stored in `scf` and feed ADR-0028; tenants see them on an installation-check page.

The verdict is stored as Umami's event `tag` ∈ {`v`, `s`} (C-73; the earlier `vn`/`sn` tags are replaced). Events
without a visitor identifier go to the site's twin Umami website and contribute page views, country and device counts
only. Rejected events never reach Umami. Reporting (C-73):
- **Page views:** verified (tag `v`) and raw (all, plus the twin).
- **Unique visitors:** verified (sessions with at least one verified event) and raw (all sessions of the main website).
- **Visits, bounce rate, session duration:** one figure each, computed by Umami over **all identified, non-rejected
  events** in a single query — never by adding filtered results — and shown next to the share of page views that are
  suspect. There is no verified-only variant of these three, because filtering events inside a visit would distort
  them (a visit routinely mixes `v` and `s` events, C-35).

**Fallbacks if S-01 fails** (C-82): if Umami's stats API cannot filter by `tag`, verified and raw page views and
visitors are computed hourly by our rollup job from Umami's event table through a read-only, contract-tested SQL view,
and live dashboards show Umami's unfiltered figures plus our verified counts. If cache-token replay does not work,
live views follow Umami's clock-hour visit rule and our daily aggregates sessionise by 30-minute gaps. Either fallback
is recorded as a deviation with its effect on the numbers.

**Framing or flooding a competitor** (C-80, rated Medium in the threat model). The site key is public, so anyone can
send events for another tenant's site. Origin binding (L1), the challenge (L2) and per-subnet rate limits bound it;
what remains is detectable (reason codes, a sudden rise in the suspect share) and the tenant and SCF operators can
annotate it (ADR-0028). Quotas count **verified events only**, so a flood of `suspect` events cannot exhaust a
competitor's quota, and `429` answers caused by a site's quota are reported per site (C-80, C-90).

**We state plainly that a real headless browser on residential proxies passes L0–L5 and is only *detectable* by
L6–L7.** Detection runs per tenant on that tenant's own traffic, in memory (an open question for counsel).
*Depends on S-01 (tag filter) and S-07 (PoW timing).*

## Consequences
Positive:
- bot.js-execution-proof is met in this sense: a pure server-side POST without a challenge is `rejected`, and one with a
  challenge but no proof is `suspect`; bot.ip-multiplicity is met by L6 with carve-outs that avoid punishing CGNAT and Private
  Relay; bot.engine-bot-detection by applying Umami's own `isbot` list at the gateway on the raw User-Agent and keeping Umami's check
  enabled (C-36, DV-08).
- `strict`-profile traffic can be `verified`: it runs the challenge and proof, and the absence of the `standard`-only
  client booleans never counts against it (C-33).
- The gateway keeps no pending-proof state, so any node can verify any event (C-35).
- Nothing real is deleted except `rejected` traffic; SCF operators always see raw beside verified, with reasons.
- Publishing thresholds lets tenants find and fix their own causes (uptime monitors, QA bots).

Negative / honest limits:
- A well-funded tenant can produce `verified` traffic: headless browsers on residential proxies pass L0–L5; a scripted
  client with forged headers and the open-source solver passes L0–L3 and most of L4; without a TLS-client fingerprint
in the first release (C-77) L4 is cheaper to pass than the research assumed. What remains is cost and
  the chance of incoherence visible in L6–L7.
- An attacker can still pollute a competitor's raw figures and lower its verified/raw ratio; we detect and explain
  this, we do not prevent it (C-80). The suspect-share figure next to visit metrics makes such pollution visible.
- For sites without visitor identifiers, L6 counts events rather than distinct visitors, which is weaker: a busy
  subnet and an inflating one look alike until volume exceeds the threshold (C-80).
- Per-node L6 counting can be diluted by spreading traffic across nodes; gossip of keyed sketches is the documented
  upgrade, not part of this decision.
- PoW costs real users battery and time; budget depends on S-07 (target ≤ 500 ms before the first event, C-35).
  Pages without a secure context cannot run it. Because the proof blocks the first event, a visitor who hides the
  page before it completes is counted only as `suspect` (`proof_missing`), never `verified`.
- Umami's own `isbot` sees only the reduced User-Agent, so it fires only if the reduction keeps a bot UA
  recognisable; the gateway-side check on the raw string is what reliably applies the base project's list, and the
  documentation says exactly this (C-36).
- Published thresholds can be tuned against; we rely on the cost of coherence across many signals, not secrecy.
- The CNIL "no reuse including fraud" criterion is in tension with this ADR; until counsel answers, the framing is
  accuracy of the tenant's own statistics.

Unproven: `tag` as a stored, filterable column (`src/lib/constants.ts:57,101`, `src/lib/schema.ts:112,197`, checked by
code reading) — S-01; stats latency with a `tag` filter — S-11; PBKDF2 timing on a ≈ $100 Android phone and iOS Safari —
S-07. (S-13, the JA4 check, is dropped with JA4 itself, C-77.) The three-key exchange (C-04, C-68) has no spike yet.

Revisit if: S-01 fails (the C-82 fallbacks then apply); S-07 forces difficulty so low that L3 adds nothing; counsel rules per-tenant in-memory detection outside
the exemptions; a privacy-preserving attestation becomes usable by independent services.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Bot detection anti inflation: layers, PoW economics, verdicts, sources.
- Umami ingest datamodel tracker: Umami's trust of client fields, `isbot`.
- Privacy EU UK law: CNIL "no reuse incl. fraud", per-tenant framing.
- Research synthesis: the bot-detection hypothesis and the spikes S-01, S-07 and S-11 that test it.

## Open points
1. **Open: counsel on per-tenant detection.** The CNIL criteria forbid reuse "pour le propre compte du prestataire
   (… lutte contre la fraude)"; the framing that detection serves the accuracy of the tenant's own statistics, per
   tenant, in memory, needs counsel review. Closed by counsel.

(How the challenge and multiplicity keys are generated, rotated and shared is settled by C-68; L6 without
identifiers by C-80; the tag vocabulary by C-73.)
