# ADR-0017: Data residency

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** privacy.gdpr-no-consent, privacy.data-residency, privacy.strategy-docs, docs.privacy, privacy.residency-statement (supports handover.domain-transfer)

## Context
UsageMap declares its data-residency choices explicitly (privacy.data-residency) and publishes them as a residency
statement (privacy.residency-statement). Residency is also part of the consent-free GDPR posture (privacy.gdpr-no-consent, ADR-0027): if visitor-derived data
leaves the EU/EEA, Chapter V transfer rules apply on top of the ePrivacy analysis.

What research established:
- **EU hosting is not cheaper to abandon.** After the 2026 DRAM-driven price rises, US-owned clouds in EU regions
  cost about the same as EU-owned ones (DigitalOcean/Linode/Vultr 2 vCPU/4 GB at $20–24/month, versus UpCloud
  Starter 2/4 at €12 and Hetzner CPX22 at €16.99–19.99, prices of 2026-11-12, excl. VAT) and bring CLOUD Act
  questions into the statement.
- **A CDN in front of ingest sees every visitor IP** and becomes a GDPR sub-processor; EU-only processing is
  often a paid add-on (Cloudflare's Data Localization Suite is Enterprise-only). Cloudflare-class global edges
  also failed three times in four months (2025-11-18, 2025-12-05, 2026-02-20, each from Cloudflare's own
  post-mortems).
- **Hosting location does not end the transfer analysis.** Remote access to personal data in the EU by staff in
  a third country is itself a transfer under the EDPB's Guidelines 05/2021 (LIKELY, not re-read; EUR-Lex was
  unreachable) and needs SCCs plus a transfer impact assessment, or must be limited to anonymous aggregates
  (Arts. 44+ transfers).
- **Ownership labels are partly unverified.** Hetzner (DE, privately held) and OVHcloud (FR, listed,
  family-controlled) are EU-owned at label LIKELY; UpCloud (FI) is EU-based with investors unverified; Gcore's
  ownership is unverified; Contabo is majority-owned by KKR and must not be called EU-owned.
- **On-chain correlation needs a public dataset that lives at Google.** SDF's Hubble dataset is on BigQuery; its
  location was not verified (likely US). Only tenant-declared public identifiers are sent and only public
  aggregates come back. A rebuildable fallback reads the public Galexie
  ledger lake (`s3://aws-public-blockchain/…` or Lightsail Quasar) (§3.6).
- Russian localisation (152-FZ Art. 18(5) as amended, in force 2025-07-01) and Vietnam's transfer filing (PDP Law
  91/2025, in force 2026-01-01) cannot be met by EU hosting at all; they are handled as "not compliant without
  opt-in" in the jurisdiction table, not by residency.

## Options considered
1. **EU/EEA only, on EU-based providers, nothing in front of ingest (chosen).** Pros: one clean statement for
   tenants' privacy notices and DPAs; no Chapter V transfer for visitor data; price is competitive in 2026.
   Cons: smaller provider ecosystem; ownership is LIKELY rather than verified for some providers; we must run
   our own DNS failover and DDoS posture without a global edge.
2. **EU regions of US-owned clouds (AWS, GCP, DigitalOcean, Linode, Vultr).** Pros: mature managed services,
   multi-AZ SLAs (AWS/GCP 99.99 % with ≥ 2 zones). Cons: not cheaper after 2026; US parent brings CLOUD Act
   exposure that tenants' counsel will ask about; managed databases undermine rebuild-from-repo (ADR-0018).
3. **EU origin behind a CDN/proxy for ingest.** Pros: DDoS absorption, anycast. Cons: the CDN processes full IPs
   (a new sub-processor, often non-EU-owned); a single global failure domain; contradicts ADR-0005's
   in-process TLS termination and IP handling.
4. **Single-country hosting (e.g. Germany only).** Pros: simplest legal story. Cons: one or two providers only,
   which defeats the two-independent-provider design that 99.99 % needs (ADR-0018, ADR-0020).
5. **No exceptions at all (self-host source control and on-chain data).** Pros: purest statement. Cons:
   GitHub is effectively required by the handover and public issue-tracker model; self-hosting it adds an
   operated system; on-chain correlation would need our own ledger ingestion from day one.

## Decision
1. **All visitor-derived and telemetry data** — every byte that a tracker or tenant SDK sends, and everything
   derived from it (spool, queues, Umami events, `scf` aggregates, API metrics, logs, backups,
   dumps) — is processed and stored only in the EU/EEA, on EU-based providers: Hetzner (Germany/Finland), UpCloud
   (Finland-based company, EU locations only) and OVHcloud (France-based company, EU location). `probe-d`, a small
   probe-only VPS at a fourth EU provider (ADR-0018, C-25), sends synthetic events for a canary site and holds no
   visitor data. Node placement is in ADR-0018.
