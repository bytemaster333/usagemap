# External status checks (Gatus, Upptime)

Ready-to-deploy configuration of the outside view of availability (core plan C1 item 5; slo.ingest-availability, slo.dashboard-availability; ADR-0022,
DV-06, C-30). `sli.json` is the single source; `node ops/status/generate.ts` writes the two tool configurations.

| Vantage point | Tool | Cadence | Where | Files |
|---|---|---|---|---|
| `github` | Upptime | 5 min (GitHub's cron minimum) | GitHub-hosted runners — infrastructure we do not operate; publishes the public status page | `upptime/.upptimerc.yml` → root of the `ORG/status` repository |
| `probe-d` | Gatus v5.38.0 | 30 s (the probe round) | a small VPS at a provider that hosts nothing else of ours (docs/sla.md §17 P7) | `gatus/config.yaml`, `gatus/compose.yaml` |
| `app-1` | `scf-ops probe` | 30 s | the application host (inside the failure domain): the full canary SLI with proof-of-work and signed-in journeys | `ops/probes/`, `ops/README.md` |

## What each check means (docs/sla.md §2.2, §3.3)

| Check | Request | Pass |
|---|---|---|
| `ingest-a`, `ingest-b` | `GET <ingest host>/healthz` | `200`, body `status` = `ok`, within **2 s**. The gateway answers `200` only while it holds a snapshot and the current keys, its spool is durable and it is not draining. A vantage point records a slot good when **either** host passed (the tracker retries on the other host). |
| `portal` | `GET <portal>/portal-healthz` | `200` within **3 s** |
| `dashboard-api` | `GET <portal>/public/v1/health` | `200` or `503` (503 = some component down) with `components.dashboards` = `ok`, within **3 s** — the API behind the portal reaches the database |

Limits, stated plainly: an external check cannot solve the proof-of-work or sign in, so it does not send a canary
event or run a journey; those are measured by `scf-ops probe` on `app-1`. Upptime marks a slow answer as
*degraded*, not *down* (its `maxResponseTime`), so its page is a cross-check; Gatus fails the check at the threshold.
Turning Gatus results into the monthly figure needs an export of its results into the probe-store CSV format
(`ops/internal/store`), which does not exist yet. The monthly verdict applies the **95 % coverage floor**
(`tools/support/slo-report.ts`): a month with less than 95 % of its slots measured is reported as *not measured*.

## Deploy

- **Upptime:** create `ORG/status` from the Upptime template, copy `upptime/.upptimerc.yml` to its root, set the
  repository secrets `SCF_STATUS_INGEST_URL_A`, `SCF_STATUS_INGEST_URL_B`, `SCF_STATUS_PORTAL_URL` (base URLs,
  `https://…`, no trailing slash) and the token Upptime needs (`GH_PAT`, held by an organisation owner; handover
  item I-20), replace `ORG` and `<domain-a>`.
- **Gatus:** on the vantage host, `docker compose -p scf-status -f ops/status/gatus/compose.yaml --env-file
  /etc/scf/status.env up -d` with the three base URLs in the env file.

## Test

```sh
node --test ops/status/test/*.test.ts       # generated files current; thresholds = docs/sla.md; routes exist (no Docker)
ops/status/test/gatus-it.sh                 # the pinned Gatus image judges stand-in endpoints (Docker, project scf-st-it)
```
