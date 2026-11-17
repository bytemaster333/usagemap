# Health controller (C-92)

Probes every edge node (and, when configured, the core nodes) every round and maintains the **ingest and portal
A/AAAA record sets** at **every DNS provider** (C-27: the static records are DNS as code; the controller owns only
these sets). Two instances — `mon-c` and `core-b` in production — exchange their results; the holder of an etcd lease
writes DNS. Go, standard library only; links the gateway's protocol-level probe client
(`services/gateway/pkg/probe`) for the canary event.

## Rules (C-92, as built)

| Rule | Implementation |
|---|---|
| Rounds | every `interval` (30 s), aligned to the wall clock so both instances probe the same round |
| Probe | `GET health_url` (mesh, mTLS in production) **and**, for nodes with an `ingest_url`, one canary event through the real tracker protocol (challenge → PoW → `202`), path `/canary/<instance>/<node>` |
| Exchange | `GET /internal/v1/rounds/{round}` on the peer (mutual TLS with `-tls-*`); results are node id, boolean, closed reason word |
| Failed round | every instance that reported saw the node fail ("seen by both"); a mixed view resets both streaks. **With the peer unreachable the instance's own view stands** — otherwise the loss of `mon-c` would freeze DNS (interpretation, reported) |
| Remove / re-add | after `fail_rounds` = 3 consecutive failed rounds / `recover_rounds` = 5 consecutive good rounds |
| Last address | never removed: per hostname **and record type**, a set that would become empty keeps its current members (`scf_health_controller_last_address_kept`) |
| Providers | written concurrently, each with its own `provider_timeout`; a failing or hanging API never delays the other; every round reconciles, so a provider that comes back catches up and drift is corrected |
| Leader | etcd lease over etcd's v3 JSON gateway (no etcd client library); the local leadership view expires before the lease does, so two writers never overlap; a new leader starts from what is published (a node published nowhere must earn 5 good rounds) |
| Audit | every write is logged (provider, hostname, type, reason `remove`/`add`/`drift`, node ids — never addresses) and counted |

## Configuration

`health-controller -config config.json [-etcd https://etcd-1:2379,…] [-leader] [-listen :9470] [-metrics :9471]
[-tls-cert node.crt -tls-key node.key -tls-ca ca.crt] [-ingest-ca …]`. The file (JSON, unknown fields refused):
`instance`, `interval`, `probe_timeout`, `provider_timeout`, `fail_rounds`, `recover_rounds`, `nodes[]` (`id`, `ipv4`,
`ipv6`, `health_url`, `ingest_url`), `hostnames[]` (`name`, `zone`, `ttl`, `nodes`), `providers[]` (`name`, `kind`, `subscription_id`, `resource_group`, `imds_endpoint`,
`endpoint`, `token_file`), `canary` (`site_key`, `origin`, `tracker_version`), `peers[]`. Examples:
`ops/health-controller/compose-*.json`. Provider credentials are files (SOPS-decrypted on `mon-c`, C-79), never
environment values.

Ports: `9470` peer API, `9471` `/metrics` + `/healthz`. No writable path (state lives in memory and in etcd).

Metrics: `scf_health_controller_{leader, rounds_total, last_round_timestamp_seconds, node_probe_ok, node_up,
node_transitions_total, peer_reachable, record_members, last_address_kept, dns_writes_total{provider,hostname,type,reason},
provider_errors_total, provider_up, dns_drift}` and `scf_probe_canary_accepted_total{source,path}` (wire-formats §o).
Alerts: `HealthControllerNoLease`, `IngestCapacityDegraded`, `DNSRecordDrift`, `EdgeNodeProbeFailing` (critical variant).

## Provider adapters

`internal/dns.Provider` has three methods: `GetRecords`, `SetRecords` (replace one RRset atomically, never empty) and
`Name`. Every adapter passes the same contract test (`internal/dns/contract_test.go`: missing set = not found, write
and read back, whole-set replacement, idempotence, empty set and wrong address family refused without a write, A and
AAAA independent), each against a local fake of its provider's documented API. Adapter errors name the provider, the
operation, hostname, type and status code only — never a token or a record address. Sources of the API facts:
`references/dns-provider-apis-2026-11-19.md` (internal).

