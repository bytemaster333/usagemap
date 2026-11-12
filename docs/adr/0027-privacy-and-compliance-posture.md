# ADR-0027: Privacy and compliance posture

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** web.frontend-only-privacy-first, privacy.gdpr-no-consent, privacy.jurisdictions, privacy.data-residency, privacy.minimal-erasure-scope, privacy.strategy-docs, docs.privacy, privacy.residency-statement, privacy.jurisdiction-statement, operator.web-global-view, operator.api-global-view

> **Needs counsel review.** Every legal statement in this ADR is an engineering reading of primary texts, not legal
> advice, and is unreviewed by counsel.

## Context
UsageMap aims for analytics that are GDPR-compliant without requiring client-side opt-ins, and states the
jurisdictions in which it would not be compliant without end-user opt-in. Research found
that a cookieless design does not escape ePrivacy:
- **EDPB Guidelines 2/2023, v2.0, adopted 7 Oct 2024**: a script that instructs the browser to send information is
  "gaining access" (paras 32–33, 51); JS-read values leaving the device are in scope (paras 44, 52–53); relying on
  HTTP headers/IP to build an identifier "can lead to" Art. 5(3) (paras 43, 54–55). Exemptions are expressly not
  analysed (paras 4, 40, 56). Consent-free operation therefore rests on national exemptions.
- The SCF operators' global view is the weak point. CNIL's self-assessment (July 2025) forbids "mise en
  commun par le prestataire de données brutes … provenant de plusieurs de ses clients" and states "Toute fonctionnalité
  visant à croiser, dédoubler ou mesurer un taux de couverture (« reach ») unifié d'un contenu est exclue"; it requires
  presentation "à la dizaine la plus proche" or a documented anonymity analysis. UK PECR Sch. A1 para 5(1)(c) bars sharing collected information "except for the
  purpose of enabling that other person to assist with making improvements to the service or website".
- No regulator has ruled on any cookieless analytics vendor; Plausible's opinion does not engage with EDPB 2/2023 and
  Fathom now writes "Cookie-free does not automatically mean outside device-access rules"
.
- The Digital Omnibus (COM(2025) 837) is not adopted; even the fastest path applies ~2029. It changes nothing for
  the current design.

## Options considered
1. **Claim consent-free compliance everywhere** (common vendor practice). Pros: simple message. Cons: contradicted by
   EDPB 2/2023, DSK OH v1.2 Rn. 87–90 and the Belgian APD checklist; anyone can check it; an overclaim.
2. **Consent-first: ship a CMP integration and require consent.** Pros: lowest legal risk. Cons: fails the design goal
   "without requiring client-side opt-ins"; consent rates make traction data unreliable for programme decisions.
3. **Designed to the strictest published exemption criteria, per-jurisdiction statement, SCF operators get aggregates
   only (chosen).** Pros: defensible where exemptions exist; honest where they do not; states the affected
   jurisdictions. Cons: a long, caveated statement; some metrics degrade in strict configurations; needs counsel.
4. **No identifier at all (referrer-based uniqueness, Simple-Analytics style).** Pros: strongest ePrivacy position.
   Cons: cannot produce unique visitors, session duration or bounce rate, which UsageMap reports; kept only as the
   `visitor_id = off` / `off_in` setting below (C-02).

## Decision
**Roles** (to be fixed in the DPA and enrollment terms, `docs/privacy/`; terminology per C-59):

| Party | Role | Receives | Basis / instrument |
|---|---|---|---|
| Tenant (each project) | **Controller** for audience measurement of its own sites and APIs | Its own dashboards and exports | Art. 6(1)(f); its own privacy notice (we supply text) |
| Service operator (the hosting entity, then a community-appointed successor after handover) | **Processor** for every tenant's analytics | Event-level data, in the EU only (ADR-0017) | Standard Art. 28 DPA: no reuse, sub-processor list, EU hosting, transfer clause |
| Service operator, for its own processing (C-59) | **Controller** for portal account data (sign-in identities, optional contact address, sessions) and audit logs | Its own records | Its own privacy notice; departed users' audit rows are tombstoned (C-57; ADR-0030) |
| SCF operators (portal users with the `operator` or `operator_admin` role) | **Recipients of anonymous statistics**, never of event-level data | Per-tenant aggregates through the `op_*` functions and the SCF operator API | Tenant instructs the disclosure in enrollment terms; SCF data-use terms forbid re-identification |

