# Scale-out plan

Status: **plan, 2026-11-19.** Register row C-180; deviation DV-41 withdrawn for the scale-out profile. **The
deployment code for this profile is not built yet**; the small single-VM profile
([`deployment-topology.md`](deployment-topology.md) §0) is the default deployment until it is.
Goal: run UsageMap at **99.99 % ingestion availability and 99.90 % dashboard availability** per calendar month — on a
layout that can be engineered to them, provisioned and configured entirely from this repository. Nothing in this
plan has been created, started or deployed in any cloud.

## 1. What the targets change

The scale-out profile targets the full service-level figures, not the 99.5 % objective that `docs/sla.md` sets for
one VM (DV-41). Three things follow:

- **A single small VM cannot meet them.** It is one small VM in one zone with one Standard SSD. Its provider's own
  single-instance commitment for that disk type is 99.5 %, so it is **not expected to meet 99.99 %** and we never say
  it will. It keeps its 99.5 % objective.
- **The scale-out profile is what a deployment at the full targets operates** (§3): two edges and two cores in two
  availability zones, a monitoring and witness node in a second EU region, health-controlled DNS at two DNS
  providers, Patroni PostgreSQL with a synchronous standby. What exists today: the design (ADR-0018, ADR-0020,
  `docs/deployment-topology.md`), the Patroni failover measured on Compose (`infra/compose/ha`, C-120: ≈ 24 s,
  0 acknowledged commits lost) and the health controller (`services/health-controller`). The OpenTofu environment and
  the multi-node `site.yml` app tier are still to be written (§5).
- **The objectives stay objectives.** We design for them, measure them with three probe sources and publish every
  month (`docs/sla.md` §2–§7). A miss is reported, never hidden; none of this is a guarantee.

## 2. Error budgets

Average month = 30.44 days = 43,830 minutes (365.25 / 12). Computed, not measured.

| Objective | Per 30-day month | Per average month | Per year | In 30-second probe rounds per average month |
|---|---|---|---|---|
| 99.99 % ingestion | **4.32 min** | 4.38 min | 52.6 min | ≈ 8 bad rounds of 87,660 |
| 99.90 % dashboard | **43.2 min** | 43.8 min | 8.77 h | 5-minute journeys: ≈ 8 bad windows of 8,766 |

What the budgets mean for operation:

- **Ingest recovery must be automatic.** A human who is woken up needs 15–30 minutes; that is 3–7 months of ingest
  budget. The edge failover is the client's (a second address in every DNS answer, the tracker's retry) and the
  health controller's (a dead edge leaves both providers' record sets after three failed rounds — 90 s with 30-second
  rounds); nothing waits for a person.
- **Planned work is rolling.** `site.yml` changes one node at a time (`serial: 1`); the other edge and the other core
  keep serving. No maintenance window is excluded from the objective.
- **The database is the dashboard's budget.** A Patroni failover measured ≈ 24 s with a ≈ 30 s write gap (C-120)
  costs about one dashboard window; about eight such events a month fit in 43.8 min.

## 3. The minimal layout

Planned machine shapes (for the `envs/scale-out` environment still to be built):

