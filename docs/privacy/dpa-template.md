# Data-processing agreement — template

> **Not legal advice.** This is a **template for counsel**, written by engineers to make the
> technical commitments precise. It has not been reviewed by a lawyer and must not be offered to tenants until counsel
> has approved it (a review is for `<OPERATOR-ENTITY>` to commission). It is intended to
> cover the content GDPR Art. 28(3) requires of a processor contract; counsel must check the clause mapping. The
> research recommends one DPA that also carries a CCPA service-provider addendum, Swiss FADP terms and a KVKK annex for
> Turkish tenants; those are Addenda A–C. Technical
> commitments follow the design-decision register C-01…C-112 (`docs/adr/README.md`). "Service Operator"
> is the hosting entity; "SCF operator" means a portal user with the `operator` or `operator_admin` role (C-59).

**Parties**

- **Controller:** `<TENANT LEGAL NAME>`, `<ADDRESS>`, `<COUNTRY>`, represented by `<NAME, ROLE>` ("Tenant").
- **Processor:** `<OPERATOR-ENTITY>`, `<OPERATOR-ADDRESS>`, `<COUNTRY>`, represented by `<NAME, ROLE>` ("Service Operator").

Acceptance: electronically at enrollment by a tenant `owner`; the accepted version and date are stored with the tenant.

## 1. Subject matter and duration

1.1 The Service Operator processes personal data on behalf of the Tenant to provide web and API analytics as described in
Annex 1, for as long as the Tenant is enrolled, plus the deletion periods in clause 10.

1.2 The service is free of charge; this agreement creates no payment obligation.

## 2. Instructions

2.1 The Service Operator processes personal data only on the Tenant's documented instructions, including with regard to
transfers to a third country, unless required to do so by law to which the Service Operator is subject; in that case the
Service Operator informs the Tenant before processing unless that law prohibits it.

2.2 The Tenant's instructions are: this agreement; the service documentation in force at enrollment
(`docs/privacy/strategy.md` and the register `docs/adr/README.md` with its clarifications); and the settings the
Tenant chooses in the portal (tracker profile, consent-gated mode, `visitor_id` and its country list,
`exclude_countries`, `anonymous_reports`, public stats and share keys, retention within the offered range, on-chain
correlation on/off, erasure requests).

2.3 **Instruction to publish aggregates to SCF operators.** The Tenant instructs the Service Operator to make available to the
platform's SCF operators ("SCF": the ecosystem programme that runs the operator view) anonymous per-tenant aggregate statistics computed for the Tenant's own dashboard, subject to a
minimum count (default 10) and rounding (default nearest 10), applied in the database functions through which every
SCF-operator read passes (C-17). The same threshold and rounding apply to the Tenant's `metrics_endpoint` and signed
traction snapshots, which never include the trust score (C-47). The `metrics_endpoint` is readable by SCF operator
keys, by share keys the Tenant creates, and by the public only if the Tenant switches public stats on (C-14). The
Service Operator gives SCF no access to event-level data and computes no cross-tenant visitor de-duplication or
reach. `<Counsel: confirm the UK position for UK-established
tenants — jurisdictions.md §2.>`

2.4 **Accuracy filtering.** The Tenant instructs the Service Operator to filter bots and artificial inflation of the Tenant's
statistics, per tenant, on the Tenant's own traffic, in memory, persisting only verdicts and reason codes.
`<Counsel: reconcile with the CNIL "no reuse, including fraud prevention" criterion — strategy.md §16.>`

2.5 The Service Operator informs the Tenant immediately if, in its opinion, an instruction infringes applicable
data-protection law.

## 3. No reuse

3.1 The Service Operator does not process the personal data for its own purposes or for any third party's purposes, including
improving its service or fighting fraud outside clause 2.4; does not pool raw data across tenants; does not combine
it with other data; does not sell or share it.

3.2 The Service Operator does not attempt to re-identify data subjects and destroys the daily identifier key as described in
Annex 2.

## 4. Confidentiality

The Service Operator ensures that persons authorised to process the personal data have committed themselves to confidentiality
or are under an appropriate statutory obligation of confidentiality, and that access is limited to what their role
requires.

## 5. Security

The Service Operator implements the technical and organisational measures in Annex 2, reviews them at least yearly and on
every change to the register affecting them, and does not reduce the overall level of protection without notice under
clause 6.

## 6. Sub-processors

6.1 The Tenant gives general written authorisation for the sub-processors listed in Annex 3.

