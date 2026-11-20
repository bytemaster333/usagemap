# Security policy

This is the security policy of UsageMap: this repository, the browser tracker and its npm package, the hosted
service, and the UsageMap build of Umami. The full process behind it is
[`docs/security/vulnerability-response.md`](docs/security/vulnerability-response.md) (capability `security.patch-24h`;
ADR-0023, ADR-0031).

## Reporting a vulnerability

Please report security issues privately by e-mail to **`security@usagemap.dev`**, or through GitHub's "Report a
vulnerability" button of this repository (private vulnerability reporting). The mailbox is read by the first
security responder (`docs/sla.md` §6.3). **Do not open public issues for security problems.** Include what you found, how to
reproduce it, and the impact you expect. If you find credentials, API keys (they begin with `scfa_`) or personal
data, report them without using them further.

## What to expect

- We acknowledge reports within **one business day** and aim to triage within **48 hours**.
- **Critical and high vulnerabilities in our deployment are patched or mitigated within 24 hours** of triage
  confirming them, or of the advisory appearing in a source we watch. "Mitigated" means a compensating control that
  makes the vulnerability unreachable or unexploitable in our deployment when upstream has no fix yet; we say which
  one we deployed (`docs/security/vulnerability-response.md` §1, §8). Critical and high are CVSS ≥ 7, a CISA KEV
  listing, or EPSS ≥ 0.1 (§4).
- We keep you informed at least weekly, credit you in the advisory unless you prefer otherwise, and agree a
  disclosure date with you. By default we publish when the fix is deployed, and no later than 90 days after your
  report unless we agree otherwise.

## Scope

In scope: this repository, the tracker and its npm package `@usagemap/tracker`, the hosted service at
`usagemap.dev` and its subdomains, and our build of Umami (`vendor/umami`). Issues in upstream projects (Umami, Next.js,
OpenTelemetry, PostgreSQL and others) should also be reported upstream; tell us too, because we may be able to
mitigate sooner.

Out of scope: volumetric denial of service, social engineering of maintainers or tenants, physical attacks, findings
that require a compromised tenant site or browser, missing best-practice headers without an exploit, and the
existence of public site keys (they are public by design).

## Safe harbour

We will not pursue or support legal action against you for research that: is in scope; uses only your own accounts
and test tenants (create as many as you need); does not access, modify or retain data belonging to other tenants or
visitors beyond the minimum needed to demonstrate the issue, and stops and reports immediately if you encounter such
data; does not degrade the service for others (no load testing, no spam, no automated scanning that exceeds normal
rate limits); does not inflate or alter any real project's analytics; and gives us reasonable time to fix the issue
before disclosure. We consider such research authorised, will treat it as good-faith activity, and will say so if a
third party asks. This does not waive the rights of third parties we do not control. If in doubt, ask us first.

## Supported versions

| Component | Supported |
|---|---|
| Hosted service | Always the current deployment; there are no older versions to support. |
| Platform images and this repository | The latest release. Security fixes ship as a new release through the emergency release path (`docs/security/vulnerability-response.md` §7). |
| Browser tracker (`/lib/<version>/…` and `@usagemap/tracker`) | **Every released version stays served** so that tenants upgrade only when they choose to (ADR-0004). A version with a security defect is **withdrawn**: its files answer `410 Gone`, an advisory is published, tenants using it are notified, and the fix ships as a new version. |

## Verifying what we ship

- **Container images** are built from this repository's Dockerfiles with base images pinned by digest; anyone can
  rebuild them from a tagged commit.
- **The tracker** is built reproducibly; every script is pinned by an SRI hash in the tenant's snippet, and anyone can
  rebuild a release and compare it (`pnpm --filter @usagemap/tracker run verify-reproducible`).
- **Traction snapshots** (the signed usage statements projects give to SCF programmes) are Ed25519-signed over RFC 8785
  canonical JSON. The keys are published at `/.well-known/scf-snapshot-keys.json`; the procedure is in
  [`docs/contracts/wire-formats.md`](docs/contracts/wire-formats.md) §i.3, and the portal page `/verify/<snapshot id>`
  runs the same check in the browser.

