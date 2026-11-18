# Runbook: range lists stale or missing

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-18
Alerts: RangeListsStale

Source: `docs/monitoring-plan.md` §4.4, C-38, bot.ip-multiplicity. Rules in `ops/alerts/edge.rules.yaml`; tests in
`ops/alerts/tests/backup-cert-rangelists.test.yaml`.

**Built today:** the gateway image's `rangelist-updater` fetches the cloud-provider, Private Relay and Tor-exit lists
(`services/gateway/internal/rangelist` `Defaults`) into the `rangelists` volume, which the gateway mounts read-only as
`GW_RANGELISTS_DIR` and re-reads every minute (no restart, no signal). In a plain Compose deployment it is a
long-running service (`infra/compose/compose.yaml`, `-interval 168h`). In the lean profile it runs once a week from the
systemd timer `scf-rangelists` (role `compose_stack`), which writes `scf_rangelists.prom`
(`scf_rangelist_last_run_timestamp_seconds`, `scf_rangelist_last_run_success`,
`scf_rangelist_last_success_timestamp_seconds`) to the node exporter's textfile directory; the first run happens on
the first deploy. A failed fetch keeps that source's previous list; each fetch logs the source's SHA-256. Exit codes:
0 at least one source fetched, 1 every source failed, 2 bad configuration. The local stacks never download: they use
the documentation-range test lists of `infra/compose/rangelists/`. The lists are never in an image or the repository
(no clear redistribution licence).

## RangeListsStale (TM-INF-03.M.1)

**Meaning.** Either no successful update for 15 days (two weekly runs missed), or a gateway holds no `datacenter`
list for 2 hours. Without lists every address is `unknown`: the stricter multiplicity thresholds for datacenter, Tor
and VPN addresses (3 / 4 / 3 distinct visitors per address) do not apply, and the lenient `unknown` threshold
(40 per 10 minutes) is used for everyone.

**First checks**

```sh
systemctl status scf-rangelists.timer scf-rangelists.service
journalctl -u scf-rangelists.service --since -14d --no-pager | tail -50   # per-source result and SHA-256
cat /srv/scf/metrics/scf_rangelists.prom
DC="docker compose -p scf --project-directory /opt/scf/current/infra/compose -f /opt/scf/current/infra/compose/compose.yaml -f /opt/scf/current/infra/compose/compose.monitoring.yaml -f /etc/scf/stack/compose.prod.yaml"
$DC exec gateway ls -l /var/lib/scf-rangelists      # <class>.txt and their times (distroless: if ls is missing, inspect the volume)
curl -s http://127.0.0.1:9090/api/v1/query --data-urlencode 'query=scf_gateway_rangelist_entries'
```

| Symptom | Likely cause | Action |
|---|---|---|
| every source fails | no egress from the `public` bridge (host firewall, NSG, DNS) | check the egress rules; run the service by hand: `systemctl start scf-rangelists.service` |
| one source fails each week | the publisher moved or changed its format | set `scf_rangelist_sources` (role `compose_stack`) to a corrected list, or fix `Defaults` in a release; the other classes stay current |
| files current but gauge 0 / absent | the gateway does not mount the volume, or cannot parse the files | compare the gateway's mounts with `/etc/scf/stack/compose.prod.yaml`; check the gateway log |
| timer missing | deploy did not install it | re-run the playbook |

**Mitigation**

- Run the updater once by hand (above); the gateway picks the files up within a minute, no restart needed.
- Until fixed, note in the monthly report that network-class thresholds were inactive for the period (bot.ip-multiplicity).

**Escalation**

- Warning: maintainers (issue). Not paging: verdicts stay conservative in other layers (proof, rate limits, trust score).

## Related

- C-38, ADR-0008, `services/gateway/README.md` (`rangelist-updater`, `GW_RANGELISTS_DIR`).
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
