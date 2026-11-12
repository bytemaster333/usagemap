# ADR-0020: High availability and spool

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** slo.ingest-availability, slo.dashboard-availability, support.public-issue-tracker, api.dual-export, capacity.1m-requests-day, api.otlp-to-postgres-metrics

## Context
99.99 % ingest availability is 4.38 minutes per average month; 99.9 % for dashboards is 43.8 minutes. A human
paged at night needs 15–30 minutes, three to seven months of ingest budget, and the service model has no on-call
(support.public-issue-tracker). So ingest failover must be fully automatic; humans only restore redundancy afterwards
. Correlated failures — a bad deploy to every edge, an expired certificate, a
DNS provider outage — dominate random node loss (§3.2).

Edge nodes that buffer data are stateful: the honest durability claim is "no accepted event is lost unless it could
not be delivered for more than 72 hours" (C-18), with the residual risk (disk destroyed before drain) disclosed. Facts that shape the design:
- OTLP SDK retry windows are short (Go ≈ 1 min, Java/JS ≈ 10–15 s, Python a few seconds; Collector ≈ 5 min), but
  the default metrics temporality is **cumulative**, so a dropped export loses resolution, not counts, as long as
  tenants keep it; SDKs retry on 429/502/503/504 (§3.4(2)).
- Browsers fail over to the next A/AAAA record in about one RTT when a connection is **refused**, but a
  **black-holed** address can stall a connection until the OS SYN timeout (≈ 21 s Windows, ≈ 127 s Linux);
  `sendBeacon` and `fetch(keepalive)` have no retry (§3.6.2). Most clients see a DNS change in ≈ 1–5 minutes.
- Queue options and licences: NATS JetStream (Apache-2.0) syncs every 2 minutes by default and relies on
  replication; Redis 8 is RSALv2/SSPLv1/AGPLv3; Redpanda is BSL; the Collector's `file_storage` (bbolt, beta) has
  `fsync` off by default and does not carry auth context through the persistent queue (§3.5).
- Patroni defaults (ttl 30 s, loop_wait 10 s, retry_timeout 10 s) give ≈ 30–60 s automatic failover.

## Options considered
1. **Local fsync'd segment log per edge, async drain (chosen).** (Earlier drafts also shipped sealed segments to
   object storage at the other provider; that is withdrawn for the first release, C-77.) Pros: one process,
   one directory, no cluster; survives process crash and power loss; database or Umami outages become a freshness
   problem, not an availability one. Cons: events not yet drained are lost if a node's disk is destroyed.
2. **Synchronous dual-write to a peer edge before acknowledging.** Pros: survives loss of any one node. Cons: adds
   5–30 ms cross-site RTT; when the peer is down we must choose between lower durability and lower availability.
   Kept as a later flag.
3. **Replicated broker (NATS JetStream R3, Kafka, RabbitMQ quorum queues).** Pros: survives node loss inside the
   cluster. Cons: Raft quorum across providers stops writes on a partition; a clustered stateful system for
   volunteers to run and hand over.
4. **PostgreSQL as the queue.** Cons: a database outage becomes an ingest outage, which removes the separation
   between the 99.99 % and 99.9 % targets.
5. **CDN, provider load balancer or anycast for steering.** Cons: CDN sees IPs and is a global failure domain
   (ADR-0017); Hetzner's LB stays inside one network zone and publishes no SLA; own ASN/BYOIP is out of budget.

## Decision
**Web path.** The gateway appends each accepted record to an embedded append-only segment log on local disk
(length-prefixed records with checksums, group commit; each record has a node ID, segment and offset — C-76) and
answers `202` **only after fsync returns**. A forwarder drains segments to Umami `POST /api/send` (ADR-0005)
through the **engine proxy** on the core chosen by a consistent hash of the surrogate, falling back to the other core
on failure (C-74, C-60), and records committed offsets; segments are deleted on acknowledgement. Delivery to Umami is
**at-least-once**: retries whose first attempt had an unknown outcome are counted per node and reported, because
Umami does not de-duplicate. The disk is sized for 72 hours of peak backlog.

