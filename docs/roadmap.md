# Roadmap

Where UsageMap stands and where it goes next. Each capability, with the tests that prove it, is listed in
[`capabilities.md`](capabilities.md); what changed release by release is in the [changelog](../CHANGELOG.md). Nothing
under "Next" or "Later" is a commitment until it ships.

## Now — shipped

**Web analytics**

- Pinned browser tracker (two privacy profiles, consent-gated mode), SRI manifest, npm package; old versions stay
  served unchanged.
- Ingest gateway: challenge and proof of work, verdicts and reason codes, durable spool.
- Umami as the private base engine, behind a mutual-TLS engine proxy (pinned, hardened, bot-check parity).
- Tenant web dashboard with page views, unique visitors, referrers, session duration, bounce rate, country, device and
  browser — verified next to raw.

**API analytics**

- OpenTelemetry ingest with tokens, the custom Collector distribution, the metrics writer; tested with four SDKs end
  to end.
- Path normaliser (Stellar keys, secrets and IDs folded or redacted), with its vector suite and fuzzing.
- Tenant API dashboard: volume, status codes, latency percentiles.

**Platform**

- Control plane: sign-in, projects, sites, self-service enrollment, domain verification, approval mode.
- Database with row-level security gates and the isolation matrix.
- SCF operator web and API dashboards, operator API keys and the metrics API.
- Trust score, API assurance levels, erasure workflow, Stellar Wallets Kit capture.
- Privacy pack, supply-chain document, threat model and monitoring plan.
- Monitoring, alerts, probes and the public status page.
- Infrastructure code for the small single-VM, lean and scale-out profiles
  ([`deployment-topology.md`](deployment-topology.md)); deployment guide, runbooks and tenant onboarding guides
  ([published](onboarding/README.md)).
- Load (10× and 100× the design target), chaos, restore, rebuild-from-zero and data-migration drills.

**Reference deployment**

- <https://usagemap.dev> runs the small single-VM profile, built from this repository's infrastructure code. It is
  not a high-availability setup: its availability objective is 99.5 % per month, not a guarantee, and it does not
  claim 99.99 % ([`sla.md`](sla.md) §1).

## Next

- **Scale-out deployment** for the 99.99 % ingest / 99.9 % dashboard objectives: the OpenTofu environment and the
  multi-node app tier of the [scale-out plan](scale-out-plan.md), then a failover drill on real nodes.
- **First monthly SLO report** once a full month of operation is measured.
- **Legal review** of the privacy pack by counsel.
- **Handover rehearsal** by a person outside the core maintainers ([handover plan](handover-plan.md)).
- **More measured projects** on the web and API side, feeding the calibration of the trust-score weights (ADR-0028).

## Later

Ideas, not commitments: further report types the base engine supports (funnels, journeys, retention), alerts for
projects, and more integrations with Stellar tooling ([`integrations.md`](integrations.md)).