**Design controls that make the global SCF view defensible:**
- **Aggregates only.** SCF-facing views and APIs are built from the same per-tenant aggregates as the tenant
  dashboard; no API returns event-level rows to SCF operators. Cross-tenant reads go only through allow-listed
  `SECURITY DEFINER` functions `op_*` (C-17): `scf_app` and `scf_metrics_ro` have no cross-tenant SELECT on base
  tables, so the threshold and the audit row cannot be skipped.
- **Minimum count 10, rounded to the nearest 10**, applied to every SCF-facing cell and every filter combination;
  both values configurable. The `op_*` function inserts the audit row in the same transaction. Cross-tenant
  sums add unrounded values and are rounded once (C-89).
- **No cross-tenant visitor de-duplication or reach is ever computed.** The visitor identifier is per site per UTC day
  (ADR-0007); the global view sums and compares, never unions.
- **No pooling of raw data across tenants**: raw rows are tenant-scoped under RLS; no cross-tenant raw query exists in
  any code path that serves SCF operators.
- **Tenant-published aggregates.** A tenant may additionally expose its own thresholded, rounded daily aggregates
  through its `metrics_endpoint` (to SCF operators, to holders of a tenant-created `pub` share key, or publicly if it
  switches public stats on); the trust score is never included (C-14, C-47; ADR-0032). This is the tenant's
  disclosure as controller.

**Design controls that keep personal data out of storage:**
- **No data that identifies a person is stored** (GDPR Art. 11 posture): no IP, no raw User-Agent, no wallet
  addresses, daily key destroyed at rotation (ADR-0006, ADR-0007). The tracker sends the path only and the gateway
  discards any query string or fragment it still receives (C-65).
- **Web page paths are scrubbed at the gateway** (C-52) with the same `pathnorm` rule set as API routes, before
  anything is spooled: identifier-shaped segments (all StrKey types, hashes, UUIDs, long numbers) become typed
  placeholders; seeds, tokens, JWTs and e-mail addresses become `{redacted}`. Redaction of secrets and personal
  identifiers cannot be switched off. The per-site folding setting is `full` or `relaxed`; `relaxed` keeps only
  numbers, dates and slugs, and StrKeys, hashes, tokens and e-mail addresses are always folded or redacted (C-70,
  C-89). Custom-event names and property values pass the same server-side guard. A wallet address in a page URL is
  therefore not stored.
- **Page titles are not collected** (C-89): the wire format has no title field.
- **Erasure selectors are not kept** (C-88): the literal path, event name or property key of an erasure request is
  stored only until the job has finished plus 56 days (C-111, C-112), then replaced by its type and length; the audit log records
  only the selector type and counts (ADR-0030).
- **Event-level web data is kept 90 days by default** (C-54; settable 30–395 days by an `operator_admin`; 395 days
  is the hard maximum; a tenant may choose a shorter period per site). Event-level rows are still treated as pseudonymous
  personal data for that period, which the CNIL/AEPD 25-month cap bounds. Older ranges are served from daily
  aggregates (ADR-0011).
- **Other retention periods (C-71):** portal accounts until deleted by the member, then removed within 30 days
  (tombstone per C-57); operational logs 30 days; monitoring metrics 13 months; trust scores, assurance levels and
  on-chain daily counts kept with the aggregates (none is personal data).

**Per-site and tracker settings** (the means a tenant has to fit its jurisdictions):

| Setting | Values and default | Effect |
|---|---|---|
| Tracker profile (ADR-0004) | `standard` (built to the FR/ES/IT criteria) or `strict` (nothing read for analytics beyond the page path; C-33) | Chooses what the script reads |
| `visitor_id` (C-02) | `on` \| `off` \| `off_in: [countries]`; **`off` by default for a site on `strict`** unless the tenant deliberately turns it on (C-53) | Without an identifier the gateway uses a fresh random surrogate per event and the event goes to the site's twin Umami website (C-73). Page views, country and device counts include such events; unique visitors, visits, bounce rate and session duration are computed only from identified events, and the dashboard says so. |
| `exclude_countries` (C-58) | list of countries, empty by default | Events geolocated to those countries are dropped at the gateway and only counted |
| `anonymous_reports` (C-51) | **on by default** | Tenant-dashboard breakdown rows below the minimum count (10) are merged into "Other" and displayed counts are rounded to the nearest 10, as the French criteria the `standard` profile is built to require. If the tenant switches it off, the notice text we supply no longer refers to those criteria. |
| Consent-gated mode (C-55) | tracker option `consent: "required"`, off by default | The tracker sends nothing until the tenant's consent tool calls `grantConsent()`, and stops on `revokeConsent()`; this lets tenants use the service lawfully where opt-in is required |
| Opt-out | opt-out page; GPC and DNT honoured | No events sent |

