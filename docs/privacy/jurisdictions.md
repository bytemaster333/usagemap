# Jurisdictions statement — where the solution would not be compliant without end-user opt-in

> **Not legal advice.** Prepared by engineers from desk research on EU/UK law, the EU member states and other
> jurisdictions (all researched 2026-11-12). No counsel has reviewed it; a review is for `<OPERATOR-ENTITY>` to
> commission. Nothing below states that the solution "is compliant" anywhere: it says the configuration is **designed to
> meet the published criteria of** a regulator or statute, and how confident we are.
>
> **This table is authoritative for classifications** (design decision C-41 in [`docs/adr/README.md`](../adr/README.md));
> every summary elsewhere must match it. The consistency passes after the design decisions C-01…C-112 changed no
> classification: they added the consent-gated-mode notes (C-55), the country-exclusion note for Russia (C-58), the
> retention change (C-54) where it affects a condition, and the interim notice rule for France (C-71). C-41 as
> reworded matches this table (Germany `strict` "Contested", Belgium `strict` "Not assessed").

This statement names every jurisdiction in which the solution would not be compliant without end-user opt-in, as far
as we have assessed it.

## 1. How to read the tables

**What is assessed.** Web analytics as designed in [`strategy.md`](strategy.md): a cookieless, storage-free tracker
(one opt-out flag excepted) whose script sends page path, and in the `standard` profile referrer host, screen-width
class and primary language; a JS challenge and proof-of-work in both profiles (C-33); server-side IP truncation,
country lookup and — unless switched off — a daily, per-site, memory-keyed identifier (the `strict` profile has no
identifier by default, C-53; events without one go to a per-site twin website and count for page views, country and
device only, C-73); page paths and custom events scrubbed of identifiers and secrets at the gateway (C-52);
no query strings (C-65); no IP stored; event-level data kept 90 days by default (C-54); tenant dashboards rounded and
thresholded by default (C-51); tenant = controller, service operator = processor, SCF operators = recipients of anonymous
per-tenant aggregates (C-59). **API analytics** (OpenTelemetry metrics with no end-user identifiers by design) is B2B operational
telemetry; most rows below do not apply to it (§5).

**Baseline for every EU/EEA row.** On the EDPB's reading (Guidelines 2/2023 on the technical scope of Art. 5(3)
ePrivacy Directive, v2.0, adopted 7 Oct 2024, paras 32–34, 43–44, 50–55) the design is **within** Art. 5(3): the
script is an instruction to the device, the JS-read values leave the device, and IP/UA used for an identifier is
"relying on those mechanisms to collect information". Consent-free operation therefore depends on a national
exemption. GDPR duties — notice (Arts. 13/14), a legal basis (Art. 6(1)(f) for the tenant), an objection mechanism
(Art. 21), an Art. 28 DPA — apply in every row.

**Classification** (per profile):

| Class | Meaning |
|---|---|
| **Defensible without opt-in** | A statutory or regulator-recognised route exists and the profile is designed to meet its published criteria. The route's own conditions (notice, objection link, processor contract, retention caps) still apply and are listed under "Conditions". |
| **Defensible with notice + opt-out** | The route is itself built on information plus a simple right to refuse (opt-out-based exemption, or a notice-based legal regime). Research label "A+N". |
| **Contested** | No clear route, conflicting sources, or a material open legal question; a tenant relying on it carries real risk. |
| **Not without opt-in** | Consent (or, for Russia, localisation) is required on the regulators' published positions or the statute; also used where the research found no exemption and assumed consent ("No (assume)"). For these rows the route to lawful use is the tracker's **consent-gated mode** (`consent: "required"`, C-55): it sends nothing until the tenant's consent tool calls `grantConsent()` and stops on `revokeConsent()`. Valid consent itself is the tenant's responsibility; the mode does not change the classification. Russia is the exception: consent does not cure localisation, and the only measure offered is `exclude_countries` (C-58). |
| **Not assessed** | The research did not analyse this profile/jurisdiction combination. |