| `kind` | Provider | How a set is replaced | Credential | Config fields |
|---|---|---|---|---|
| `azure` | Azure DNS (Record Sets, api-version 2018-05-01) | one `PUT …/dnsZones/{zone}/{A\|AAAA}/{relative}` with the whole set (`@` for the apex); `GET` 404 = empty | the VM's **managed identity**: token from the instance metadata service (`Metadata: true`, never through a proxy), cached until 5 min before `expires_on`, dropped on a 401. Nothing on disk | `subscription_id` (GUID), `resource_group`, optional `endpoint` (default `https://management.azure.com`), optional `imds_endpoint` (tests) |
| `cloudflare` | Cloudflare DNS (API v4) | list (`type`, `name.exact`, `per_page=100`; more than one page is refused, never truncated), then **one** `POST /zones/{id}/dns_records/batch` with `deletes` + `posts` (one transaction: all or nothing); nothing sent when the set already matches; every record `proxied: false` (DNS only) with the set's TTL | API token in `token_file` (Bearer) | `token_file`, optional `endpoint` (default `https://api.cloudflare.com/client/v4`); the zone id is looked up by name once and cached |
| `http` | reference REST API (`GET\|PUT /v1/zones/{zone}/rrsets/{name}/{type}`, bearer token) served by `cmd/fake-dns-provider` | PUT | `token_file` | `endpoint`, `token_file` |
| `memory` | unit tests | — | — | — |

ARM and Cloudflare requests honour `HTTPS_PROXY` (the egress proxy, C-10); allow `management.azure.com` and
`api.cloudflare.com` for the controller's host class. Every call runs under the round's `provider_timeout`.

**Least privilege.**
- Azure: a custom role on each zone the controller owns sets in, with exactly `Microsoft.Network/dnsZones/read`,
  `Microsoft.Network/dnsZones/A/*` and `Microsoft.Network/dnsZones/AAAA/*`, assigned to the managed identity of each
  controller host (`mon-c`, `core-b`). No other record type, no zone delete.
- Cloudflare: an API token with **DNS Write** and **Zone Read**, restricted to the zones concerned (Zone Resources =
  those zones only); stored SOPS-encrypted and mounted as a file.

Example (`providers` of the config file; both providers get every owned set, C-27):

```json
"providers": [
  { "name": "azure-dns", "kind": "azure",
    "subscription_id": "00000000-0000-0000-0000-000000000000", "resource_group": "scf-rg-dns" },
  { "name": "cloudflare", "kind": "cloudflare", "token_file": "/run/secrets/cloudflare_dns_token" }
]
```

Further adapters (deSEC `PUT /api/v1/domains/{zone}/rrsets/{subname}/{type}/`, Hetzner DNS, RFC 2136 with
`github.com/miekg/dns`) map the same three methods and must pass the same contract test.

## Tests

```sh
eval "$(mise env -s bash)"; cd services/health-controller
go test ./...                                                   # unit + process-level (Docker for etcd), 2 s rounds
SCF_HC_REALTIME=1 go test -count=1 -timeout 20m ./integration/   # production timing: 30 s rounds
```

`integration/` runs the real binaries: two controllers elected through a real etcd 3.6.6 container, two fake DNS
provider processes, four fake edges speaking the tracker protocol. It kills an edge (removed at both providers within
the bound — **83 s with 30 s rounds**, bound 2 min), takes provider B's API down while another edge dies (A is updated,
B catches up when it returns), SIGKILLs the leader (the other takes the lease and keeps managing DNS), recovers the
edge (re-added after five good rounds — 150 s) and kills every edge (the last address stays). Host ports 56320–56330.
`ops/e2e/run.sh` repeats the kill/recover cycle inside the Compose overlay against the real gateway.

Image: `docker build -f services/health-controller/Dockerfile -t usagemap/health-controller:dev .` (repository root as
context; distroless, uid 65532, read-only root).