6.2 The Service Operator informs the Tenant of any intended addition or replacement at least `<30>` days in advance through the
process in `docs/privacy/sub-processors.md` §4; the Tenant may object on reasonable data-protection grounds within that
period. If the objection cannot be resolved, the Tenant may terminate and have its data deleted (clause 10).

6.3 The Service Operator imposes on each sub-processor, by contract, data-protection obligations equivalent to this agreement
and remains liable to the Tenant for the sub-processor's performance.

## 7. Assistance with data-subject rights

7.1 Taking into account the nature of the processing, the Service Operator assists the Tenant by appropriate technical and
organisational measures in responding to requests from data subjects, in particular through: the opt-out mechanism and
GPC/DNT handling (objection); the consent-gated mode, which stops sending on `revokeConsent()` (withdrawal of consent,
C-55); the self-service erasure workflow, which also covers daily aggregates and API routes
(`docs/privacy/erasure.md`; C-46); and response templates.

7.2 The Tenant acknowledges that the service is designed so that neither party can identify a visitor from stored data
once the daily key is destroyed (GDPR Art. 11). The Service Operator does not keep additional information to identify data
subjects.

7.3 The Service Operator forwards to the Tenant any data-subject request it receives about the Tenant's data within
`<5>` business days and does not respond to it itself except on the Tenant's instruction.

## 8. Assistance with security, breaches and impact assessments

8.1 The Service Operator assists the Tenant in ensuring compliance with its security obligations, breach notification duties,
data-protection impact assessments and prior consultations, taking into account the nature of processing and the
information available to the Service Operator. The platform DPIA (`docs/privacy/dpia-draft.md`) is provided for the Tenant to
adopt or adapt.

8.2 **Personal-data breach.** The Service Operator notifies the Tenant without undue delay, and in any case within
`<48>` hours, after becoming aware of a personal-data breach affecting the Tenant's data, with the information then
available (nature, categories and approximate numbers, likely consequences, measures taken or proposed, contact
point), and supplements it as information becomes available.

## 9. Information and audits

9.1 The Service Operator makes available all information necessary to demonstrate compliance with this agreement: the public
repository (code, IaC, register, this privacy pack), the published evidence in `docs/evidence/`, and the audit log
entries concerning the Tenant.

9.2 The Service Operator allows for and contributes to audits, including inspections, by the Tenant or an auditor mandated by
it, with `<30>` days' notice, during business hours, at the Tenant's cost, not more than once a year unless after a
breach or on a supervisory authority's request. Because the service is open source and free, documentary audits are
the default.

## 10. End of processing: deletion or return

10.1 On termination the Tenant may export its aggregates and events through the API for `<30>` days. The Service Operator then
deletes all personal data of the Tenant (purge as for removal by an SCF operator, ADR-0015), lets backups expire on
their schedule so that the data leaves all backups within 56 days (Annex 2, item 9; C-29 as corrected by C-112), and confirms deletion in
writing, unless law requires storage.

10.2 Removal of a non-ecosystem project by an SCF operator stops ingest within 60 seconds, hides the data and schedules
the purge 30 days later; an `operator_admin` can restore the Tenant until the purge runs, after which it is
irreversible (ADR-0015; C-08). Re-enrollment tombstones for the Tenant's domains, GitHub identity and Stellar accounts
remain until an `operator_admin` lifts them (C-64).

## 11. International transfers

11.1 The Service Operator processes and stores the Tenant's personal data only in the EU/EEA (Annex 3;
`docs/privacy/data-residency.md`).

11.2 Any access by Service Operator staff located outside the EU/EEA to personal data is permitted only under a transfer
mechanism `<SCCs Module 3 / Module 4 + transfer impact assessment — counsel>`.

11.3 The services outside the EU-hosted data path are listed completely in `docs/privacy/data-residency.md` §4; none of
them receives visitor-derived data (C-26). Restore drills run only on the Service Operator's EU infrastructure and
backup keys never leave it (C-56).

## 12. Handover of stewardship

The Tenant acknowledges that operation is expected to pass to a community-appointed successor service operator
(`docs/handover-plan.md`). The Service Operator gives at least `<30>` days' notice; the successor accepts this agreement (or a
materially equivalent one) before it receives any personal data; the outgoing Service Operator deletes its copies
after a confirmed migration (`docs/privacy/data-residency.md` §8). `<Counsel: novation mechanism.>`