**Jurisdiction classification.** `docs/privacy/jurisdictions.md` is authoritative (C-41) and carries the research
tables row by row, per profile, with conditions, confidence and sources. The summary below matches it; if they ever
differ, `jurisdictions.md` wins and this table is corrected. Classes: *defensible without opt-in*; *defensible with
notice + opt-out*; *contested*; *not without opt-in* (consent, or for Russia localisation, required); *not assessed*.
"(subset)" in `jurisdictions.md` means the `strict` class is inferred from `standard`.

| Jurisdiction | `standard` | `strict` |
|---|---|---|
| France, Spain, Italy, Netherlands | Defensible without opt-in | Defensible without opt-in (subset) |
| Luxembourg | Defensible without opt-in — low confidence | Defensible without opt-in (subset) — low confidence |
| Ireland, Greece | Contested | Contested (subset) |
| **Germany** | **Not without opt-in** | **Contested** |
| **Belgium** | **Not without opt-in** | Not assessed |
| Austria, Denmark, Sweden, Finland, Norway, Poland, Czechia | Not without opt-in | Not assessed |
| Portugal | Not without opt-in (research row: "Contested/No") | Not assessed |
| Bulgaria, Croatia, Cyprus, Estonia, Hungary, Latvia, Lithuania, Malta, Romania, Slovakia, Slovenia, Iceland, Liechtenstein | Not without opt-in (assumed; prior knowledge only) | Not assessed |
| United Kingdom — tenant's own analytics | Defensible with notice + opt-out — identifier step contested | Defensible with notice + opt-out (subset) — identifier step contested |
| United Kingdom — SCF global view | Contested | Contested |
| Switzerland | Defensible with notice + opt-out | Defensible with notice + opt-out (subset) |
| US (California and other state laws), Canada (federal), Brazil, Mexico, Japan, Singapore, Thailand, Australia, New Zealand, South Africa, UAE — DIFC/ADGM | Defensible with notice + opt-out (for several rows the condition is notice alone; see `jurisdictions.md`) | Defensible with notice + opt-out (subset) |
| Chile | Defensible with notice + opt-out — provisional | Defensible with notice + opt-out (subset) — provisional |
| Türkiye | Defensible with notice + opt-out — research flags it contested | Defensible with notice + opt-out (subset) — contested |
| Canada — Quebec | Contested — cautious reading: not without opt-in | Contested |
| Argentina, Israel, Kenya, Saudi Arabia, UAE — federal, Nigeria, South Korea, Indonesia | Contested (Israel and Kenya: "OK with notice likely") | Contested (subset) |
| China, Vietnam, Colombia | Not without opt-in | Not assessed |
| India | Not without opt-in from ~13–14 May 2027; not yet applicable on 2026-11-12 | Not assessed |
| Russia | Not without opt-in — and **localisation** | Not assessed |
| All other jurisdictions | Not assessed | Not assessed |

Governing provisions and published positions for the main rows (full citations in `jurisdictions.md`): France —
Loi 78-17 art. 82, CNIL délib. 2020-091 Art. 5, self-assessment tool July 2025 (self-assessed only — never
"certified/validated by CNIL"); Spain — LSSI art. 22.2, AEPD guide v. enero 2024; Italy — Codice privacy art. 122,
Garante Linee guida 10 Jun 2021 §7.2; Netherlands — Telecommunicatiewet art. 11.7a(3)(b); Germany — TDDDG §25,
DSK OH Digitale Dienste v1.2 Rn. 24, 87–90; Belgium — Law of 30 July 2018 art. 10/2, APD checklist (Oct 2023) fn 12;
United Kingdom — PECR reg. 6 + Sch. A1 para 5 (in force 5 Feb 2026; caveats para 5(1)(c) and 5(2)); Switzerland —
TCA Art. 45c, FADP Art. 31(2)(e), FDPIC Guidelines v1.1; China — PIPL Arts. 13, 39; Vietnam — PDP Law 91/2025/QH15;
Colombia — Law 1581/2012 Art. 9; Russia — 152-FZ Art. 18(5).