**No spool copies to object storage (C-77; C-11 withdrawn).** The local spool is the only copy of an accepted event
until it is forwarded. An event accepted by a node that is then permanently lost (VM and disk destroyed) before it
forwards is **lost**. The exposure is that node's undrained backlog: normally seconds, but up to the whole backlog
while the cores are unreachable. This is stated in the SLA next to the durability objective.

**Measuring durability (C-76).** Durability is computed from spool accounting on every edge node: records fsync'd =
records acknowledged + records expired under the 72-hour rule + records still queued. A daily job reconciles these
counts per node and per segment, and canary events of a known hourly count, sent to a canary site, are counted in
Umami as an end-to-end cross-check. Events Umami silently drops as bots are counted as `engine_bot_drop` and count
as delivered (C-69). The measure therefore shows what the forwarder handed over and what the canary proves reached
storage; it does not compare every stored Umami row with a spool record.

**The 72-hour cap is deliberate (C-18).** An event or metric batch that cannot be delivered for 72 hours — local
spool or Collector queue — is **discarded and counted**. The durability objective therefore reads "no
accepted event is lost unless it could not be delivered for more than 72 hours" (ADR-0031). Spool-age alerts fire
at 1 h, 6 h and 24 h, and one named person checks the alert channel once per calendar day (C-49), so a
human sees a stuck spool well before the cap.

**OTLP path.** `scf-otelcol` uses the persistent sending queue (`file_storage`) with **`fsync: true`** and the same
72-hour cap; tenant identity is stamped into the payload by `scfsanitize` before the queue (ADR-0009). The
Collector exports **directly to the writers**, with its own failover between `core-a` and `core-b`, if S-04
confirms it; otherwise it exports to the gateway on loopback, which forwards to a healthy writer (C-77, C-07). When
the queue is full the gateway answers **503 + `Retry-After`**, never 400/500, so SDKs retry. Writers are
active-active: the batch ledger's unique key prevents double application, per-stream state rows are locked for
update inside the batch transaction, and the ledger keeps 7 days (ADR-0010, C-07, C-18).

**Snapshot (C-62).** Edge nodes pull the signed site/token snapshot from a healthy core, through the engine proxy's
allow-listed internal edge endpoint (C-60). Snapshots carry a
sequence number and issue time; a node never accepts an older sequence. No fresh snapshot for 15 minutes raises
an alert; the node keeps serving from the last good snapshot (availability first), so revocations do not reach
that node until it reconnects — a stated residual risk.

**Traffic steering.** Multiple A/AAAA records, TTL 60, for every ingest host and for the portal/API host (which
resolves to both core nodes, C-07), pushed to **two DNS providers**. A **health controller** with two instances on
**`mon-c` and `core-b`** (one holds an etcd lease; the other takes over) probes the edges and cores and changes
only the ingest and portal A/AAAA record sets through both providers' APIs, never leaving a host with zero records
(C-27). Static records are applied from git by the DNS-as-code tool (ADR-0019). Edge nodes cannot change service
records; their DNS credential writes only a delegated `_acme-challenge` zone (C-61). The tracker rotates between
its **two fixed ingest hosts on two domains** with a 3 s timeout (ADR-0004). Nodes are drained by **closing the
listener** (connection refused), never by dropping packets. No message broker.

**Database.** Patroni with **synchronous replication, non-strict** (`synchronous_mode: on`), standby at the other
provider, three etcd members (`core-a`, `core-b`, `mon-c`), `failsafe_mode: true`, `primary_start_timeout` ≤ 30 s,
fencing of the old primary through the provider API. Each core's control plane and writer reach the current
primary through a local proxy that follows Patroni's `/primary` endpoint (C-07). Every scheduled job takes a
PostgreSQL advisory lock, so only one instance runs it across both cores. While no primary is available,
**dashboards fall back to read-only from the replica** with a banner; settings, keys and enrollment are disabled.

**Failure modes** (recommended topology, ADR-0018: four edges, two cores, `mon-c`, `probe-d`):