Where we infer the `strict` class from the `standard` class (strict collects a strict subset of standard's data), the
cell says "(subset)". That inference is ours, not the research's.

**Evidence grade** — carried from the research files' own labels:

| Grade | Meaning | Research labels it covers |
|---|---|---|
| **Primary source read** | The research read the statute, regulator guidance or decision text on 2026-11-12 | "yes (text read)", VERIFIED |
| **Secondary** | Law-firm, vendor or press summaries; or the primary page was blocked | "per secondary", "secondary only", LIKELY via secondaries, search snippets |
| **Prior knowledge** | Filled from the researcher's existing knowledge; **not verified** in the research | "(memory)", "not verified", "from established knowledge", UNVERIFIED |

**Sources the research could not reach:** EUR-Lex and CURIA (WAF/JS blocks) — Art. 5(3) wording is the EDPB's verbatim
reproduction; C-413/23 P paragraph numbers are from secondary sources. Austrian DSB FAQ (403). Dutch AP guidance
(404). gesetze-im-internet.de (DNS failure; §25 TDDDG read via a consolidation). **13 EU member-state rows (BG, CY,
CZ, EE, HR, HU, LT, LV, MT, PT, RO, SI, SK) plus Iceland and Liechtenstein were filled from prior knowledge** because
the research's web-search budget was exhausted.

## 2. EU/EEA and United Kingdom

| Jurisdiction | Governing provision | `standard` | `strict` | Conditions | Confidence · evidence grade | Source |
|---|---|---|---|---|---|---|
| **France** | Loi 78-17 art. 82 | Defensible without opt-in | Defensible without opt-in (subset) | Designed to meet the CNIL audience-measurement exemption: Délibération 2020-091 Art. 5 paras 50–52 ("pour le compte exclusif de l'éditeur"; anonymous statistics only; personal data neither cross-referenced nor transmitted to third parties); Recommendation 2020-092 consolidated 16 Jan 2026 (13-month tracer life, **25-month** retention); self-assessment tool July 2025 (≤ 3 event types, UA major version, referrer host only, no UTM/CRM IDs, IP truncation, site + time component in any hash, no raw pooling across clients, **no reuse by the provider incl. fraud fighting**, reports rounded to the nearest 10 or anonymity analysis, opt-out link in the privacy policy). Self-assessed only; never "certified/validated by the CNIL". Reports: tenant dashboards round to the nearest 10 and merge rows below 10 into "Other" by default (`anonymous_reports`, C-51); a tenant that switches it off no longer meets this criterion as designed. No query strings or campaign parameters at all (C-65). Event-level data 90 days by default, 395 days at most (C-54). No page titles (C-89). Open: bot-detection framing; whether custom plus wallet events fit "≤ 3 event types" (strategy OP-16) — until counsel answers, the tenant notice claims these criteria only for sites that send page views alone (C-71). | High · Primary source read | cnil.fr pages and PDFs (S12–S16) |
| **Spain** | Ley 34/2002 (LSSI) art. 22.2 | Defensible without opt-in | Defensible without opt-in (subset) | AEPD guide "Uso de cookies para herramientas de medición de audiencia" (v. enero 2024): exclusive audience measurement on behalf of the publisher; closed list of measurements (page audience, referrer, device type/browser/screen size, load time, time on page, bounce rate, scroll, clicks, geographic zone — aggregated daily); no cross-site ID or unified reach; per-publisher independence for a multi-publisher processor; Art. 28 contract banning reuse; 13/25 months; documented configuration assessment. SCF sharing of anonymous aggregates arguable ("datos", not "datos personales"). | High · Primary source read | aepd.es guide PDF (S19) |
| **Italy** | D.lgs. 196/2003 (Codice privacy) art. 122 | Defensible without opt-in | Defensible without opt-in (subset) | Garante Linee guida cookie (10 Jun 2021) §7.2: prevent singling out; third parties mask at least the fourth IPv4 component (we truncate /24 and IPv6 /48); aggregate statistics only, single site; providers must not match data or forward it to other third parties. | High · Primary source read | garanteprivacy.it docweb 9677876 (S20) |
| **Netherlands** | Telecommunicatiewet art. 11.7a | Defensible without opt-in | Defensible without opt-in (subset) | Statutory: art. 11.7a(3)(b) — information on "kwaliteit of effectiviteit" of the service "mits dit geen of geringe gevolgen heeft voor de persoonlijke levenssfeer". AP practice not read (page 404). | High (statute) / Med (AP practice) · Primary source read (statute) | wetten.overheid.nl BWBR0009950 (S21) |
| **Luxembourg** | Loi 30 mai 2005 art. 4(3) (provision from prior knowledge) | Defensible without opt-in — low confidence | Defensible without opt-in (subset) — low confidence | CNPD reported to apply a narrow, CNIL-like exemption (strictly first-party, anonymous, statistical); details not verified. Not in the register's list (ADR-0027). | Low · Secondary (provision: prior knowledge) | luxgap.com, Bird & Bird (secondary); CNPD not read |
| **Ireland** | S.I. 336/2011 reg. 5(3)–(5) | Contested | Contested (subset) | DPC (Apr 2020): analytics cookies require consent; first-party aggregated analytics with clear information and a user-friendly opt-out "unlikely … a priority for enforcement". Formally consent; low enforcement risk. | High · Primary source read | dataprotection.ie guidance (S23) |
| **Germany** | TDDDG §25 | **Not without opt-in** | **Contested** | §25(2) covers only transmission or what is "unbedingt erforderlich" for an "ausdrücklich gewünschten" service; DSK OH Digitale Dienste v1.2 (Nov 2024) Rn. 24 (JS reads of device properties = access), Rn. 87–90 (no general exemption for audience measurement; only for a "genau definierte Konfiguration"); Rn. 88 benign baseline = log-file counting / simple counting pixel. `strict` is the most defensible configuration but still contested (residual risk: the beacon itself, and server-side IP/UA identifier). German counsel needed. For `standard`, the route to lawful use is the **consent-gated mode** (C-55); the `strict` assessment assumes no visitor identifier, its default (C-53). | High (law, DSK) / Med (characterisation) · Primary source read (DSK); §25 via consolidation | buzer.de §25 (S17); DSK PDF (S18) |
| **Austria** | TKG 2021 §165(3) | Not without opt-in | Not assessed | No recognised exemption found; DSB FAQ blocked (403). Route to lawful use: the **consent-gated mode** (C-55). | Med · Secondary | iubenda summary of DSB FAQ |
| **Belgium** | Law 30 July 2018 art. 10/2 (per APD checklist) | Not without opt-in | Not assessed | APD/GBA cookie checklist (Oct 2023) fn 12: counting visitors "in beginsel" not exempt (cites WP194). Route to lawful use: the **consent-gated mode** (C-55). | High · Primary source read | APD cookie-checklist PDF (S22) |
| **Denmark** | Cookiebekendtgørelsen BEK 1148/2011 §3 (provision from prior knowledge) | Not without opt-in | Not assessed | Analytics cookies need prior consent (secondary). Route to lawful use: the **consent-gated mode** (C-55). | Low–Med · Secondary (provision: prior knowledge) | cookieinformation, clickport |
| **Sweden** | LEK (2022:482) ch. 9 §28 | Not without opt-in | Not assessed | No analytics exemption found (PTS + IMY). Route to lawful use: the **consent-gated mode** (C-55). | Low–Med · Secondary | secondary |
| **Finland** | Act 917/2014 §205 | Not without opt-in | Not assessed | Authorities' interpretation: analytics cookies require consent (Traficom NCSC). Route to lawful use: the **consent-gated mode** (C-55). | Med · Secondary | Bird & Bird FI |
| **Norway** (EEA) | ekomloven in force 1 Jan 2025, § 3-15 (per secondary; a government page still cites old § 2-7b) | Not without opt-in | Not assessed | GDPR-standard consent; browser-setting consent removed; Datatilsynet guidance 3 Apr 2025 (secondary). Route to lawful use: the **consent-gated mode** (C-55). | Low–Med · Secondary | secondary; Lovdata not read |
| **Poland** | Prawo komunikacji elektronicznej (12 Jul 2024, in force 10 Nov 2024) art. 399 | Not without opt-in | Not assessed | Exceptions mirror the ePD; analytics need consent (blog reading); UODO enforces (art. 445). Route to lawful use: the **consent-gated mode** (C-55). | Low–Med · Secondary | edlaw.eduverse, Grant Thornton |
| **Czechia** | Act 127/2005 §89(3), opt-in since 1 Jan 2022 | Not without opt-in | Not assessed | No exemption known. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Greece** | Law 3471/2006 art. 4(5) (provision from prior knowledge) | Contested | Contested (subset) | Sources conflict on HDPA 2020 guidance: IAPP says analytics not exempt; Bird & Bird says certain first-party analytics exempt with opt-out. | Low · Secondary only (provision: prior knowledge) | IAPP, Bird & Bird |
| **Portugal** | Lei 41/2004 art. 5 | Not without opt-in (research row: "Contested/No") | Not assessed | Unclear; treated cautiously. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Bulgaria** | Electronic Communications Act art. 4a | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Croatia** | Electronic Communications Act 2022 (article not verified) | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Cyprus** | Law 112(I)/2004 | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Estonia** | transposition not verified | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Hungary** | transposition not verified | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Latvia** | Information Society Services Law | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Lithuania** | Law on Electronic Communications art. 61 | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Malta** | S.L. 586.01 reg. 5 | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Romania** | Law 506/2004 art. 4(5) | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Slovakia** | Act 452/2021 §109 | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Slovenia** | ZEKom-2 (2022) (article not verified) | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Iceland** (EEA) | Electronic Communications Act 2022 | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **Liechtenstein** (EEA) | Kommunikationsgesetz | Not without opt-in (assumed) | Not assessed | Unclear. Route to lawful use: the **consent-gated mode** (C-55). | Low · **Prior knowledge** | not verified |
| **United Kingdom — tenant's own analytics** | PECR reg. 6 + Sch. A1 para 5 (inserted by DUAA 2025 s.112, Sch. 12; in force **5 Feb 2026**, SI 2026/82 reg. 2(w), (z13)) | Defensible with notice + opt-out — **identifier step contested** | Defensible with notice + opt-out (subset) — identifier step contested | Sole purpose statistical, "with a view to making improvements"; (d) clear and comprehensive information; (e) simple, free means of objecting; ICO final guidance (Apr 2026): provider must be a processor, not a joint controller; "must not solely rely on browser settings" (so the opt-out link is mandatory, GPC/DNT is not enough). **Para 5(2):** the exception does not cover "collecting or monitoring information automatically emitted by the terminal equipment" — if IP/UA count as such, the IP/UA-derived identifier is outside para 5. Mitigation: `visitor_id = off_in: [GB]` (C-02), or `strict`, which has no identifier by default (C-53). | High (law) / Med (application) · Primary source read | legislation.gov.uk (S6–S8); ico.org.uk (S9–S11) |
| **United Kingdom — SCF global view** | PECR Sch. A1 para 5(1)(c) | **Contested** | **Contested** | Information collected must not be "shared with any other person except for the purpose of enabling that other person to assist with making improvements to the service or website". SCF uses statistics for funding decisions. Counter-argument (anonymous aggregates are new information) untested. Options: UK counsel opinion; show SCF only metrics a UK tenant explicitly publishes; disclose the risk. | High (law) / Med (application) · Primary source read | legislation.gov.uk (S6); ico.org.uk (S9) |

## 3. Rest of the world

Research classification legend: **A+N** = OK with notice (± opt-out); **C** = contested; **X** = not OK without
opt-in or localisation. The `strict` column is "(subset)" where the research's class carries over; for "Not without
opt-in" rows the research suggested that a no-identifier mode could turn "not compliant" into "degraded metrics", but
did not analyse it, so `strict` is **Not assessed** there. For those rows the consent-gated mode (C-55) is the route
to lawful use; for Russia only country exclusion (C-58) is offered.

| Jurisdiction | Governing provision | `standard` | `strict` | Conditions | Confidence · evidence grade | Source |
|---|---|---|---|---|---|---|
| **Switzerland** | FADP Arts. 6, 30–31(2)(e); TCA Art. 45c; FDPIC Guidelines v1.1 (06.10.2025) | Defensible with notice + opt-out | Defensible with notice + opt-out (subset) | Guidelines expressly cover stateless tracking and fingerprinting (§1.1). Inform and state purposes; **mandatory** option to reject (§3.7.2, §3.9); under Art. 31(2)(e) data anonymised as soon as the purpose permits, "usually … immediately", results published without identifying anyone, external tools only on the website operator's (here: the tenant's) behalf (§3.8.2). EU/EEA adequate (FADP Art. 16, Annex 1 DPO — LIKELY). **Tension with retention, flagged for counsel:** event-level data is now kept 90 days by default (C-54; a tenant may shorten it to 30 days), far shorter than the default it replaced but still **not** "immediately"; only the daily aggregates are kept beyond that window. Whether 30–90 days meets "as soon as the purpose permits" is open. | High (rule) / Med (opt-out implementation) · Primary source read | FDPIC PDF v1.1 |
| **US — California** | CCPA §1798.140(d), (ag), (ah), (m); Regs §§7050, 7025; CIPA §§631, 638.51 + SB 690 (signed 30 Sep 2026) | Defensible with notice + opt-out (notice required; opt-out good practice) | Defensible with notice + opt-out (subset) | Tenant privacy notice; service-provider contract (no retention/use/disclosure outside the business purpose, no combining across businesses); no sale/share, so no opt-out-of-sale duty and GPC not legally triggered; most tenants below the §1798.140(d) thresholds (revenue > $26,625,000 from 1 Jan 2025, etc.); public deidentification commitment for stored data (§1798.140(m)). **CIPA §631** litigation risk low–medium after SB 690 removed the private right of action for §638.51 website claims; US counsel. | Medium-high · Secondary (CPPA snippets, WilmerHale) + prior knowledge (statute) | CPPA; WilmerHale |
| **US — other states** (VA, CO, CT, UT, TX, OR, MT, IA, DE, NH, NJ, NE, TN, MN, MD, IN, KY, RI) | respective state acts; UOOM rules (CO Rule 5) | Defensible with notice + opt-out (notice) | Defensible with notice + opt-out (subset) | Opt-out models for targeted ads, sale, profiling only; none requires opt-in for first-party non-sensitive analytics; processor contract; pseudonymous/deidentified carve-outs. Thresholds mostly ≥ 100k residents (MD 35k). | Medium-high · Secondary (dates) + prior knowledge (statutes) | MultiState, AFS, Sheppard Mullin |
| **Canada (federal)** | PIPEDA Sch. 1 Principles 4.3, 4.1.3 | Defensible with notice + opt-out | Defensible with notice + opt-out (subset) | Implied consent for non-sensitive information with notice and an easy opt-out; notice of foreign processing. | Medium · Prior knowledge | OPC guidance (LIKELY) |
| **Canada — Quebec** | Law 25 (P-39.1) ss. 8.1, 17 | **Contested — cautious reading: Not without opt-in** | Contested | s. 8.1: technology able to identify, locate or profile must be **off by default** (CAI draft guidance reads it as express consent); whether country lookup "locates" and a daily hash "identifies" is open. s. 17: privacy impact assessment and written agreement before communicating PI outside Quebec. Quebec is not detectable from country data. Not in the register's list (ADR-0027). On the cautious reading, the route to lawful use is the **consent-gated mode** (C-55), applied to all of Canada because Quebec cannot be detected. | Low-medium · Secondary | McCarthy Tétrault, IAB Canada |
| **Brazil** | LGPD Arts. 3, 7(IX), 10, 33; ANPD cookie guide (18 Oct 2022) | Defensible with notice + opt-out (notice + documented LIA) | Defensible with notice + opt-out (subset) | Legitimate interest with a documented assessment; EU–Brazil mutual adequacy (EC decision ~26 Jan 2026; ANPD Resolution CD/ANPD 32/2026). | Medium-high · Secondary | Mayer Brown, White & Case, Tozzini |
| **Argentina** | Law 25.326 Arts. 5, 12 | Contested | Contested (subset) | Consent is the default; dissociated/anonymous data out of scope; no legitimate-interest basis; EU adequate. | Low · Prior knowledge | — |
| **Mexico** | LFPDPPP (DOF 20 Mar 2025) | Defensible with notice + opt-out (privacy notice, tacit consent) | Defensible with notice + opt-out (subset) | Disclosure to a processor is a "remisión" needing no consent. | Medium · Secondary | Garrigues, Basham, EY |
| **Chile** | Ley 21.719 (in force 1 Dec 2026) | Defensible with notice + opt-out — provisional | Defensible with notice + opt-out (subset) — provisional | Legitimate interest; secondary rules pending; whether the EU is designated adequate is unverified; a postponement bill passed Senate first reading 28 Oct 2026 (not enacted). | Low · Secondary | Garrigues, Diario Constitucional |
| **Colombia** | Law 1581/2012 Arts. 9, 26 | **Not without opt-in** (research: X/C) | Not assessed | Prior, express, informed authorisation if the transient IP/hash is personal data; EU transfers allowed. Route to lawful use: the **consent-gated mode** (C-55). | Low-medium · Prior knowledge | — |
| **China** | PIPL Arts. 3(2), 13, 38–39, 53; CAC Provisions (22 Mar 2024) | **Not without opt-in** | Not assessed | No legitimate-interest basis; consent plus Art. 39 separate consent for export; the 2024 exemption (< 100k individuals/yr) relieves only the transfer mechanisms; Art. 53 representative. Route to lawful use: the **consent-gated mode** (C-55). | Medium · Secondary + prior knowledge (statute) | Latham, Hogan Lovells, Fangda |
| **India** | DPDP Act 2023 ss. 3, 5–7, 16; DPDP Rules 2025 (notified 13–14 Nov 2025) | **Not without opt-in from ~13–14 May 2027**; not yet applicable on 2026-11-12 | Not assessed | Consent with notice once in force; s. 7 "legitimate uses" do not cover analytics. Not in the register's list (ADR-0027). Route to lawful use: the **consent-gated mode** (C-55). | Medium · Secondary | AZB, Mondaq |
| **Russia** | 152-FZ Arts. 9, 12, 18(5) (as amended by 23-FZ, in force 1 Jul 2025) | **Not without opt-in — and localisation** | Not assessed | The blocker is **localisation**: storing Russian citizens' PD in foreign databases is prohibited, including at initial collection; consent alone does not cure it. Whether it reaches non-Russia-directed sites, and whether transient processing is "recording", is for counsel. **Consent-gated mode (C-55) does not cure localisation**; the only measure offered is `exclude_countries` (C-58): events geolocated to RU are dropped at the gateway and only counted. | Medium-high · Secondary | b1, Lidings, Konsu |
| **Türkiye** | KVKK 6698 Arts. 5, 9 (Law 7499); Cookie Guide (Temmuz 2025) §5.9; Transfer Regulation 10 Jul 2024 (RG 32598) | Defensible with notice + opt-out — research flags it contested | Defensible with notice + opt-out (subset) — contested | First-party analytics limited to audience measurement "Kriter B kapsamında değerlendirilebileceği düşünülmektedir" (strictly necessary); IP masking, anonymous statistics, no cross-site tracking, not passed to third parties; fingerprinting is outside the guide's scope (§1.2). Notice (Art. 10). Transfer: standard contract notified to the Board within 5 business days (LIKELY; not re-read) by the controller; VERBIS registration is a tenant matter. | Medium · Primary source read (KVKK guide) | kvkk.gov.tr guide |
| **Israel** | PPL as amended (Amendment 13, in force 14 Aug 2025) | Contested (OK with notice likely) | Contested (subset) | Notice-oriented; historic acceptance of notice-based analytics UNVERIFIED; EU adequate to Israel. | Low · Secondary | IAPP, Pearl Cohen |
| **Saudi Arabia** | PDPL; Transfer Regulations | Contested | Contested (subset) | Consent default; legitimate interest possible except sensitive data. | Low · Prior knowledge | — |
| **UAE — DIFC / ADGM** | DIFC DP Law 2020; ADGM DPR 2021 | Defensible with notice + opt-out | Defensible with notice + opt-out (subset) | GDPR-like legitimate interest; EU recognised adequate. | Low-medium · Prior knowledge | — |
| **UAE — federal** | PDPL (Decree-Law 45/2021) | Contested | Contested (subset) | Executive regulations not confirmed issued. | Low · Prior knowledge (UNVERIFIED) | — |
| **South Africa** | POPIA ss. 11(1)(f), 18, 72 | Defensible with notice + opt-out | Defensible with notice + opt-out (subset) | Legitimate interest; transfer to adequate law or binding agreement. | Medium · Prior knowledge | — |
| **Nigeria** | NDPA 2023; GAID 2025 | Contested | Contested (subset) | GAID cookie provisions may require consent (UNVERIFIED). | Low · Prior knowledge | — |
| **Kenya** | DPA 2019 ss. 30, 48 | Contested (OK with notice likely) | Contested (subset) | Legitimate interest; proof of transfer safeguards to the ODPC. | Low · Prior knowledge | — |
| **Japan** | APPI Art. 31; Telecommunications Business Act external-transmission rule (in force 16 Jun 2023) | Defensible with notice + opt-out (notice) | Defensible with notice + opt-out (subset) | APPI "personally referable information" not triggered for a processor that does not link (LIKELY). In-scope tenants (SNS, search, e-commerce, information-providing sites) must, **before** sending, notify or publish in Japanese the information sent, its purpose and the recipient (snippet in [`tenant-privacy-notice.md`](tenant-privacy-notice.md)). EU adequate (2019). | Medium · Secondary | Transatlantic Law, Mori Hamada |
| **South Korea** | PIPA Arts. 15, 28-8 | Contested | Contested (subset) | Consent default with widened non-consent bases (2023); overseas entrustment disclosed in the privacy policy; EU–Korea mutual adequacy (2021). | Low · Prior knowledge | — |
| **Singapore** | PDPA ss. 15A, 26; Schedules 1–2 | Defensible with notice + opt-out | Defensible with notice + opt-out (subset) | Deemed consent by notification or legitimate-interest/business-improvement exceptions; Transfer Limitation Obligation contract. | Medium · Prior knowledge | — |
| **Vietnam** | PDP Law 91/2025/QH15 (in force 1 Jan 2026); Decree 356/2025/ND-CP | **Not without opt-in** | Not assessed | Consent-centric; storing data collected in Vietnam on foreign servers is a transfer: Transfer Impact Assessment filed with the Ministry of Public Security within 60 days. Route to lawful use: the **consent-gated mode** (C-55). | Low-medium · Secondary | Tilleke, FPF, Vietnam Briefing |
| **Indonesia** | PDP Law 27/2022 Arts. 20, 56 | Contested | Contested (subset) | Legitimate interest; transfers need equal protection, safeguards or consent; implementing regulation unverified. | Low · Prior knowledge | — |
| **Thailand** | PDPA ss. 24(5), 28–29 | Defensible with notice + opt-out | Defensible with notice + opt-out (subset) | Legitimate interest; PDPC transfer safeguards. | Medium · Prior knowledge | — |
| **Australia** | Privacy Act 1988, APPs 3, 5, 8 | Defensible with notice + opt-out (notice) | Defensible with notice + opt-out (subset) | Applies to entities over A$3m turnover among others; the second stage of reform ("fair and reasonable" test) is an exposure draft only (31 Aug 2026). | Medium · Secondary | HSF Kramer, G+T |
| **New Zealand** | Privacy Act 2020, IPP 3/3A, 12 | Defensible with notice + opt-out (notice) | Defensible with notice + opt-out (subset) | IPP 3A (indirect collection notice) in force 1 May 2026; processor exemption for cross-border disclosure (s. 11). | Medium · Secondary | NZ Ministry of Justice, Bell Gully |
| **All other jurisdictions** | — | Not assessed | Not assessed | Tenants with material traffic there should take local advice. | — | — |

