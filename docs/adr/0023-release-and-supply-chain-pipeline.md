# ADR-0023: Release and supply-chain pipeline

- **Status:** Accepted as the target design. The release pipeline below is the target design for when a
  release pipeline is set up again; the dependency controls in `pnpm-workspace.yaml` and `go.sum`, deploy-time
  verification of signed images (when signing is configured) and the 24-hour patch process stay in force.
- **Date:** 2026-11-12
- **Capabilities:** tracker.version-pinned, tracker.no-remote-updates, tracker.intentional-upgrade, security.supply-chain, security.patch-24h, handover.repo-transfer, handover.domain-transfer, licence.osi-only, docs.security

## Context
UsageMap needs a robust, documented defence against supply-chain attacks (security.supply-chain), a pinned
tracker with no dynamic remote updates (tracker.version-pinned, tracker.no-remote-updates), and critical/high vulnerabilities patched within 24 hours
(security.patch-24h). Our tracker will sit on wallet-connected dApp pages, which makes it a target of the polyfill.io /
Ledger Connect Kit class.

Lessons from 2026 incidents marked VERIFIED from primary sources (re-check before citing them publicly):
- **Trivy, CVE-2026-33634 / GHSA-69fq-xp46-6x23 (Aqua's own advisory):** on 2026-03-19 Trivy v0.69.4 binaries were
  malicious for ~3 h, 76 of 77 `trivy-action` tags and all 7 `setup-trivy` tags were force-pushed to malicious
  commits, and Docker Hub images 0.69.5/0.69.6 followed on 2026-03-22. Images pinned by digest were unaffected.
  Lesson: scanners are privileged third-party code; pin by SHA/digest and run them without secrets.
- **TanStack (2026-05-11):** 84 malicious versions in 42 packages were published **through trusted publishing**
  after a `pull_request_target` workflow poisoned a cache. **AsyncAPI (2026-07-14):** five malicious versions
  "carried valid provenance attestations". **LiteLLM (2026-10-21):** compromised images carried a valid signature
  from the project's old cosign key. Lesson: provenance proves where something was built, not that it is benign.

Platform facts: npm **staged publishing** GA in npm 11.15.0 (2026-05-22): a publishing workflow
can only queue a tarball and a maintainer must approve it with 2FA; a trusted publisher can be stage-only; since
2026-10-02 staging can create new packages; all classic npm tokens were revoked on 2025-12-09. GitHub **workflow
lockfiles** (`actions.lock`, pinning transitive actions) are GA since 2026-10-28; `pull_request_target` is blocked
by default in public repos from 2026-12-02; immutable releases are GA since 2025-10-28. GitHub artifact attestations
alone give SLSA v1.2 Build L2; a reusable workflow can reach L3. Docker Content Trust shuts down 2026-12-08.
pnpm 12 (12.18.0): `minimumReleaseAge` is strict only when set explicitly; `trustPolicy` defaults to off; its
two-document lockfile can make scanners report "no dependencies". gitleaks-action is under a proprietary EULA
(the binary is MIT). Umami's upstream image is unsigned, built with tag-pinned actions, and installs runtime
packages without a lockfile (F33), hence ADR-0003's own rebuild.

## Options considered
1. **Layered pipeline with a human 2FA gate on every tracker release (chosen).** Pros: no single person or single
   compromised workflow can ship a tracker version; every control is checkable by anyone. Cons: release
   latency and two available humans are required, also for hotfixes.
2. **Trusted publishing + provenance only.** Pros: simpler. Cons: the 2026 cases above shipped through exactly this.
3. **Signature-based SRI (`ed25519-…`, Chrome 141+).** Pros: rotation without hash changes. Cons: Chromium-only, and
   "any version signed by key K" is the dynamic-update channel the design forbids.
4. **Dependabot as the update bot.** Pros: native `actions.lock` regeneration. Cons: weaker polyglot coverage
   (Compose digests, OpenTofu, Ansible Galaxy, mise). Dependabot alerts stay on as a second signal.

## Decision
**Tracker release.** Released versions stay served for the life of the service. A version is **withdrawn only for
a security defect**: its URL then returns `410 Gone` (pages that pin it stop sending analytics and are otherwise
unaffected) and an advisory is published (C-37). Reproducible build in a digest-pinned container; a second, independent build rebuilds from
the tag and must match the published sha384. A hash manifest is signed keylessly with Sigstore (`cosign sign-blob
--bundle`) and attached to an **immutable GitHub release** with provenance. npm publishing is **stage-only trusted
publishing**: the release workflow stages, a human approves on npm with 2FA after reviewing the bundle diff; a second human approves
the GitHub `release` environment, so **two people** sign off every release. Every generated snippet carries SRI.

**Images.** All our images and the Umami rebuild are built in an **isolated reusable release workflow**, signed with
cosign (keyless), given SLSA provenance and an SBOM (SPDX + CycloneDX via Syft), and referenced **by digest**; the
deploy playbook verifies signature and provenance before starting anything (ADR-0019). Edge images are rebuilt
monthly for the geo database (C-38). The cloud, Private Relay, Tor-exit and VPN range lists are **never put into
published images**: they carry no redistribution licence, so a range-list updater on each edge node fetches them
(C-38, ADR-0006).

**Build automation never holds production credentials (C-79).** It builds, tests, signs and publishes only. Deployments run from a
service-operator workstation with SOPS-decrypted secrets, or from a pull-based agent on the nodes, which verifies
signatures and provenance before starting an image (ADR-0019). A compromised workflow can therefore publish a bad
artifact (which the deploy-time verification and the two-person release gate are there to stop) but cannot run
Ansible or SSH against production.

**Honest SLSA claim:** "SLSA v1.2 **Build L3** provenance for the tracker and all images (GitHub-hosted runners,
isolated reusable release workflow, Sigstore keyless)". Conditions: no self-hosted runners and no shared build
caches in release jobs; release jobs consume no artifacts from untrusted jobs. We do **not** claim a Source-track
level (GitHub issues no source provenance) — we say "two-person review enforced by ruleset". There is no Build L4.
Provenance and signatures are presented as attribution and audit tools, not as proof that a release is safe.

