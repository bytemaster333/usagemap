# Runbook: private mesh handshake stale

Status: to be exercised (no drill has run) — **not applicable to the lean production profile** (see below)
Owner: maintainers
Last reviewed: 2026-11-14
Alerts: WireGuardStale

Source: `docs/monitoring-plan.md` §4.4. Alert state (`ops/alerts/coverage.json`): **no rule yet** —
`wireguard_latest_handshake_seconds{peer}` is not exported (owner: hosts).

## Which profile has a mesh

- **Lean production profile (C-123):** one VM (`app-1`, optionally a standby VM in the same VNet). There is **no
  WireGuard mesh**: services talk over Docker networks on the VM with per-node mutual TLS (C-60), and the standby
  reaches the primary over the Azure VNet. This alert cannot fire; for the standby link see
  `postgres-replication.md`.
- **Local stack:** the mesh is stood in for by the internal Compose networks `core` and `cpi` with the same per-node
  mTLS (`infra/compose/README.md`, "Networks").
- **Scale-out profile** (ADR-0018, documented, not deployed): WireGuard between edges, cores and `mon-c`. WireGuard
  itself is **not built** in `infra/ansible` yet (no role); this runbook is the procedure for when it is.

## WireGuardStale (TM-EDG-08.M.2)

**Meaning.** A WireGuard peer's last handshake is older than 5 minutes: traffic between those nodes (forwarding,
key exchange, writers, replication) is likely broken.

**First checks** (scale-out profile, on both peers):

```sh
wg show wg0 latest-handshakes        # seconds since epoch per peer public key
wg show wg0 endpoints                # does the peer's endpoint match the inventory?
```

- Both peers up; provider network/firewall status (the WireGuard UDP port must be admitted from mesh peers only,
  `hardening.md` §2.1); a recent key change in the inventory not yet applied on both.
- The symptoms the mesh carries, on the local stack too: the gateway's forwarder (`scf_gateway_forward_total`
  `outcome="core_failed"`), the Collector's export (`otelcol_exporter_send_failed_metric_points`), the key exchange
  (`scf_gateway_keyx_conflicts`).

**Mitigation**

- Restore the link (re-apply the playbook to both peers). Meanwhile accepted events wait in the edge spools
  (`spool-backlog.md`, 72-hour cap) and the Collector queues (`otlp-writer.md`); a gateway that cannot reach a peer
  may re-key the day (`visitor-key-regenerated.md`).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- ADR-0018, C-60, C-123, `docs/security/hardening.md` §2–§3.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks). The equivalent failure on the lean/local stack — the forwarder losing
  the core — is drilled through the Umami stop/start in `umami-upgrade.md` (2026-11-14: spool held and drained,
  0 events lost).
