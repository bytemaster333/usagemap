# Changelog

All notable changes to UsageMap are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Component versions that users pin are named where they change. The browser tracker is the only component a website
embeds, and every tracker version a deployment has served stays served unchanged.

## [Unreleased]

## [0.1.0] - 2026-11-20

First public release.

### Web analytics

- Browser tracker 1.2.0, with the earlier releases 1.0.0 and 1.1.0 archived byte for byte: `strict` and `standard` profiles, SRI manifest, reproducible build, no
  cookies or stored identifiers, and a consent-gated mode. The Stellar event schema (wallet connect, sign request,
  transaction submitted) uses a closed vocabulary and never sends an address or amount. Also included: wallet adapters
  (Stellar Wallets Kit, Freighter, LOBSTR, Albedo, xBull, HOT), passkey smart accounts, a debug module and dev
  origins.
- Ingest gateway: signed challenge, proof of work, origin, header and transport checks, network-class multiplicity
  with a shadow mode, reason-coded verdicts and an fsync'd spool. Umami runs unmodified and private behind a
  mutual-TLS engine proxy.
- Path normaliser that folds Stellar addresses, numeric IDs, UUIDs and hashes, and redacts secret seeds before
  anything is stored.

### API analytics

- OpenTelemetry front door with ingest tokens, and a custom Collector distribution with the `scfsanitize`
  processor. Traces and logs are dropped and only allow-listed attributes are kept.
- Metrics writer with idempotent ingest and histogram storage in PostgreSQL. API dashboards show volume, status codes
  and p50/p95/p99 latency per normalised route.
- Integration packages: Stellar SDK client metrics (`stellar-otel`, `stellar-otel-py`), edge middleware
  (`edge-otel`), partner calls, payments (x402, MPP), anchor funnel, mobile (React Native, Flutter) and an Anchor
  Platform event listener.

### Platform

- Multi-tenant control plane: sign-in, projects, sites, services, domain verification, enrolment with an
  approval-mode switch, scoped expiring API keys, audit chain and erasure workflow.
- PostgreSQL with row-level security on every tenant table, an isolation matrix at the database and HTTP layers, and
  a privilege snapshot.
- Jobs: rollups, trust scoring, retention, Umami reconciliation, signed traction snapshots, a daily seal of published
  figures, registry cohorts and on-chain counts from public ledger files.
- Portal: tenant dashboards, set-up wizard, integrations catalogue with test commands and a live first-event panel,
  sharing and badges, and the SCF operator console.
- Tools: hosted and local MCP servers, the `stellar scf` CLI plugin, a tracker pin GitHub Action, the operator CLI
  `usagemap-op`, and a demo seeder for local stacks.
- End-user documentation site with `llms.txt` and an agent skill.

### Operations

- Docker Compose stack for local use and single-VM deployment; OpenTofu modules (Azure) and Ansible playbooks for the
  lean and scale-out profiles.
- Monitoring dashboards, alert rules with promtool tests, a status page, and runbooks with restore, rebuild and
  handover drills.
- SPDX header check for every source file.
