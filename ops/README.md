# Operations: monitoring, alerts, probes, SLO report, status page

Implements `docs/monitoring-plan.md`, ADR-0022 and ADR-0031 with the register rules C-30, C-71, C-78, C-92, C-93.
Go module `github.com/bytemaster333/usagemap/ops` (standard library only; links `services/gateway/pkg/probe`).

| Path | What |
|---|---|
| `alerts/*.rules.yaml` | SLI recording rules and every alert of the plan whose signal exists; `alerts/coverage.json` lists **all 111** catalogue alerts with their status (rule / partial / metric missing — with the exact metric and owner / outside Prometheus) |
| `alerts/tests/*.test.yaml`, `alerts/test.sh` | `promtool test rules`: every alert has a firing and a non-firing case |
| `slo/*.sloth.yaml` | Sloth specs of SLO-1 (ingest 99.99 %) and SLO-4 (dashboard 99.9 %) |
| `dashboards/*.json` | Grafana dashboards D1–D14, **generated** by `internal/dashboards` (`scf-ops dashboards`) |
| `prometheus/`, `alertmanager/`, `grafana/` | configuration for the overlay (and the production template for Alertmanager) |
| `probes/`, `health-controller/` | probe-source and health-controller configuration for the Compose overlay |
| `cmd/scf-ops` | `probe`, `slo-report`, `status-page`, `logscan`, `dashboards`, `keygen`, `chown` (vlogs-init) |
| `deadman/check.sh` | the dead-man's-switch check `.github/workflows/deadman.yml` runs every 5 minutes (C-30) |
| `e2e/run.sh`, `e2e/secrets.sh` | end-to-end test of the overlay against the real stack |
| `runbooks/` | one file per runbook name; every alert links one (`runbook_url`) |

The Compose overlay is `infra/compose/compose.monitoring.yaml`; the health controller is `services/health-controller`.

## Decisions taken here

- **Dashboards: Grafana OSS 13.3.1, unmodified, its own container.** `supply-chain.md` §5.1 allows AGPL for separately
  run, unmodified tools and names Grafana as the example; ADR-0022 chose it. Dashboards are plain JSON in the repository, so a
  switch to Perses (Apache-2.0) would replace only the renderer in `internal/dashboards`.
- **Logs: VictoriaLogs v1.53.0** (Apache-2.0, C-71: 30 days). Locally the Docker `syslog` driver of the application
  services sends to it over UDP; in production `systemd-journal-upload` does (ADR-0022). `scf-ops logscan` counts
  lines with personal-data or secret shapes every 5 minutes (`LogPIIDetected`) and never exports the text.
- **Sloth.** The recording rules in `alerts/recording.rules.yaml` are hand-maintained in Sloth's output structure (`slo:sli_error:ratio_rate<window>`
  with `sloth_*` labels) from `slo/*.sloth.yaml`; Sloth's own alerts are disabled because the plan names its alerts
  (`IngestBurnRateFast/Slow`, `IngestBudgetTicket`, `DashboardBurnRateFast/Slow`, in `alerts/slo.rules.yaml`).