## 13. Liability, law and jurisdiction

`<Counsel: liability allocation consistent with a zero-fee public-good service; governing law `<…>`; courts `<…>`.>`

## 14. Precedence

In case of conflict this agreement prevails over other terms between the parties on data protection; Addenda A–C
prevail for their jurisdictions.

---

## Annex 1 — Description of the processing

| Item | Description |
|---|---|
| Categories of data subjects | Visitors of the Tenant's websites; end users of the Tenant's APIs (no identifiers stored); the Tenant's users of the portal |
| Categories of personal data | Transient (memory only): IP address, User-Agent, request headers, per-event retry IDs, multiplicity counters keyed per truncated subnet (no IP kept, C-80), visit cache tokens (engine proxy on the core nodes, C-74). Transient on disk: the local edge spool of reduced records (no IP, no raw User-Agent), deleted on acknowledgement, never older than 72 hours (C-77). Stored, pseudonymous: daily per-site session/visit identifiers (not created where the visitor identifier is off; such events are stored under a per-site twin website and counted for page views, country and device only, C-02, C-73); page path (scrubbed of identifiers and secrets, C-52); referrer host (`standard`); screen-width class and primary language (`standard`); country; browser family/major, OS family, device class; timestamps; verdict tag (`v`/`s`); custom-event names and properties (guarded client- and server-side); wallet events for user actions only, with closed-set fields only (C-45, C-75). Not collected: page titles (C-89), TLS fingerprints (C-77). API: normalised routes, methods, status codes, latency histograms (no end-user data). Full list: `docs/privacy/data-inventory.md` |
| Special categories | None intended. The Tenant must not send any |
| Nature and purpose | Audience measurement and API usage analytics for the Tenant; accuracy filtering; anonymous aggregates to SCF on instruction; optional on-chain correlation from public ledger data for Tenant-declared contracts |
| Frequency | Continuous |
| Retention | Memory-only items: for the request (retry IDs 10 minutes, visit cache tokens 30 minutes). Local edge spool: deleted on acknowledgement, never older than 72 h; no copies elsewhere (C-77). Web event-level: 90 days by default, settable 30–395 days, 395 days being the hard maximum; the Tenant may choose a shorter period per site (C-54). Erasure selectors: until the job has finished plus 56 days (C-88, C-111, C-112). Aggregates: kept, serving older ranges. API rows: 1-minute 35 days, 1-hour 25 months, 1-day kept. Backups: 35-day window plus 14 days of previous blob versions; erased or expired data leaves all backups within 56 days (C-29, C-112) |
| Locations | EU/EEA only (Annex 3) |

## Annex 2 — Technical and organisational measures

1. **Minimisation at source.** Pinned tracker, no cookies, no device storage except the opt-out flag; query strings
   and fragments not sent and discarded at the gateway if received (C-65); `standard`/`strict` profiles, `strict`
   reading no client signal booleans and deriving no visitor identifier by default (ADR-0004; C-33, C-53); optional
   consent-gated mode (C-55); wallet Tier 0 only in `standard`, user actions only and nothing on page load,
   closed-set fields (C-13, C-45, C-75); no page titles (C-89).
2. **In-memory reduction before any disk.** Surrogate = 96 bits of `HMAC-SHA-256(K_day, site_id ‖ ip ‖ user_agent)`,
   computed from the full IP and raw UA in memory (C-34), or a fresh random value per event where the visitor
   identifier is off (C-02); IP truncated (IPv4 /24, IPv6 /48) for geolocation; country only; events from excluded
   countries dropped (C-58); page paths and custom events scrubbed by the `pathnorm` rule set, redaction of secrets and
   personal identifiers not switchable, folding setting `full` or `relaxed` only, with StrKeys, hashes, tokens and
   e-mail addresses always folded or redacted (C-52, C-89); IP and raw UA discarded at the end of the request; no IP in any log,
   spool, queue or database (ADR-0005, 0006, 0007).
3. **Key lifecycle.** `K_day` random, generated daily by one gateway node and pushed to its peers over a dedicated
   mutually authenticated port on the private mesh, all nodes switching at 00:00 UTC; held in locked memory, never
   written to disk, core dumps disabled, no unencrypted swap, destroyed at rotation (ADR-0007; C-04, C-66). The daily
   multiplicity key and the hourly challenge key `K_chal` are handled the same way (C-68).