**What a tenant does where the class is "not without opt-in" or "contested":**
- Use **consent-gated mode** (C-55) for visitors in those jurisdictions — the lawful route where opt-in is required.
- Or, where the obstacle is the identifier or device reads, use `strict` with `visitor_id` off (or list the countries
  in `off_in`). Our statements about Germany assume exactly this configuration (C-53), and it is still classed
  "contested" for `strict`; we state that it reduces, not removes, the risk. For the UK identifier step, list `GB` in
  `off_in`.
- Where the obstacle is **data localisation** (Russia), the only measure we offer is `exclude_countries` (C-58):
  events geolocated there are dropped at the gateway and only counted. Consent does not cure localisation, and even
  transient processing in the EU may be "recording" abroad on a strict reading; we say so.

**The French "no reuse" criterion vs anti-inflation.** CNIL's self-assessment requires "Aucune réutilisation des
données pour le propre compte du prestataire et quelle que soit la finalité (amélioration de son service, **lutte
contre la fraude**, etc.)". UsageMap does bot and inflation detection. Design response:
detection runs **per tenant, on that tenant's own traffic, in gateway memory** (L6 counters keyed per site, no
cross-tenant state, nothing persisted but verdicts and per-site reason counters); it is framed as producing accurate
statistics for the controller (Art. 5(1)(d)); the trust score is computed **from aggregates only** (ADR-0028). This
is a reasoned position, not a settled one; it is counsel question 2.

**The French criteria and custom or wallet events (C-71).** Whether custom and wallet events fit the three-event-type
limit of the French criteria is a question for counsel; until it is answered, the tenant notice we supply claims
those criteria only for sites that send page views alone.

**Wording rule:** documents say "designed to meet" and "defensible under"; never "compliant", "certified" or
"no consent needed anywhere".

## Consequences
Positive: the jurisdiction statement answers privacy.jurisdictions with primary citations; SCF operators never hold personal data, which keeps
them outside controller duties on our reading; the same controls serve CCPA "deidentified" and KVKK "not passed to third
parties" positions.

Negative: the global view has no ecosystem-wide unique-visitor total; small tenants show "< 10", and with
`anonymous_reports` on (the default) tenants also see rounded counts and an "Other" row in their own dashboards;
sites without a visitor identifier lose unique visitors, visits, bounce rate and session duration; Germany and
Belgium need opt-in for `standard`, Germany's `strict` is contested, and the UK identifier step and SCF view stay
contested; tenants carry their own notice and, in some countries, consent duties; the service operator carries its own
controller duties for portal account data and audit logs.

Revisit if: counsel rejects the aggregates-only reasoning for UK para 5(1)(c) or the CNIL "no reuse" framing; the
Digital Omnibus is adopted (Council text recital 44d would support sharing aggregates); EDPB 02/2026 on anonymisation
is finalised; a regulator rules on cookieless analytics.

Unproven: the surrogate-IP path that keeps IPs out of Umami is source-level only (**S-01**); country accuracy of
truncated addresses, on which `off_in` and `exclude_countries` rely, is unmeasured (**S-12**); 13 EU member-state rows
plus Iceland and Liechtenstein rest on prior knowledge and several more on secondary sources; no counsel has read any
of this.

## Open points
1. Open: **Belgium, `strict` profile** is "not assessed" (C-41, `jurisdictions.md`); only Germany's `strict` is
   "contested". Closed by counsel assessing Belgium `strict` (`jurisdictions.md` §6 question 8).
2. Open: **Quebec.** Country-level geolocation cannot detect Quebec, so `off_in` and `exclude_countries` cannot target
   it; whether s. 8.1 applies at all is counsel question 10 in `jurisdictions.md` §6. Until then, consent-gated mode is
   the only tool a tenant with material Quebec traffic has.
3. Open: **Custom and wallet events under the French criteria** (C-71) — whether they fit the three-event-type
   limit; until counsel answers, the notice claims those criteria only for page-view-only sites.
4. Open: **Legal basis and notice for the service operator's own controller processing** (portal account data,
   audit logs; C-59) — closed by counsel, together with the question of which entity is the service operator.