## 4. Summary to quote

> The tracker sets no cookies and stores nothing on the device except an explicit opt-out choice, and no IP address
> or raw User-Agent is ever written to disk; but under EU law (ePrivacy Art. 5(3) as read by EDPB Guidelines 2/2023
> v2.0) a script that sends browser information is still "access" to the device, so operating without consent depends
> on national exemptions. In its `standard` profile the solution is designed to meet the published audience-measurement
> criteria of France (CNIL, self-assessed — not certified), Spain (AEPD), Italy (Garante) and the Netherlands
> (Telecommunicatiewet art. 11.7a) — likely also Luxembourg, with low confidence — and, with a privacy notice and an opt-out link, the statutory routes of the United
> Kingdom (PECR Sch. A1 para 5, for the tenant's own analytics) and Switzerland (FADP/FDPIC). It would **not** be
> compliant without end-user opt-in in Germany (TDDDG §25; our `strict` profile without a visitor identifier is the
> most defensible configuration but remains contested), Austria, Belgium, Denmark, Sweden, Finland, Norway, Poland,
> Czechia and — absent verified local guidance — the remaining EU/EEA states except Ireland and Greece, which are
> contested; outside Europe it would not be compliant without opt-in in China, Vietnam, Colombia and India (from about
> May 2027), nor in Russia, where data-localisation rules are the obstacle even with consent; Quebec is contested and,
> on a cautious reading, also requires opt-in. Where opt-in is required, tenants can use the tracker's consent-gated
> mode, which sends nothing until the visitor has consented through the tenant's consent tool; for Russia the only
> measure offered is excluding the country, so that its visitors' events are dropped at ingest. Two UK points are open: sharing even anonymous aggregates with SCF may fall outside the statutory
> exception, and the IP/User-Agent-derived visitor identifier may not be covered by it. These statements were prepared
> by engineers from primary sources where reachable, rest on secondary sources or prior knowledge for many states, and
> have not yet been reviewed by counsel.

## 5. API analytics

API telemetry contains no end-user identifiers by design: the collector keeps an allow-list (tenant, service,
normalised route, method, status code, latency) and drops client addresses, user agents, raw URLs and queries,
headers, bodies and `enduser.*`/`user.*` attributes before anything is stored (ADR-0009, ADR-0012). It involves no
access to a visitor's terminal equipment by us. We therefore do not classify it per jurisdiction; the residual risk —
personal data leaking into a path the normaliser does not recognise — is handled by the erasure workflow
([`erasure.md`](erasure.md)).

## 6. Questions for counsel

1. **UK** — Does sharing anonymous per-tenant aggregates with SCF operators breach Sch. A1 para 5(1)(c)? Is the IP/UA-derived
   daily identifier "automatically emitted" information under para 5(2) / reg. 6(2)(b)?
2. **France** — Is ingest-time bot/inflation filtering, run per tenant in memory with trust scores from aggregates only,
   "réutilisation … pour le propre compte du prestataire (… lutte contre la fraude)" under the CNIL criterion? Do
   tenant dashboards with `anonymous_reports` on (rows < 10 merged into "Other", counts rounded to 10; C-51) meet the
   "anonymous reports" criterion for every filter combination, and what follows for a tenant that switches it off?
   Do custom events plus wallet events fit the limit of three event types? (Until answered, the tenant notice claims
   the criteria only for sites that send page views alone, C-71.)
3. **Roles** — Does the tenant-instructed disclosure of anonymous aggregates to SCF operators make the SCF programme or the service operator a
   (joint) controller for any processing (*Wirtschaftsakademie* C-210/16 analogy)? Is the service operator's position
   as controller for portal account data and audit logs (C-59) correctly drawn? Does a tenant switching public stats
   on (C-14) change any role?
4. **Germany** — What residual risk does the `strict` profile without a visitor identifier (its default, C-53) carry
   under TDDDG §25 and DSK OH v1.2 Rn. 87–90 (German counsel)? Is the JS challenge and proof-of-work that `strict`
   still runs (C-33) itself "access" to the terminal equipment beyond what is "unbedingt erforderlich"?
5. **Anonymisation** — Which standard applies to the aggregates while EDPB Guidelines 02/2026 are a consultation
   draft? Does the CNIL/AEPD 25-month cap reach genuinely anonymous aggregates, which are kept indefinitely and serve
   every range older than the event-level window (C-54)?
6. **Art. 11** — Is the Art. 11(2) position (no identification once `K_day` is destroyed) sound, given that the wording
   used here was taken from memory (EUR-Lex unreachable), and how should data-subject responses be worded?
7. **Transfers / representatives** — Art. 27 for non-EU tenants and a non-EU operating entity; SCCs/TIA for any
   non-EU staff access; whether any service outside the EU-hosted data path listed in
   [`data-residency.md`](data-residency.md) §4 (C-26: GitHub including GitHub sign-in, Let's Encrypt, npm, the
   Stellar network for audit anchoring, optional on-chain sources, alert channels) is a transfer of personal data —
   none receives visitor-derived data by design, restore drills run only on EU infrastructure and build automation holds no
   production credentials (C-56, C-79). Is the published audit-chain head hash (C-63) free of personal data, as we
   assume? Do requests to the configured Stellar RPC/Horizon hosts carrying a sign-in account (C-10) raise a transfer
   question once their location is fixed (strategy OP-26)?
8. **Low-confidence rows** — Verify against regulator primary texts: CZ, PL, PT, GR, LU, AT, DK, SE, NO and the 13
   unverified member states plus IS, LI. May this table be published with a "counsel-reviewed on `<date>`" stamp?
9. **US** — CIPA §631 "extension vs capability" exposure for a separate-entity processor after SB 690; SB 690's
   operative date and chapter number (UNVERIFIED).
10. **Quebec** — Does country-level geolocation plus a daily hash "locate"/"identify" under s. 8.1? Is a s. 17 PIA
    needed per tenant or once by the service operator?
11. **Türkiye** — Does "not passed to third parties" (§5.9) allow a processor? Confirm the 5-business-day
    standard-contract notification and whether adequacy decisions exist.
12. **Russia** — Does 152-FZ Art. 18(5) apply to non-Russia-directed tenant sites, and is transient in-memory
    processing "recording"? Is `exclude_countries` (geolocate in memory, drop, count only; C-58) sufficient, given
    that geolocation itself processes the IP?
13. **China** — Does PIPL Art. 3(2) reach aggregate audience measurement for a foreign site?
14. **Wording** — Approve the public wording of §4 (no "certified/validated by the CNIL" language).
15. **Consent-gated mode** — For the "Not without opt-in" rows, is a tracker that sends nothing before
    `grantConsent()` (C-55) sufficient on our side, and what must tenants' consent tools record? Does loading the
    script file itself before consent raise an issue anywhere?
16. **Switzerland** — Does a 90-day (or tenant-chosen 30-day) event-level window meet FADP Art. 31(2)(e) /
    FDPIC §3.8.2 "usually … immediately" (C-54)?
17. **Belgium** — The research did not assess `strict` in Belgium; the table and C-41 (as reworded) say "Not
    assessed". Can `strict` without a visitor identifier be classed better than "Not without opt-in" there?
18. **Twin website without identifiers** — Events without a visitor identifier are sent, with a fresh random surrogate
    per event, to a per-site twin Umami website and contribute page views, country and device counts only (C-73).
    Does this change the assessment for `strict` (Germany "Contested"; the "Not assessed" `strict` cells), or for
    `off_in` countries such as the UK under para 5(2)?
19. **Per-subnet event counting** — Where identifiers are off, the multiplicity layer counts events per truncated
    subnet, in memory, with a keyed hash and no IP kept (C-80). Is this acceptable where identifiers are off — in
    particular under the CNIL "no reuse, including fraud prevention" criterion and the DSK's reading of §25 TDDDG?