4. **API sanitisation.** Attribute allow-list; exemplars, span events and links stripped; path normalisation with
   `{redacted}` for secrets and e-mails, before the persistent queue; spans discarded after derivation; logs refused
   (ADR-0009, 0012). Request headers other than our bearer token never logged, stored or forwarded.
5. **Isolation and access control.** PostgreSQL RLS enabled and forced on every table and partition; no runtime role
   with `BYPASSRLS`; isolation test matrix; canary tenants; every identifier in a request resolved under the caller's
   tenant context, composite tenant keys, and jobs acting for a tenant (erasure, purge) run under that tenant's
   context (C-87); Umami never internet-reachable, reachable internally only through the engine proxy with per-node
   mutual TLS and per-caller path allow-lists (C-60, C-74), per-tenant view-only identities whose password and API key
   are stored encrypted (C-40, C-85); outbound internet only for named components, to named destinations through an
   egress proxy (C-10);
   SCF reads only through allow-listed `op_*` functions that threshold, round and audit in one transaction (ADR-0003,
   0013; C-17); tenant dashboards with anonymous reports on by default (C-51).
6. **Authentication.** GitHub OAuth (`read:user` only) or Stellar wallet signature; passkeys mandatory for SCF
   operators, with a fresh assertion for sensitive actions (C-09); a fresh sign-in (≤ 10 minutes, passkey if
   registered) for sensitive tenant actions — confirming an erasure, transferring ownership, removing the tenant,
   deleting an account (C-87); server-side sessions, `__Host-` cookie,
   `Secure; HttpOnly; SameSite=Lax`, matching `Origin` and a custom header on every state-changing request (C-20);
   API keys and ingest tokens stored as HMAC with separate peppers per key kind and a recorded pepper version (C-05,
   C-81); SCF operator keys scoped, default expiry 90 days, at most 365 days (C-70), checked on every request; ingest tokens scoped, no expiry by default, revoked at the edge
   within 60 s (ADR-0014, 0016; C-06, C-21).
7. **Audit.** Hash-chained audit log of every SCF-operator read of tenant data and every privileged action
   (ADR-0014); tombstones for deleted accounts keep the chain valid without naming the person (C-57); the chain's head
   hash — no personal data — is published daily and optionally anchored on the Stellar ledger (C-63).
8. **Network and secrets.** Private WireGuard mesh; TLS on every public endpoint; secrets in SOPS + age; images
   referenced by digest and verified with cosign (ADR-0018, 0019); build automation never holds production credentials —
   deployments run from a Service Operator workstation or a pull-based agent on the nodes (C-79).
9. **Backups.** pgBackRest with two encrypted repositories (C-96, C-110) — in the single-VM profile (one EU
   region) one on the VM's own disk and one in a storage account in the same region; the
   full-size design places them in two storage accounts in two EU regions — the current layout is always
   the one in Annex 3 and [`data-residency.md`](data-residency.md); weekly full, daily differential, 35-day point-in-time window; weekly encrypted logical dump kept
   5 weeks; versioned containers — database nodes may delete current blobs but not previous versions, which a
   lifecycle rule removes after 14 days — so erased or expired data leaves all backups within 56 days (35-day retention + up to 7 days until the next full + 14 days as a previous version, data-model §14); weekly restore
   drill on the Service Operator's own EU infrastructure with a read-and-list-only credential, backup keys never
   leaving it (ADR-0021; C-29, C-56, C-79, C-108, C-110, C-112). Web events are
   spooled only on each edge node's own disk — no copies elsewhere — deleted on acknowledgement and never older than
   72 hours (C-18, C-77).
10. **Logging discipline.** Logs never contain IPs, User-Agents, request headers or tokens; a test enforces it;
    operational log retention 30 days (ADR-0022; C-71).
11. **Supply chain.** SRI, immutable versioned tracker URLs, reproducible build, signed manifest, staged npm publish
    with human 2FA approval, two-person release, SLSA Build L3 provenance, pinned dependencies and actions (ADR-0023).
12. **Vulnerability management.** Critical/high vulnerabilities patched or mitigated within 24 hours (ADR-0023,
    ADR-0031).
13. **Availability.** Two independent providers with four edge nodes (two per provider), fsync'd spool before
    acknowledgement, dual DNS, Patroni failover (ADR-0018, 0020; C-25).
14. **Erasure.** Self-service, audited, content-based erasure with preview and completion report, covering events,
    daily aggregate breakdowns and API routes, run under the requesting Tenant's context only; the literal selector is
    kept only until the job has finished plus 56 days and never enters the audit log (ADR-0030; C-46, C-87, C-88, C-111, C-112).