| Node | Where | Shape | Runs |
|---|---|---|---|
| `edge-a1`, `edge-a2` | primary region, zones 1 and 2 | 2 vCPU / 4 GiB burstable | gateway (TLS, tracker files, challenge, events, OTLP front door, fsync'd spool, forwarder with consistent-hash failover between the cores), Collector, range-list updater |
| `core-a`, `core-b` | primary region, zones 1 and 2 | 4 vCPU / 16 GiB, 256 GB premium data disk | Patroni PostgreSQL (primary / synchronous standby) + etcd member, primary-following HAProxy, PgBouncer, engine proxy + Umami, control plane, portal (Caddy) and MCP, jobs (advisory locks: one run per job across cores), metrics writer; `core-b` also the second health controller |
| `mon-c` | second EU region | 2 vCPU / 8 GiB burstable, 128 GB data disk | third etcd member (witness), health controller (holds the DNS write role with `core-b`), monitoring, weekly restore drill |
| `probe-d` | second EU region | 2 vCPU / 1 GiB burstable | external probes only (second probe source) |
| `egress-1` | primary region, zone 3 | 2 vCPU / 1 GiB burstable | the egress proxy, the only internet path of the other nodes (C-10) |

What this layout survives without a person: the loss of any one edge, any one core (including the database primary),
`mon-c`, `probe-d`, one DNS provider's API, or one availability zone of the primary region. What it does **not**
survive within the budget: the loss of the whole primary region, or a provider-wide control-plane incident — one
provider, one region for every edge and both cores. That residual risk is stated in `docs/sla.md` §1.1 and in the
risk register; the multi-provider layout of ADR-0018 (four edges on two providers) is the documented upgrade.

Two edges instead of four (ADR-0018) is a cost choice: one edge must carry the whole ingest load while the other is
down. The 10× load test (C-48) ran on one gateway, so one edge carries the design load with margin; capacity at
2 × peak on one edge is re-measured on the real nodes before they take traffic (§5).

## 4. What exists and what is still to be built

| Piece | State |
|---|---|
| Topology, failure domains, error budgets | Designed: ADR-0018, ADR-0020, ADR-0031, `docs/deployment-topology.md`, this plan |
| PostgreSQL high availability (Patroni + etcd, synchronous standby, fencing, rejoin) | Built and tested on Compose: `infra/compose/ha`, `make ha-test`, C-120 |
| DNS failover controller | Built: `services/health-controller` (adapters per DNS provider) |
| Edge spool and failover between cores | Built: gateway fsync'd spool, consistent-hash forwarding, 72 h client retry |
| OpenTofu environment for the seven nodes | **To build** (§5) |
| Multi-node `site.yml` app tier (edge and core classes) | **To build** (§5) |
| Failover drill on the real nodes (one edge and the primary core powered off under load, 0 acknowledged events lost) | **To run** (§5) |

## 5. Before the nodes take traffic

1. Approve the cost (§6) and the reservation choice; subscription and budget alert.
2. Second DNS provider zone for the tracker domains; the DNS write token for the health controller in SOPS.
3. Build the OpenTofu environment `envs/scale-out` and the multi-node `site.yml` app tier, test them on containers
   (one edge and the primary core powered off under load, 0 acknowledged events lost), then `tofu apply`, `site.yml`
   and the release images by digest.
4. Monitoring on `mon-c` with the three probe sources (`mon-c`, `probe-d`, edge cross-probes) and the status page off
   the platform (`ops/internal/status` defaults: 99.99 % / 99.90 %, 2-of-3). The monitoring overlay is not yet part of
   `site.yml` — open item O3 (§7).
5. On the real nodes: the failover drill of §4.1 (power-off of one edge and the primary core), one edge at 2 × peak,
   the restore and rebuild drills (`docs/sla.md` §16).
6. Measurement starts the day the nodes take traffic; the first monthly report covers the first full month.

## 6. Cost estimate

Azure list prices from the public retail price API, read 2026-11-19, pay-as-you-go, US$, excluding VAT. Lines marked E are estimates
from the design load (C-48, C-109), the others list prices.

| Line | US$/month |
|---|---|
| 2 edges | 56.79 |
| 2 cores | 268.64 |
| `mon-c` (second region) | 63.07 |
| `probe-d` (second region) | 7.88 |
| egress proxy | 7.10 |
| 7 OS disks (64 GB premium SSD) | 78.59 |
| data disks: 2 × 256 GB (cores) + 128 GB (`mon-c`) | 105.30 |
| 7 static public IPv4 addresses | 25.55 |
| private endpoints to the backup accounts (E) | ≈ 25 |
| backup storage in two regions (E) | ≈ 14 |
| cross-region transfer: repository 2, drill, monitoring, etcd witness (E) | ≈ 22–27 |
| inter-zone transfer: synchronous WAL, edge → core (E) | ≈ 3–6 |
| DNS at two providers (E; the second provider's free plan) | ≈ 4–6 |
| internet egress (E) | 0–4 |
| **Total** | **≈ 681–695** |

| Layout | US$/month | US$/12 months |
|---|---|---|---|
| **Minimal scale-out, pay-as-you-go** | **≈ 681–695** | **≈ 8,170–8,340** |
| Minimal scale-out, 1-year reservations for both cores and both edges | ≈ 555–570 | ≈ 6,660–6,840 |
| Same with the next core size up, if the load test asks for it (E) | + ≈ 270 (pay-as-you-go) | + ≈ 3,200 |

Not included: domains, VAT, staff time and on-call, support plans, the four-edge multi-provider upgrade.

## 7. Open items

| # | Item | Why open |
|---|---|---|
| O1 | Cost and reservation (§6) | Decision of the service operator (budget) |
| O2 | Two edges (this plan) or four on two providers (ADR-0018) | Cost against the residual region/provider risk (§3) |
| O3 | Monitoring overlay, probes and status page on `mon-c` and `probe-d` | Part of the build (§5); the overlay exists today for one host (`compose_stack`) |
| O4 | etcd role-based access for the health controller's lease | It shares the Patroni etcd with a DCS client certificate of its own; etcd authentication is not enabled, so its certificate could also write Patroni's keys (risk recorded in C-180) |
| O5 | Real-provider checks of the two DNS adapters | Azure's not-found status and Cloudflare's batch result are from the documentation only (no account used) |
