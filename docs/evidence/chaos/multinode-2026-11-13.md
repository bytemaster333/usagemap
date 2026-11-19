# Multi-node run on Compose — 2026-11-13

Real run, once, on one machine: base stack + HA overlay with `--profile multinode` — two edge gateways (`edge-a1`,
`edge-a2`), two cores (Umami + engine proxy: `core-a`, `core-b`), Patroni HA PostgreSQL underneath. Repository at
`pre-release` plus the `gateway-b` change of this run (`GW_KEYX_ADDR`, `GW_KEYX_PEERS`, `core` alias `edge-a2` in
`infra/compose/compose.ha.yaml`). Images: the local `scf/*:dev` builds of the same day (not rebuilt for the run).

## Command

```sh
SCF_CONTROL_PLANE_PORT=56342 SCF_PORTAL_PORT=56343 SCF_INGEST_PORT=56340 SCF_INGEST_PORT_B=56341 \
SCF_GW_CORES_EXTRA=,core-b=https://engine-proxy-b:8443 SCF_GW_KEYX_ADDR=:9443 \
SCF_GW_KEYX_PEERS=edge-a2=https://edge-a2:9443 \
docker compose -p scf-mn -f infra/compose/compose.yaml -f infra/compose/compose.ha.yaml --profile multinode \
  up -d --wait --wait-timeout 600
```

`up --wait` returned after 40 s with every service healthy (26 services: etcd ×3, pg-a/pg-b, HAProxy `postgres`,
Azurite ×2, PgBouncer, umami/umami-b, engine-proxy/engine-proxy-b, control plane, gateway/gateway-b, collector,
metrics writer, jobs, portal; one-shots exited 0).

The fixture tenant, site (`visitor_id = on`, main + twin website) and verified domain of `scripts/smoke.sh` were
inserted, the Umami websites created through the engine proxy (P1, P7 with the provisioner certificate), and events
sent with the gateway's own canary client (`probe`: challenge → proof of work → collect) to each gateway's published
port. Gateway metrics were read on the internal `core` network (`:9464/metrics`).

## Results

| # | Check | Result |
|---|---|---|
| 1 | A web event through `edge-a1` (`127.0.0.1:56340`) is accepted | **PASS** — 202 (solve 43 ms) |
| 2 | A web event through `edge-a2` (`127.0.0.1:56341`) is accepted | **PASS** — 202 (solve 14 ms) |
| 3 | Both events are stored in Umami (shared HA database), tag `v`, path normalised | **PASS** — 2 rows `/mn/{id}`, tag `v`; `scf_gateway_forward_total{kind="event",outcome="acked_stored",core="core-b"}` = 1 on each gateway |
| 4 | Key exchange: both edges hold the same keys | **PASS** — `GET /keyx/v1/keys` of each edge (read with the peer's node certificate; only kind/id/fingerprint kept): `day 2026-11-13` fp `64513bcb…52bdb9e`, `mult 2026-11-13` fp `ab4b8736…6b3ccba4`, `chal 498490` fp `cb5a0d1c…b44f35c8` — identical on `edge-a1` and `edge-a2`; `scf_gateway_keys_current` 1, `scf_gateway_live_edge_nodes` 2, `scf_gateway_keyx_conflicts{kind}` 0 for all kinds, on both |
| 5 | Kill the visitor's rendezvous-primary core (`core-b`: `engine-proxy-b`, `umami-b`, SIGKILL) → events fail over | **PASS** — one event through each gateway, both 202; `core_failed{core="core-b",error_kind="transport"}` 1 then `acked_stored{core="core-a"}` 1 on each gateway; Umami 8 → 10 rows |
| 6 | Kill `core-a` (`engine-proxy`, `umami`, SIGKILL) with `core-b` back | **PASS** — one event through each gateway, both 202, delivered to `core-b`; Umami 10 → 12 rows. Counter records (whose target is `core-a`) failed over too: `counter core_failed{core="core-a"}` 1, `counter delivered{core="core-b"}` 1 on each gateway |
| 7 | After `core-a` is back: spools drained, nothing lost | **PASS** — `scf_gateway_spool_queued` 0 on both; 12 of 12 events in Umami with tag `v`; `web_edge_counters` rows written |
| 8 | No addresses or UA strings in gateway logs | **PASS** — 0 matches for `2001:db8`, `Mozilla/`, `127.0.0.1`, `172.x.y.z` in `gateway` and `gateway-b` logs |

Every event the canary client sent in this run came from the same source address, and for that surrogate `core-b`
ranks first in the rendezvous order (C-74). So check 5 is the one that shows the failover of events. In check 6,
killing `core-a` did not affect where those events went. What it did show is that the counter records, which normally
go to `core-a`, failed over to `core-b`. A visitor whose primary is `core-a` would fail over to `core-b` the same way
as in check 5, but this run did not include one.

Teardown: `docker compose -p scf-mn … down -v --remove-orphans` (0 containers and 0 volumes left; images kept).