**Dependencies.** pnpm with `minimumReleaseAge: 4320` (3 days, set explicitly so it is strict), `trustPolicy:
no-downgrade`, `strictDepBuilds` with an `allowBuilds` allow-list, `blockExoticSubdeps`, frozen lockfile,
`trustLockfile: false`. Go with `go.sum` and the public checksum database, `GOTOOLCHAIN=local`, `-trimpath`,
`govulncheck`. Dependency updates keep the 3-day delay and digest pinning and are never merged automatically.

**Workflows.** Every action pinned by full SHA and covered by `actions.lock`, with the org policy requiring both;
top-level `permissions: {}`; `persist-credentials: false`; no `pull_request_target`; no event interpolation in
`run:`; zizmor and actionlint as gates; release only from protected tags. **Scanners** (osv-scanner, Grype, Trivy,
gitleaks) run as pinned, signature- or checksum-verified binaries in jobs with no secrets and a read-only token,
each with a known-vulnerable **canary** fixture that must produce a finding. CodeQL, the licence allow-list gate
(ADR-0001; the list itself is in `docs/security/supply-chain.md`, C-40), `reuse lint`, secret scanning with push protection, OpenSSF Scorecard weekly.

**24-hour patch process** (`docs/security/vulnerability-response.md`): triggered by CVSS ≥ 7, a CISA KEV listing,
EPSS ≥ 0.1, a malicious dependency, or any tracker vulnerability. **The clock starts** when an advisory affecting a
component we run appears in a watched source or is reported to us (C-67). The pipeline opens the patch change
automatically and sends a push notification to **two named responders**; "patched or mitigated within 24 hours"
depends on one of them acting on it, which the service operator's team must accept together with the daily watch duty (C-49). "Patched" means fix or compensating control
**deployed** with evidence; a finding in an unreachable path may be closed by a reviewed VEX statement. When
upstream has no fix: block the route at the gateway, switch dashboards to read-only while ingest stays up,
disable the feature, rotate credentials, or for the tracker publish a fixed version and withdraw the affected one
(`410 Gone` plus advisory, C-37).

**Domain.** Registry lock, CAA restricting issuance to our CA and ACME account (`accounturi`), and
certificate-transparency monitoring from day one; renewal prepaid well past any planned handover. **DNSSEC is not
enabled on the ingest zones at launch** (C-31): multi-signer DNSSEC across two DNS providers is an availability
risk we do not take for a 99.99 % target; SRI protects tenants' pages from a hijacked script host. Revisit after
the first six months of operation. At handover the service domains are **transferred** to the new service operator;
a redirect is not sufficient for ingest from pinned trackers (C-50).