- **Quorum (C-78) as built:** the edge probers (`edge-*`) vote as **one** source "edges" (C-30 counts "the
  cross-provider probes that edge nodes run" as one of three sources), which records a round bad when more than half
  of its reporting probers do; a source that abstains (self-check failed) or sent nothing does not vote; fewer than
  two voters → **unknown** (C-78; the plan's §4.1 sentence "with one, its result counts alone" is superseded by C-78).
  Dashboard: a source records a 5-minute window failed when **at least half** of its journeys in it failed; the window
  is bad when at least two sources record it failed (ADR-0031 SLO-4).
- **Probe hygiene:** every attempt uses a fresh connection (fresh DNS resolution, full TLS handshake, C-43); rounds
  are aligned to the wall clock so the three sources probe the same round; raw results go to an append-only CSV per
  source and day (`/var/lib/scf-probes/<source>/<day>.csv`, fsync'd), which the report and the status page read.

## Placement in production

### Lean Azure profile (production profile, C-123; not yet applied)

Everything runs on **`app-1`** (one Azure VM, West Europe) next to the application, deployed by the Ansible role
`compose_stack` (`infra/ansible/playbooks/lean.yml`) with `infra/compose/compose.monitoring.yaml` and the role's
production override:

| Component | Lean profile |
|---|---|
| Prometheus, Alertmanager, Grafana, VictoriaLogs, log scanner | On `app-1`, published on `127.0.0.1` only (SSH tunnel or Azure Bastion); Grafana admin password from SOPS; container logs reach VictoriaLogs through the Docker syslog driver on loopback UDP |
| Probe sources | The local probe on `app-1` (30-second rounds, signed-in journeys) against the real public hostnames; the **GitHub-hosted 5-minute checks** of the public endpoints as the outside source; the `probe-d` and edge probe sources are not deployed. The SLI rules for this profile are in `docs/sla.md` §1.1 (no 2-of-3 quorum is available) |
| Node exporter | On `app-1` (and `standby-1`), for the textfile metrics of the backup scheduler (`scf_backup_*`) and the restore drill |
| Status page and heartbeat receiver | On `app-1`; published through the portal's TLS front only when a status hostname is configured. The dead-man's-switch workflow reads its `heartbeat.json`; when the VM is down the read fails, and the workflow alerts (it fails closed) |
| Health controller, its etcd, DNS provider tokens | **Not used** (C-123): DNS records are static in Azure DNS |
| Raw probe files | On `app-1`'s data disk; copying them off-host (object storage in another account) is an open point |

Monitoring therefore runs inside the failure domain it watches; the outside view is GitHub's checks plus the
dead-man's switch (accepted in C-123, `docs/threat-model.md` TM-AZ-08).

### Scale-out profile (documented, not deployed)

`mon-c` (OVHcloud in the research layout) runs Prometheus, Alertmanager, Grafana, VictoriaLogs, the log scanner, one
health-controller instance and the probe source `mon-c`; `core-b` runs the second health-controller instance;
`probe-d` (a fourth provider) runs the probe source `probe-d`; every edge node runs the `edge-*` prober against the
other provider's nodes. The raw probe files are copied hourly to object storage at a provider other than the prober's.

**The status page runs outside the monitored failure domain:** the `status-page` server (static HTML generated from
the raw probe files, plus the heartbeat receiver) runs on `probe-d`, which hosts no ingest, portal or database
component and is at a provider that hosts nothing else of ours; it reads the probe files from object storage, so it
keeps working when every production node and `mon-c` are down. The GitHub-hosted 5-minute checks (Upptime, DV-06) stay
an additional outside view. The dead-man's-switch workflow reads `https://<status host>/heartbeat.json`.

## Run and test

```sh
eval "$(mise env -s bash)"
cd ops && GOWORK=off go test ./...                 # quorum, SLO report (fixture month vs hand calculation), probes,
                                                   # journey (SEP-53), status page, log scanner, dashboards, alert lint
ops/alerts/test.sh                                 # promtool check + unit tests (pinned Prometheus image)
ops/e2e/run.sh                                     # overlay against the real stack (project scf-wsj1, ports 56331–56338)
go run ./cmd/scf-ops dashboards -out dashboards    # regenerate dashboards after editing internal/dashboards
go run ./cmd/scf-ops slo-report -store <probe store> -month 2026-11 -out ../docs/evidence/slo [-prometheus URL]
```

The fixture month (`internal/slo/report_test.go`) is February 2026 with scripted incidents; the test asserts the
hand-calculated figures in its header comment (headline 80,503 good / 17 bad / 120 unknown → 99.97889 %, budget
4.032 min, 211.1 % used; dashboard 8,062 / 2 → 99.97520 %, 24.8 % used).