2. **"EU-based", never "EU-owned" (C-26).** Providers are described as "EU-based" (headquarters and data centres in
   the EU/EEA). "EU-owned" is not claimed for any provider, because the research did not verify ownership from
   primary sources: it labels Hetzner and OVHcloud EU-owned at LIKELY and leaves UpCloud's investors unverified.
3. **Backups** go to object storage at **two** of these providers — UpCloud and OVHcloud (ADR-0021, C-29).
   **DNS** is served by **two** EU-based authoritative providers (ADR-0020); DNS providers see resolver queries,
   never request content. The second DNS provider is chosen at implementation from providers whose ownership is
   verified (C-26).
4. **No CDN, proxy, WAF service or other third party sits in front of ingest.** Edge nodes terminate TLS
   themselves (ADR-0005) and serve the tracker files.
5. **Declared exceptions — the complete list (C-26).** They sit outside the EU-hosted data path and none of them
   receives visitor-derived data:
   - **GitHub** (US): source code, releases, issues, the status-page history, and scheduled probes of public
     endpoints (ADR-0022). GitHub never holds production credentials;
     deployments run from a service-operator workstation or a pull-based agent on the nodes (C-79, ADR-0019).
     **Restore drills run on
     our own EU infrastructure, never on GitHub-hosted runners; backup keys never leave it; only the result
     (pass/fail, timings, checksums) is published** (C-56, ADR-0021).
   - **GitHub as a sign-in provider** (US): the member's GitHub identity only (ADR-0014).
   - **Let's Encrypt** (US): certificate requests, which contain our hostnames.
   - **npm registry** (US): the tracker package.
   - **The Stellar network**, when audit-chain anchoring is enabled: a hash only (C-63, ADR-0014).
   - **Optional on-chain correlation**, **off by default**, per tenant: Google BigQuery's public Hubble dataset
     (dataset location to be confirmed) or public ledger files on AWS Open Data; public ledger data only;
     requests contain only tenant-declared public ledger identifiers (ADR-0028).
   - **Alert channels:** alerts reach the service operator's team through channels that team chooses; each
     is recorded in the sub-processor list and carries no visitor data (ADR-0022).
6. **Service-operator staff access from outside the EU** to event-level data is treated as a possible transfer
   and is a question for legal counsel. Until answered, the default is: event-level access is limited to EU-located
   staff of the service operator; SCF operators never see event-level data in any case, only the anonymous
   thresholded aggregates (ADR-0013, ADR-0027).
7. The IaC encodes region constraints (only EU locations are valid values), and a validation check fails a plan that

   creates a resource outside them. Outbound internet connections are limited to the components listed in C-10,
   in an egress-allow-listed network (ADR-0019). The full byte-by-byte statement lives in
   `docs/privacy/data-residency.md`.

## Consequences
Positive:
- Tenants can name one processor, EU hosting and a short sub-processor list in their notices and DPAs.
- The statement is testable: the IaC check, the data inventory tests (no IP/UA persisted) and the absence of
  any proxy in the ingest path are all inspectable in the repository.

Negative / costs:
- We carry DDoS and DNS failover ourselves; there is no global edge to absorb floods.
- Ownership is LIKELY or unverified, so we say "EU-based", which is a weaker statement than "EU-owned" would be.
- On-chain correlation, when enabled, sends queries to a US company (Google or AWS); even though it is public ledger data, a
  tenant's declared G-account may belong to a natural person, so it stays opt-in.

Must do / watch:
- Keep `docs/privacy/data-residency.md` and the sub-processor list in step with every provider change.
- Re-check provider ownership before each release of the residency statement and on any acquisition news; describing any provider as more than
  "EU-based" would need verified primary evidence and a change to C-26.

Revisit if: counsel rules that a declared exception needs a transfer mechanism; a provider changes ownership;
Hubble becomes available in an EU location; or a tenant population appears that needs non-EU localisation.

Unproven: the BigQuery job and its dry-run cost guard (S-10); the IaC region check exists only as a design.

## Open points
1. Open: which second DNS provider (with verified ownership) and which two ingest domains.
2. Open: the location of the BigQuery Hubble dataset, and whether a US-hosted query service is acceptable next to
   this statement — closes with S-10 (location check).
3. Open: whether service-operator staff outside the EU may access event-level data, and under which transfer
   mechanism — closes with legal counsel.