| Threat | Controls | Residual risk |
|---|---|---|
| Our origin serves modified tracker bytes | SRI in every snippet; immutable versioned URLs, no alias; gateway serves only manifest-listed hashes; npm-bundle and self-host modes | Tenants who remove `integrity` |
| Domain changes hands or lapses | SRI turns it into an outage, not code execution; registry lock, CAA, CT monitoring; domain transfer at handover (C-50) | Embeds without SRI |
| DNS hijack or spoofed answers for the ingest zones | Registry lock; hardware-key 2FA at registrar and DNS providers; SRI on script embeds; TLS on every ingest host | No DNSSEC at launch (C-31) |
| Malicious npm version of the tracker | No npm token exists; stage-only trusted publisher; human 2FA approval after diff of a ~2–3.5 kB bundle; reproducible-build check; zero runtime dependencies | A phished approver approving a malicious stage |
| Compromised dependency in our build | 3-day release age; trust policy; build-script allow-list; frozen lockfile; osv-scanner | Dormant malicious code older than 3 days |
| Compromised Action or scanner | SHA pins + `actions.lock`; few third-party actions; scanners as verified binaries without secrets | Compromise of GitHub's own actions |
| Workflow injection / pwn request | No `pull_request_target`; zizmor/actionlint; least-privilege permissions | Logic bugs static analysis misses |
| Release forged from a branch or PR | Tag rulesets; `release` environment with required second-maintainer approval, prevent self-review; CODEOWNERS on `.github/`, `tracker/`, `infra/` | Two colluding or phished maintainers |
| Tampered image at deploy | Digest-only Compose; `cosign verify` + attestation check before start; own Umami build | Hoster root compromise |
| Upstream vulnerability (e.g. Umami's Next.js) | 24 h process with automatic patch change and push to two responders (C-67); the engine proxy with per-node mTLS and per-caller path allow-lists in front of Umami (C-60, C-74); daily rescans of deployed digests | Zero-days without a fix; responders not acting within 24 h |
| Build backdoor (xz-style) | Independent reproducible tracker rebuild; review of build-script diffs | Large dependencies we cannot audit |
| Compromised build workflow approved into a release | Build automation holds **no** production credentials; deploys only from a service-operator workstation or a pull-based agent (C-79); two-person release gate; deploy-time signature and provenance verification | A malicious artifact that passes review and verification |
| Secrets theft from workstations | SOPS/age with per-person recipients; push protection; hardware-key 2FA; OpenTofu state credentials on no server (C-79) | Hoster API tokens (no OIDC) on deploying workstations |
| Handover breaks the trust chain | Keyless signing; signed identity-transition file; repository-ID pinning; secret rotation, except key peppers and the snapshot-signing key, which are handed over securely and rotated afterwards with overlapping tokens (C-50) | Successor's own practices; provider accounts, registry and signing identity after a repository transfer are unverified until the rehearsal (C-50) |

**Settings the humans must apply** (outside the repository; checklist in `docs/security/supply-chain.md`):
- **GitHub org:** ≥ 2 owners; 2FA with security keys for all; allowed actions "selected" + require full SHA +
  require lockfile; keep `pull_request_target` blocked; default `GITHUB_TOKEN` read-only, Actions may not approve
  PRs; approval for outside-collaborator fork workflows; immutable releases; private vulnerability reporting,
  secret scanning + push protection, Dependabot alerts, CodeQL.
- **GitHub repo:** `main` ruleset (2 approvals, CODEOWNERS, dismiss stale, last-push approval, required checks,
  signed commits, linear history, no force-push); tag rulesets for `v*`/`tracker-v*`; environments `npm-release`,
  `images-release` with required approval by a second maintainer and prevent self-review (there is no `production` environment holding
deploy credentials, C-79); Scorecard; bestpractices.dev.
- **npm:** organisation scope with ≥ 2 owners on WebAuthn; stage-only trusted publisher bound to repo, workflow and
  environment; "Require two-factor authentication and disallow tokens"; no granular write tokens.
- **Registrar / DNS:** hardware-key 2FA; registry lock where the TLD offers it; renewal prepaid ≥ 3 years; CAA with
  `accounturi` and `iodef`; CT monitoring subscription; DNSSEC left off on the ingest zones at launch (C-31). **Hosting:** 2FA; per-project scoped API tokens.

## Consequences
Positive: every claim is verifiable by anyone with public tools; a full build or repository compromise still cannot
make a tracker version installable without a human passing 2FA, nor reach production, because no build automation
holds production credentials (C-79); deploys refuse unsigned images.

Negative: releases, including emergency ones, need two available humans, and a deploy needs a
service-operator workstation or the pull agent, not only build automation (C-79); the 24-hour clock
depends on two named responders and the daily watch roster; hoster tokens remain
long-lived; the 24 h promise depends on our ability to rebuild Umami with bumped dependencies.


Revisit if: npm or GitHub change the controls above; six months of operation have passed (DNSSEC, C-31); a 3-day release age proves too short (the incidents file
suggests ≥ 7 days); GitHub's native egress firewall ships; counsel rules on our CRA status (Art. 14 reporting has
applied since 2026-09-11; LIKELY, text read from an unofficial mirror).

Unproven: scanner handling of pnpm's two-document lockfile (S-09); the reproducible tracker build; the npm "one vs
up to 10 trusted publishers" doc conflict; Sigstore identity behaviour after a repository transfer.

## Open points
1. Open: who the two release approvers and the two named patch responders are, and whether the service operator's team accepts the
   daily watch duty — decided by the service operator's team.
