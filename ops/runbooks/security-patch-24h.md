# Runbook: 24-hour security patch

Status: to be exercised (no drill has run)
Owner: security responders (two named maintainers, C-67; names open)
Last reviewed: 2026-11-18
Triggered by: `DependencyAdvisoryUrgent`, `UmamiUpstreamSecuritySignal` (`vulnerability-response.md`), a private
report, or a finding in our own code (cross-tenant exposure counts whatever its score)

Policy and rationale: `docs/security/vulnerability-response.md` (this runbook is its operational checklist; if they
disagree, that document wins and this one is corrected). Decisions: ADR-0023, ADR-0031, C-49, C-67, C-106, C-111.

**Built today:** the Umami patch queue `vendor/umami/patches/` (empty) and the engine-proxy allow-/deny-lists
(`services/engine-proxy/internal/policy`). Advisories reach the responders through their subscriptions to the
sources listed in `docs/security/vulnerability-response.md`; dependency and image scans are run by hand by the
responder with the scanners they use. **Planned:** the advisory pollers (KEV, EPSS, GHSA, NVD/VulDB, Umami `dev`
commits), the automatic patch change and push notification, and signed releases.

## The clock

- **Starts** when the advisory appears in a watched source or is reported to us (C-67); for a re-classification
  (new KEV listing, EPSS rise, public exploit) when that information appears. The responder who sees it first
  writes the time down; escalate to every maintainer when 18 h have passed without a deployed fix.
- **Stops** when the fix or compensating control is **deployed to production and verified** on every node — not when
  a pull request merges.
- Write the start time into the private record at once.

## Checklist

1. **Record** (≤ 15 min): open a draft repository security advisory (our own code) or a private ops issue: clock
   start, source, component, advisory id. Never discuss an unfixed issue in public. For an advisory already public
   upstream (a dependency or base image), the record is the private ops issue; no repository advisory is needed.
2. **Triage** (≤ 2 h): 24-hour class if any of — CVSS ≥ 7 and reachable; KEV; EPSS ≥ 0.1; malicious version of
   anything we ship or build with; any tracker / Wallets Kit adapter flaw; any cross-tenant exposure in our code
   (vulnerability-response §4). Find affected images and versions from the SBOMs / lockfiles
   (`pnpm why <pkg>`, `go list -m all` in the module). Reachability uses the exposure model (Umami is reachable only
   through the engine proxy's allow-lists).
3. **Decide**:
   - upstream fix available → bump (step 5);
   - no fix, or Umami's fix not released → compensating control first (block the route at the engine proxy's
     deny-list, disable a feature by setting) and/or our own patch in `vendor/umami/patches/` (see
     `umami-upgrade.md` for the rebuild);
   - tracker flaw → publish a fixed version within 24 h, withdraw the vulnerable one (`410`, C-37), notify tenants;
     we cannot change versions tenants have pinned;
   - not reachable (never for KEV or malicious packages) → a reviewed written justification naming the blocking
     control closes it.
4. **Contain early** if the fix takes hours: a deny-list entry costs minutes and does not touch the ingest SLO.
   Record reviewed and false-positive advisories in the private record with a written reason and a review date at
   most 30 days ahead.
5. **Fix**: pull request labelled `security-hotfix`. Allowed: a dated minimum-release-age exclusion for the named
   package only, one approver from the responders' bypass list (both logged). Run `make lint test spdx`;
   `make test-engine` for Umami. For a base-image or runtime bump:
   - resolve the new index digest (`docker buildx imagetools inspect <image>:<tag>`) and check the version inside the
     image config (`PG_VERSION`, `NODE_VERSION`) against the vendor's page; update every pin, including `mise.toml`
     and the version comments next to each pin (the Debian `postgres:18` tag carries no minor: keep the `PG_VERSION`
     comment of `infra/compose/ha/postgres/Dockerfile` current);
   - rebuild and scan only the affected images;
   - a rebuilt image may show a **new** finding with no fixed package in the distribution (2026-11-18: OpenSSL
     3.5.9-r0 in Alpine): record it in the private record with a review date at most 30 days ahead and a follow-up;
     a finding with a fix is never excepted.
6. **Release**: build the fixed images the normal way (`docs/guides/deploy-v1.md`); a second person reviews the
   change before it is deployed.
7. **Deploy and verify**: one edge node first, then the rest (a node drains by closing its listener); verify by
   exercising the vulnerable path (it must be blocked or fixed) and confirming the running digest on every node.
   Locally the equivalent is `infra/compose/scripts/smoke.sh` (or `make up`: the local stack needs
   `compose.dev.yaml` and the secrets of `infra/compose/scripts/init.sh` — `docker compose -f compose.yaml` alone does
   not start) plus the service's tests; for the production playbook `infra/ansible/tests/lean/run.sh`.
8. **Communicate**: advisory after the fix; tenants and SCF operators if they are affected
   (vulnerability-response §10).
9. **Record evidence**: clock start/stop, classification, decision, digests, verification; misses of the 24 hours are
   published in the monthly patch-latency report.
10. **Follow up**: replace a compensating control with the real fix; remove the release-age exclusion and any
    exception-list entry; post-mortem if the 24 hours were missed (`incident.md`).

## Out of hours

No on-call. Both responders receive the push; the person on daily watch checks that one of them picked it up
(C-49). If neither acknowledges within 4 hours, the alert should re-fire to all maintainers (proposed, VR-02). The
commitment depends on a person acting; misses are measured and published.

## Drill

Feed a synthetic advisory against a pinned dependency in a branch, run steps 1–7 against the local stack, record the
times in `README.md` (drill log).