15. **Personnel.** Confidentiality commitments; least privilege; event-level access only for named administrators
    `<EU/EEA-located — counsel>`.

## Annex 3 — Sub-processors

As listed in `docs/privacy/sub-processors.md` at the date of acceptance (Hetzner, UpCloud, OVHcloud; the probe-only
fourth EU provider and the two DNS providers, which see no analytics payload; GitHub (including GitHub sign-in), npm, Let's
Encrypt, the alert channels and — when audit anchoring is enabled — the Stellar network, all without visitor data; on-chain sources only if the Tenant enables on-chain correlation). The list in
force is the one in the repository at the commit referenced in the acceptance record.

---

## Addendum A — CCPA / CPRA service-provider terms (California)

Applies where the Tenant is a "business" under Cal. Civ. Code §1798.140(d).

A.1 The Service Operator is a **service provider** (§1798.140(ag)) and processes personal information only for the business
purpose of providing analytics to the Tenant as described in Annex 1.

A.2 The Service Operator shall not: sell or share the personal information; retain, use or disclose it for any purpose other
than that business purpose or outside the direct business relationship with the Tenant; or combine it with personal
information received from or on behalf of other persons, except as permitted by the CCPA regulations (Regs §§7050–7051).

A.3 The Service Operator complies with the CCPA as applicable to service providers, provides the same level of privacy
protection, notifies the Tenant if it can no longer meet its obligations, and allows the Tenant to take reasonable steps
to stop and remediate unauthorised use.

A.4 **Deidentified data.** For data that is deidentified (§1798.140(m)), the Service Operator takes reasonable measures against
re-identification, publicly commits not to re-identify (statement in `docs/privacy/strategy.md` §1), and passes the same
obligation to any recipient. SCF receives only aggregates under the same commitment.

A.5 The Service Operator does not engage in cross-context behavioural advertising; Global Privacy Control is honoured by the
tracker in any case.

## Addendum B — Switzerland (FADP)

B.1 Where the Tenant is subject to the Swiss Federal Act on Data Protection, the Service Operator processes personal data only as
the Tenant itself would be permitted to, and only on the Tenant's behalf and not for its own purposes (cf. FDPIC
Guidelines v1.1, 06.10.2025, §3.8.2).

B.2 The Tenant relies on FADP Art. 31(2)(e) (non-personal statistical purposes) and TCA Art. 45c as described in
`docs/privacy/jurisdictions.md`; the Service Operator supports the required information and the mandatory right to refuse
(opt-out link, GPC/DNT).

B.3 Data are processed in the EU/EEA, which Switzerland treats as adequate (FADP Art. 16, Annex 1 DPO — to be confirmed
by counsel). References to the GDPR in this agreement are read as references to the FADP where it applies.

B.4 `<Counsel: event-level retention of 90 days by default (Tenant may shorten to 30 days; C-54) vs the FDPIC
expectation of anonymisation "usually … immediately" (strategy.md §16; jurisdictions.md §6 question 16).>`

## Addendum C — Türkiye (KVKK)

C.1 Where the Tenant is a data controller under Law No. 6698 (KVKK), the Service Operator acts as data processor on its behalf.

C.2 Processing takes place outside Türkiye (EU/EEA). The Tenant, as controller, is responsible for the transfer
mechanism under KVKK Art. 9 as amended and the Regulation of 10 July 2024 (RG 32598): the parties sign the **standard
contract** published by the KVKK Board (attached as Schedule C-1 in its official text), and the Tenant notifies it to the
Board within the statutory period `<5 business days — counsel to confirm>`.

C.3 The Tenant provides the information notice required by KVKK Art. 10 and handles VERBIS registration where it
applies.

C.4 The service is designed to meet the conditions of the KVKK Cookie Guide (Temmuz 2025) §5.9 for first-party audience
measurement (IP masking, anonymous statistics, no cross-site tracking). `<Counsel: whether "üçüncü taraflara
iletilmemesi" allows a processor and the SCF aggregates.>`

---

**Signatures** (or electronic acceptance record)

| | Tenant | Service Operator |
|---|---|---|
| Name | `<NAME>` | `<NAME>` |
| Role | `<ROLE>` | `<ROLE>` |
| Date | `<DATE>` | `<DATE>` |
| DPA version | `<vX.Y, commit SHA>` | |