| What fails | Ingest | What is lost | Who/what recovers |
|---|---|---|---|
| One edge node | Three edges answer; tracker times out after 3 s and rotates host; health controller removes the record within ≈ 30–60 s + TTL | Nothing accepted if the disk survives (drains on reboot); if the VM and disk are destroyed, its not-yet-drained records (normally seconds; the whole backlog if the cores were unreachable — no object-storage copy exists, C-77) | Automatic; a human rebuilds the node from IaC |
| One core node (not the primary) | Unaffected; forwarders (whose consistent hash pointed there), Collector exports and snapshot pulls go to the other core; portal/API record removed by the health controller | Nothing accepted; visits in flight on that core split once, because its cache-token memory is gone (C-74) | Automatic; a human rebuilds the node from IaC |
| One provider (Hetzner) | `edge-b1`/`edge-b2` carry all traffic; Patroni promotes `core-b` (quorum `core-b` + `mon-c`); health controller on `core-b` or `mon-c` holds the lease | Committed DB data: none while the standby was in sync; `edge-a1`/`edge-a2` spools are unreachable until Hetzner returns (discarded and counted if that exceeds 72 h, C-18; lost if a node's disk is destroyed, C-77) | Automatic; human re-adds capacity (Scaleway module if needed) |
| One provider (UpCloud) | `edge-a1`/`edge-a2` carry all traffic; `core-a` keeps the primary; the health-controller instance on `mon-c` holds the lease | As above for UpCloud edges' spools; DB unaffected (primary on Hetzner), no sync standby until UpCloud returns | Automatic; human restores the standby |
| Database primary | Unaffected: spools and the Collector queue buffer | None while sync replication was healthy; in degraded-async mode up to `maximum_lag_on_failover` | Patroni failover in ≈ 30–60 s; read-only dashboards meanwhile |
| Umami (engine) | Unaffected; web spool grows, freshness degrades | Nothing accepted, unless undeliverable for more than 72 h (discarded and counted); possible duplicates from ambiguous retries (counted) | Container restart / the instance on the other core node; forwarder drains |
| Control plane (both cores) | Unaffected; gateway uses its last good signed snapshot from disk | Nothing; new sites, ingest tokens, suspensions and revocations stop propagating (60 s target missed); snapshot-age alert after 15 min (C-62) | Restart or the other core node; human if both fail |
| One DNS provider | Resolvers use the other provider's name servers | Nothing | None needed; health controller keeps both zones in step when it returns |
| Monitoring node `mon-c` | Unaffected | Metrics and log history for the outage; one of the three probe sources (C-30); etcd down to 2 of 3 (still quorum) | Dead-man's switch alerts humans; rebuild from IaC; the health-controller instance on `core-b` takes the lease |
| All gateway nodes at once (bad release, certificate expiry) | **Down** | Events the tracker could not send after its retries; OTLP counts recover only for cumulative exporters within their retry window; the daily visitor key is regenerated, so that day's uniques are over-counted (ADR-0007) | Staged rollout prevents most cases: one node at a time, ≥ 15 min soak, automatic rollback on SLI burn, never both providers in the same hour; otherwise a human redeploys the previous digest |

## Consequences
Positive: a single node, site, provider or DNS provider failure costs requests, not minutes, with no human in the
loop; database, engine and control-plane outages do not touch the ingest SLI; the stack has no broker to run.

Negative: durability has two stated holes (disk destroyed before drain, with no object-storage copy to fall back on,
C-77; data undeliverable for more than 72 hours is discarded, C-18); durability is measured from spool accounting
and canaries, not by matching every stored row (C-76); at-least-once delivery means a small,
counted duplicate rate in Umami; health-controller removals depend on etcd quorum (if two of the three etcd hosts
fail, records stay and only tracker rotation and connection-refused failover remain); an edge cut off from both
cores serves from a stale snapshot, so revocations miss it (C-62); every node runs with fsync on.

Revisit if: measured duplicate or loss rates exceed what SLO-2 allows (then add option 2); load rises enough
for fsync to limit throughput; a DNS provider offers portable health-checked records.

Unproven: the gateway, spool, forwarder and engine proxy are unwritten; the Collector's failover between two writer
endpoints (S-04, C-77); Umami ingest with the surrogate address and verdict
`tag` (S-01); Collector persistent-queue fsync behaviour (S-04); chaos tests (kill database, engine, an edge node)
and black-hole failover timings in real browsers (ADR-0026). Targets are not quoted until measured.

## Open points
None outstanding.
