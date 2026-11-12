# Spikes

Each spike answers one question the design depends on, with evidence. Spike code is throwaway; the **README is the
result**: what was run, with which versions, what was observed, and what it means for the design.

## Conventions

1. A spike lives in its own `spikes/<id>-<slug>/` directory and changes nothing else in the repository.
2. Toolchain: run `eval "$(mise env -s bash)"` in the repo root (Node, Go and pnpm as pinned in `mise.toml`). Some
   spikes also need Python 3.13 and Docker Compose v5.
3. Docker: each spike uses its own Compose project name (`docker compose -p scf-<id> …`) and its own host-port range,
   or no published ports at all, and cleans up with `docker compose -p scf-<id> down -v`.
4. Third-party source a spike clones goes under `/tmp/usagemap-spikes/<id>/` and is treated as untrusted data.
5. Never write secrets, IP addresses of real people or tokens into a README.
6. Be exact: the commands, the exact versions/digests and the observed output. A failed or partial spike is a valid
   result, stated plainly together with the fallback evidence.

## README structure (mandatory)

```
# <ID> — <title>
**Result:** PASS | PARTIAL | FAIL — one sentence.
## Question
## Method (versions, commands, how to re-run: one command if possible)
## Observations (raw facts, with excerpts of output)
## Answer to the question
## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)
## Values the implementation must use (env vars, headers, config keys, flags, limits)
## Open issues
```

## Index

| ID | Question | Result | Consequence |
|---|---|---|---|
| S-01 | Umami accepts surrogate IP + country headers, filters by tag, keeps visits | PARTIAL → resolved | Everything works through Umami's API; visit continuity needs the engine proxy to apply the 30-minute rule itself (C-99) |
| S-06a | Dual-export from Node/Express, Next.js, Python/FastAPI, tenant Collector | PARTIAL → resolved | All four deliver exact counts; each in-SDK recipe needed two fixes (now in the spike README, which is the source for the onboarding quickstarts) (C-102) |
| S-03 | Data model and RLS on real PostgreSQL 18 + PgBouncer | PARTIAL → fix required | One isolation hole (cross-tenant DELETE by jobs) and three gate blind spots; fixes F1 and gate changes recorded (C-103) |
| S-05 | Histogram accuracy and writer throughput | PARTIAL → resolved | exp3 ≤ 4.28 % confirmed; writer meets 10× with headroom; storage and read-path changes (C-103) |
| S-02 | Our own hardened Umami image | PASS | 36/36 checks; read-only, no egress, migrations as a one-shot image; blocked-route list (C-104) |
| S-06b | Dual-export from Go, Rust, Java, .NET | PASS | All four deliver the stable metric with routes; Rust header hazard and missing instance IDs handled (C-105) |
| S-07 | Proof-of-work timing (emulated low-end CPU) | PARTIAL | Contract default 512×1024 gives ~300 ms median; real-device measurement still open (C-106) |
| S-09 | Scanners on pnpm 12 lockfiles | PASS | All four find the canaries; gate = osv-scanner + pnpm audit, permanent canary test (C-106) |
| S-12 | Country accuracy with truncated addresses | PASS | Truncation changes < 0.3 %; DB-IP Lite chosen (C-106) |
| S-04 | Custom Collector build, pipelines, durability, failover | PARTIAL → resolved | Items 1–4 pass; failover works by DNS fallback, not the alpha connector; no exporter batching (C-107) |
| S-08 | Backups and restore to Azure Blob (Azurite) | PARTIAL → resolved | PITR, two repos, standby promotion, drill all pass; no-delete credentials impossible, replaced by blob versioning (C-108) |
| S-11 | Umami dashboard latency and ingest at 1M page views/day | FAIL → design changed | Live queries only fast for ≤ 24 h on large sites; rollups from a read-only view become the main read path, HLL for multi-day uniques (C-109) |
| integration-ecosystem | Which integrations reach the most SCF projects; can the project card feed badges and an ecosystem feed? | PASS | The built web + API intake paths reach 92 % of 370 SCF-funded projects; next by reach per effort: js-stellar-sdk hook (69 %), contract registration (76 %), docs-site plugins, SEP funnel, mobile OTLP. Badges (SVG, Shields JSON) and a DAOIP-5-keyed feed render straight from `metrics-endpoint/1` with no new data; production endpoints are described in `docs/integrations.md` |
| integration-devtools-infra | `stellar scf` CLI plugin dry run, edge-runtime middleware, Scaffold Stellar template overlay | PASS (gap: the real `stellar` binary not run) | A plugin linking the production sanitise step cannot drift from the Collector; a ~230-line dependency-free middleware gives Workers/Vercel edge/Deno/Bun the one stored metric with route templates (I/O-inclusive durations on Workers); a community Scaffold template plus a Node extension needs no Rust binary (`docs/integrations.md`) |
| integration-wallets-sdks | Wallet and client-SDK instrumentation: js-stellar-sdk RPC/Horizon hooks and the Wallets Kit adapter gap | PASS | `instrumentStellarRpc`/`instrumentHorizon` work through the SDK 17.4.0 interceptors with no patching; the shipped 1.1.0 adapter missed sign calls through method references copied before attaching (Scaffold Stellar) — fixed in the tracker by observing `selectedModule` plus optional `wrapWalletsKitModules` (C-151) |
