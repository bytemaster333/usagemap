# Supply-chain security strategy

> Design goal: robust defence against supply-chain attacks, with the strategy written down
> (capability `security.supply-chain` in [`../capabilities.md`](../capabilities.md)).

Status: **design-phase strategy, 2026-11-12.** Binding decisions: ADR-0004 (tracker), ADR-0003 (Umami build),
ADR-0019 (deploy verification), ADR-0023 (release and supply-chain pipeline), ADR-0001 (licences), ADR-0017 (domains,
no CDN), and the register's Clarifications C-01 … C-112, in particular C-27 (DNS as code), C-31 (DNSSEC), C-37
(tracker withdrawal), C-38 (range lists never in images), C-40 (this document holds the authoritative licence
allow-list), C-50 and C-81 (handover, peppers), C-61 (edge DNS credential), C-67 (patch clock), C-79 (build automation never
holds production credentials), C-100 (tracker build), C-104 (our Umami image), C-106 (scanners, geo database) and C-107
(Collector build). The incidents that shaped the controls are summarised in §9. Threats are numbered as in
[`../threat-model.md`](../threat-model.md) (TM-TRK-*, TM-OPS-04, TM-UMA-06). Anything this document recommends that the
register does not contain is in §12 and is not presented as decided.

The release pipeline (§3.3, §3.4, §4, §6) is the target design for when a release
pipeline is set up; nothing in this repository runs it today. What stays in force: the pnpm and Go intake rules
(§5), the licence allow-list (§5.1, applied on review), digest pinning, deploy-time verification of signed images when
signing is configured (§6), and the 24-hour patch process run by the maintainers (`vulnerability-response.md`).

Placeholders a deployment fills in: domains `<domain-a>`, `<domain-b>`; repository `ORG/REPO`; npm package
`@SCOPE/tracker`.

## 1. Strategy in one page

Our tracker runs inside wallet-connected dApps, so a malicious byte in it is a wallet drainer. The strategy has five
parts:

1. **Make the shipped code small, inert and pinned.** One classic script, zero runtime dependencies, no `eval`, no
   dynamic import, no remote configuration, no storage, no wallet access, ≤ 3.5 kB gzip; served only from immutable
   versioned URLs with an SRI hash in every snippet we generate; no `latest` alias; npm and self-hosting as stronger
   alternatives (ADR-0004).
2. **Make every release checkable by anyone.** Reproducible tracker build verified by an independent job; a hash
   manifest signed with Sigstore; SLSA Build L3 provenance for the tracker and every image; SBOMs (ADR-0023).
3. **Put humans where 2026's attacks went around automation.** npm staged publishing (the release workflow can only stage; a human
   approves with 2FA) plus a GitHub environment approval by a second person (ADR-0023). Trusted publishing and
   provenance alone did not stop the 2026 TanStack and AsyncAPI releases (§9).
4. **Narrow what enters the build.** pnpm with a minimum release age, a strict build-script allow-list and a trust
   policy; Go checksum database and `govulncheck`; dependency updates with a 3-day delay and digest pinning; workflow
   actions pinned by SHA (ADR-0023).
5. **Verify at the last step and own the naming layer.** Images are referenced by digest and cosign-verified before
   any container starts (ADR-0019); Umami is rebuilt by us from a pinned commit (ADR-0003); domains carry registry
   lock, CAA and certificate-transparency monitoring from day one; DNSSEC is deliberately not enabled at launch (C-31);
   edge nodes cannot change DNS service records (C-61).

## 2. What we claim, and what we do not

### 2.1 Claims (each verifiable by anyone)

| # | Claim | How to verify |
|---|---|---|
| C1 | The tracker is served only from immutable, versioned URLs `/lib/<semver>/<profile>.js`; there is no `latest` alias; unknown versions return 404; a version withdrawn for a security defect returns `410 Gone` and has a published advisory (ADR-0004, C-37). | Request an unversioned, unknown or withdrawn path; read the gateway route table and the advisory list. |
| C2 | Every snippet our portal generates carries an SRI hash and `crossorigin="anonymous"` (ADR-0004/0024). | Onboarding wizard output; e2e test. |
| C3 | The tracker has zero runtime dependencies, no `eval`/dynamic import/remote config/storage (except the opt-out flag)/wallet access, and a size budget enforced by tests (ADR-0004). | `package.json`; lint, bundle-content and size tests. |
| C4 | The tracker build is reproducible; an independent job rebuilds each release and compares hashes with the signed manifest (ADR-0023). | Run the documented rebuild for any tag. |
| C5 | Tracker files and all images carry **SLSA v1.2 Build L3** provenance from an isolated reusable workflow on GitHub-hosted runners, a Sigstore keyless signature and an SBOM (ADR-0023). | `gh attestation verify`; `cosign verify`. |
| C6 | No npm write token for our package exists. Publishing is trusted-publishing-only and stage-only; each version needs a human 2FA approval on npm and a separate GitHub environment approval by another person (ADR-0023). | npm package settings; environment protection rules; release records. |
| C7 | Production verifies signatures and provenance before starting any container; images are referenced by digest only (ADR-0019). | Deploy logs (verification output is recorded). |
| C8 | We build Umami ourselves from a pinned upstream commit fetched by SHA and checksum-verified, and never deploy upstream's image (ADR-0003). | `vendor/umami`, our Dockerfile, image SBOM. |
| C9 | Every workflow action is pinned by SHA; workflows run with least-privilege permissions (ADR-0023). | The workflow files in `.github/workflows/`. |
| C10 | Critical/high vulnerabilities are patched or mitigated within 24 h of the advisory appearing in a watched source or being reported to us, by the rule in [`vulnerability-response.md`](vulnerability-response.md), with a public monthly patch-latency report (ADR-0023/0031, C-67). This depends on one of two named responders acting; the service operator must accept that with the daily watch duty (C-49). | Monthly patch-latency reports. |

### 2.2 What we do **not** claim

- **No SLSA Source level.** GitHub does not issue source provenance for revisions; we enforce two-person review by
  ruleset and say exactly that, without a Source-track level.
- **No "SLSA L4"** — there is no Build L4 in SLSA v1.2.
- **No bit-for-bit reproducible images or Umami build.** Only the tracker is claimed reproducible. Measured in the
  day-0 spikes: two cold builds of our Umami image gave different image IDs (inputs pinned, outputs carry timestamps;
  C-104), and the Collector binary built from a dirty git tree is stamped with `vcs.modified` and is not reproducible
  (S-04; the release pipeline builds from a clean checkout or with `-buildvcs=false`, C-107).
- **Not every build input is pinned by our own checksum.** During the Umami image build, `@prisma/engines`' install
  script downloads Prisma's `schema-engine` binary from Prisma's server (version fixed by the lockfile, checked by
  Prisma against a `.sha256` from the same server). Vendoring it and setting `PRISMA_SCHEMA_ENGINE_BINARY` would close
  this; not done yet (C-104).
- **Provenance is not proof of benign code.** It proves which workflow built an artifact, not that the workflow or
  its inputs were clean (§9, TanStack, AsyncAPI).
- **We cannot protect tenants who remove SRI, modify the npm package in their build, or self-host a modified copy.**
- **"Patched within 24 h" for the tracker means a fixed version is published and tenants are told.** Pinned tenants
  must upgrade themselves; we cannot and must not change code they have pinned (no remote updates of tracking code). Withdrawing a harmful
  version (`410 Gone`, C-37) stops it loading for pages that fetch it from us and stops its events reaching us; it does
  not reach copies already cached by browsers, bundled from npm or self-hosted.
- **No claim about hosted-provider or CDN SLAs** — we use no CDN (ADR-0017).

---

## 3. The tracker

### 3.1 Pinning, immutability and SRI (ADR-0004)

- **URLs.** `https://<ingest host>/lib/<semver>/<profile>.js`, profiles `standard` and `strict`. The files and the
  signed manifest are **compiled into the gateway binary**, so a node cannot serve bytes that were not in the signed
  release (ADR-0005). There is no `latest`, no major or minor alias, no directory listing; unknown versions return 404.
- **Headers.** `Cache-Control: public, max-age=31536000, immutable`; CORS allowing anonymous cross-origin fetches
  (required for SRI); `X-Content-Type-Options: nosniff`; a JavaScript content type; no cookies on the script origin.
  Exact header list in `docs/contracts/wire-formats.md`.
- **SRI.** The portal's snippet generator emits `integrity="sha384-…"` and `crossorigin="anonymous"`; we never publish
  a snippet without `integrity`. A mismatch makes the browser refuse to execute the file — analytics stops, the
  tenant's page keeps working.
- **Lifetime.** Every released version stays served for the life of the service; the wire protocol `v1` stays
  backward compatible (ADR-0004). Tenants upgrade by changing version and hash, or bumping the npm dependency.
- **Withdrawal (C-37).** A released version is withdrawn **only for a security defect**: its URL then returns
  `410 Gone`, the gateway answers `410` to events from that version (C-39), and an advisory is published. Pages that
  pin it stop sending analytics and are otherwise unaffected. Withdrawal never substitutes other bytes at the URL.
- **No remote control.** The tracker has a fixed list of two ingest hosts on two domains (ADR-0004); no
  configuration is fetched. We do not use Chromium's signature-based SRI (`ed25519-…`), because "any version signed by
  key K" is exactly the dynamic-update channel the design rules out.

### 3.2 Reproducible build and signed manifest (ADR-0023)

- The tracker is built in a container pinned by digest, with Node and pnpm versions pinned (`mise.toml`,
  `packageManager`), `pnpm install --frozen-lockfile`, no timestamps or absolute paths in the output. The gateway image
  builds it from source (`pnpm --filter @usagemap/tracker build`) and embeds `tracker/dist/<semver>/`; `dist/` is
  never committed (C-100).
- Each release publishes a **manifest** listing, per file, `bytes`, `gzip_bytes`, `sha256`, `sha384` and the SRI
  `integrity` string, plus build metadata (git commit, build-container digest; C-100); the manifest is signed with Sigstore keyless signing inside the release workflow;
  the tracker files get SLSA provenance; the npm tarball gets npm provenance; all of it is attached to an **immutable
  GitHub release**.
- An **independent job** (different runner image, run on the tag and again on a schedule) rebuilds the tracker from
  source and compares digests with the manifest. A mismatch is a critical alert (monitoring plan,
  `ReproducibleBuildMismatch`).
- The bundle is ≤ 3.5 kB gzip (`standard`) and ≤ 2.5 kB gzip (`strict`), both including the challenge solver (C-32):
  small enough that the release approver reads the diff of the built file, not just the source diff. As built,
  `strict` 1.1.0 is 2,493 B of its 2,500 B (`standard` 2,854 B of 3,500 B; 1.0.0 was 2,408 B and 2,778 B), so any
  growth of the shared core must be paid for first (C-100, C-116).

### 3.3 npm package and staged publishing (ADR-0023)

- Package `@SCOPE/tracker` under an npm **organisation** with at least two owners using WebAuthn 2FA.
- **Trusted publishing only, stage-only.** The release workflow can run `npm stage publish … --tag staging`; it cannot
  make a version installable. As built (C-118): the staged dist-tag is `staging`, and `latest` is moved only by a
  maintainer (`npm dist-tag add … latest`, 2FA). **Caveat:** npm gives a package's **first** published version the
  `latest` tag automatically, so approving the very first staged version also makes it `latest`; every later approval
  lands on `staging` only. A maintainer approves the staged version on npm with a 2FA challenge after checking that the staged
  tarball's digests match the signed manifest and the reproducible rebuild.
- "Require two-factor authentication and disallow tokens" is set on the package, so a stolen token cannot publish.
  No npm write token exists anywhere.
- The GitHub `npm-release` environment requires an approver other than the person who started the release. Two humans
  therefore approve every version: one in GitHub, one on npm.
- The Wallets Kit adapter (`attachWalletsKit`, ADR-0029) wraps sign methods and is the most dangerous code we ship.
  It is released under the same controls, and its release review includes the transparency tests (same arguments,
  return values and rejections) and the outbound-request test that no address, XDR or signature is sent.

### 3.4 What a tenant should verify, and how

Tenants choose one of three delivery modes, strongest first:

| Mode | What runs on the page | What the tenant relies on |
|---|---|---|
| **npm bundle** (`@SCOPE/tracker`, exact version, lockfile) | First-party code in the tenant's own build | The npm supply chain (§3.3); their lockfile's integrity hash |
| **Self-hosted file** | A file served from the tenant's origin | Their own verification at download time |
| **Our ingest host + SRI** | A third-party script locked by hash | The SRI hash in their HTML |

Verification steps (documented in the onboarding guide; a `tools/verify-tracker` script will run all of them):

```sh
# 1. The file you are about to embed or self-host was built by our release workflow
gh attestation verify <profile>.js --repo ORG/REPO \
  --signer-workflow ORG/REPO/.github/workflows/<signing workflow>.yml

# 2. The manifest is signed by that workflow, for that tag
cosign verify-blob manifest.json --bundle manifest.json.sigstore.json \
  --certificate-identity "https://github.com/ORG/REPO/.github/workflows/<signing workflow>.yml@refs/tags/<tracker-tag>" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# 3. The served bytes equal the manifest (compare with the integrity value in your snippet)
curl -s https://<ingest host>/lib/<semver>/<profile>.js | openssl dgst -sha384 -binary | openssl base64 -A

# 4. npm mode: registry signatures and provenance
npm audit signatures
```

`<signing workflow>` is the reusable build-and-sign workflow of the release pipeline (C-118). The repository has no
release workflow yet, so there is no signed release to verify until one is set up.

pnpm users should set `trustPolicy: no-downgrade`: every release of our package carries trusted-publisher evidence,
so a version published any other way would fail installation. File names of the manifest and workflow are fixed in
`docs/contracts/wire-formats.md` and the release documentation.

### 3.5 CSP guidance for tenants

- **Ingest-host mode:** `script-src` must allow our ingest host (or use a nonce on our tag); `connect-src` must allow
  **both** ingest hosts (ADR-0004 rotates between them).
- **npm or self-hosted mode:** only `connect-src` for the two ingest hosts is needed.
- The tracker uses no DOM-XSS sinks, so it works under `require-trusted-types-for 'script'`; we test this.
- Optional, recommended for wallet dApps: `Integrity-Policy-Report-Only: blocked-destinations=(script)`, then enforce
  `Integrity-Policy` — it blocks every script without integrity metadata, ours and everyone else's (Chrome 138,
  Firefox 145, Safari 26 partial per the research; not yet Baseline).
- Research found that 2 of 40 sampled SCF-awarded sites already run a blocking CSP; the onboarding wizard generates
  the CSP additions per mode.

### 3.6 Self-hosting option

A tenant may download a released file, verify it (§3.4 steps 1–3) and serve it from its own origin. The tenant then
owns its integrity; our domain changing hands (§10) cannot affect it. Self-hosted copies still send events to our
ingest hosts and still need a valid challenge per page load (ADR-0008).

---

## 4. Build and release pipeline (ADR-0023)

- **Repository rules.** Pull requests required on `main` with review by a second maintainer and CODEOWNERS for
  `.github/`, `tracker/`, `infra/`, `vendor/umami/`; stale approvals dismissed; required checks; no force-push or
  deletion; release tags creatable only by the release team and immutable.
- **Workflows.** Top-level `permissions: {}` with per-job minimum; `persist-credentials: false`; no
  `pull_request_target` and no `workflow_run` on untrusted code; no `${{ github.event.* }}` interpolation in `run:`;
  no secrets in pull-request workflows; release workflows trigger only on protected tags and run in protected
  environments (`npm-release`, `images-release`) with required approvers and self-approval prevented. There is no
  `production` environment: build automation builds, tests, signs and publishes, and never deploys (C-79, §7).
- **Isolated reusable release workflow** (the signer identity tenants verify against, C-118) builds and signs (SLSA Build L3): GitHub-hosted runners only, no shared
  caches restored in release jobs, no artifacts consumed from untrusted jobs, `id-token: write` only in the signing
  job.
- **Action pinning.** Every `uses:` pinned by full SHA, and covered by an Actions lockfile once release workflows
  exist (GA 2026-10-28; pins transitive composite actions, closing the hole that hit reviewdog users).
 Fewer marketplace actions: we prefer `run:` steps with pinned,
  checksum-verified binaries.
- **Static analysis and scanners (target design, C-106).** zizmor and actionlint for workflows, CodeQL, secret
  scanning with push protection, the licence allow-list (ADR-0001), osv-scanner plus `pnpm audit` on the lockfile and
  Grype plus Trivy on images, run as pinned, checksum- or signature-verified binaries in jobs with no secrets. A
  scanner is relied on only after it has reported a known-vulnerable fixture in a two-document pnpm lockfile: a scanner
  that reads only the first document of pnpm's lockfile reports **no vulnerabilities at all**, silently (risk R-29,
  S-09). None of these runs automatically in this repository; maintainers check dependency and image
  findings before a release (`vulnerability-response.md`).
- **Immutable GitHub releases** for every release.

## 5. Dependency intake rules (ADR-0023, ADR-0001)

| Ecosystem | Rules |
|---|---|
| JavaScript/TypeScript (pnpm) | `minimumReleaseAge` set **explicitly** (making it strict; 3 days); exclusions only as dated, reviewed entries during an emergency (`vulnerability-response.md` §7); `strictDepBuilds: true` with an `allowBuilds` allow-list; `trustPolicy: no-downgrade`; `blockExoticSubdeps: true`; `trustLockfile` left false; `--frozen-lockfile` on install. |
| Go | Module proxy and checksum database on (`GONOSUMDB` never set); toolchain pinned in `go.mod` with `GOTOOLCHAIN=local`; `-trimpath`; `govulncheck` for Go advisories. |
| Updates | Made by maintainers, with a 3-day minimum age and digest pinning for images and actions; never merged automatically. Dependabot security alerts stay on as a signal. |
| Licences | The allow-list in §5.1, the authoritative list (ADR-0001, C-40), applied on review. |
| Tracker | **No runtime dependencies at all**, enforced by the tracker's tests (`dependencies` empty). Dev dependencies affect the build only and are covered by the reproducible-build check. |

**Checklist for a new direct dependency** (applied in review): is it needed at all; licence on the allow-list;
maintained (releases in the last 12 months, more than one maintainer preferred); publishes with provenance; no
install scripts, or an `allowBuilds` entry with a reason; size and transitive count; no network or filesystem access
it should not need; a pinned version; an owner in CODEOWNERS for the package that uses it.

Import-time payloads (2026 AsyncAPI, SubQuery) defeat install-script controls, so the minimum release age and the
trust policy matter more than `ignore-scripts`.

### 5.1 Licence allow-list (authoritative; ADR-0001, C-40)

This is the list every dependency is reviewed against. ADR-0001 and the register point here; if they ever differ, this list
is corrected together with them in the same change. Identifiers are SPDX.

| Class | Licences | Condition |
|---|---|---|
| **Allowed for any dependency** (linked, bundled or run) | `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `Apache-2.0`, `MPL-2.0`, `PostgreSQL`, `Unlicense`, `0BSD`, `Zlib`, `CC0-1.0` | `CC0-1.0` admitted for dependencies only (public-domain dedication, e.g. `github.com/zeebo/blake3` in Caddy; C-126) |
| **Allowed only for separately run, unmodified tools** | `GPL-*`, `AGPL-*`, `LGPL-*` (any version) | The tool runs as its own process or container, is not modified, and is **never linked into our code** or bundled into the tracker, a Go binary or a Node service. Each such tool is named in review with its licence and how it is run. The register's examples: Ansible, Grafana, HAProxy. |
| **Data sets (not code), with attribution in `NOTICE`** | `CC-BY-4.0` — DB-IP Lite Country (read with `github.com/oschwald/maxminddb-golang/v2`, ISC; C-106); `PDDL-1.0` — sapics `user-country` (whole-database fallback only, if DB-IP can no longer be fetched or its terms change — never mixed per lookup, S-12; C-40, C-106) and iptoasn | Used only as data; attribution recorded in `NOTICE` (design trade-off DV-03) and, for DB-IP, the CC BY 4.0 notice "IP Geolocation by DB-IP" with a link on every page that shows country results. The geo database is the only data set inside a published image (refreshed monthly). Cloud-provider, Apple Private Relay, Tor-exit and VPN range lists carry no clear redistribution licence, so they are **never put into a published image and never committed**: a small updater on each edge node fetches them weekly from the publishers' URLs through allow-listed egress, logs their checksums and keeps them in a local volume; the gateway starts with empty lists if none are present (C-38). |
| **Build-time-only packages (never in a shipped artefact)** | `BlueOak-1.0.0` | OSI-approved, permissive. Only for a package that runs at build time and whose code never reaches a user, an image or a published package — today `graceful-fs` in the static docs site's CSS toolchain (Tailwind CSS 4, `apps/docs`). Each package is named in review with what uses it (C-152). |
| **OS packages of digest-pinned distribution base images** | as reported by the image SBOM | Excluded licences (row below) fail the gate; GPL-family licences are **reported, not failing** — they are separately packaged system components of the distribution (C-118, release SBOM licence check). |
| **Application packages inside third-party upstream images we republish unmodified** (`umami`, `umami-migrate`, `postgres-ha`; release SBOM check only) | The allow-list above, **plus** OSI-approved `LGPL-2.1-or-later`, `LGPL-3.0-or-later`, `BlueOak-1.0.0`, `EPL-2.0` — each **per package and exact version**, in a reviewed correction list (§5.2) | Never for our own code, the tracker or our own images; not part of the allow-list. C-134. |
| **Hosted analysis only, never shipped or required** | GitHub's CodeQL terms (CodeQL CLI) | Used only as GitHub's hosted analysis; not part of the platform, not needed to build or run it (C-111). |
| **Excluded** | `BUSL-1.1` (BSL), the Timescale License (TSL), `SSPL-1.0`, `Elastic-2.0` (ELv2), and any "open-core" `ee/`, `tsl/` or `/proprietary` code even where the rest of the project is OSI-licensed | Never, in any role. |
| **Anything else** | Not on this list | The gate fails. Adding a licence is a register change (ADR-0001), not a one-off override. |

Our own code, IaC and documentation are `Apache-2.0` with SPDX headers; Umami is consumed unmodified under `MIT`, and
its notice travels in `NOTICE` (ADR-0001).

### 5.2 Packages inside third-party upstream images

The release pipeline (target design, see the update note at the top) builds an SBOM of every image and checks each
application package (npm, PyPI, Go …) against §5.1. Three released images republish an upstream product unmodified — Umami and its
migration image (upstream's frozen npm lockfile, C-104) and the HA database node (Patroni and its Python
dependencies as Debian/PGDG packages, C-108). Their SBOMs contain packages whose metadata is missing or not SPDX, or
whose licence is OSI-approved but not on our own-code allow-list. These are handled by a **reviewed correction list**, not by
widening §5.1:

- **Scope.** An entry names the catalogue images it applies to; only images listed in its `upstreamImages` (with
  the upstream product they republish) may be named. Our own images, the tracker and a loose SBOM never get a
  correction.
- **Exact match.** purl type + name + the exact version the SBOM reports + location substrings of Syft's
  `sourceInfo` + the SBOM's declared licence exactly as reviewed. A new version, changed metadata or a new location
  stops the match and the release fails until the entry is re-reviewed.
- **Verified licence.** `licence` is what the package's own licence file says **at that version, read from the built
  image** (Debian packages: `/usr/share/doc/<package>/copyright`; npm: the package's `LICENSE`; for copies bundled
  by Next.js without metadata, the in-image file is shown byte-identical to the upstream source at the same tag and
  that directory's `LICENSE` is recorded). Evidence, OSI status, reason and review date are required fields.
- **Which licences.** Every identifier must be on §5.1 or in the file's `osiApproved` list (checked against the SPDX
  licence list's `isOsiApproved`). Excluded licences can never appear. LGPL-2.1+/3.0+, BlueOak-1.0.0 and EPL-2.0 are
  acceptable here because the packages are **unmodified dependencies of a separately run, separately distributed
  upstream program** (Umami's Node process, Patroni's Python process): our code never imports or links them, we
  redistribute them as upstream ships them (licence texts and notices stay in the image), and the copyleft of LGPL
  and EPL-2.0 attaches only to modifications of those packages' own files, of which there are none. LGPL's
  replaceability holds: `libvips` is a separate shared object, the Python modules are plain files.
- **Self-test** of the check: a listed package passes only inside its image; the same
  package fails in any other image or with no image; an unlisted package with a disallowed licence still fails;
  version, metadata or location drift fails; the loader rejects entries for non-upstream images, non-OSI or excluded
  licences, missing evidence and our own scope.

Entries reviewed on 2026-11-14 (15): `umami` — `@img/sharp-libvips-linuxmusl-x64` and `-arm64` 1.3.4 (LGPL-3.0-or-later; arm64 read
from an arm64 build layer of the `deps` stage under BuildKit QEMU), `busboy` and
`tar` bundled by `next` 16.4.2 (MIT; BlueOak-1.0.0); `umami-migrate` — `elkjs` 0.11.1 (EPL-2.0), `@visx/vendor`
4.0.0-alpha.0 (MIT AND ISC); `postgres-ha` — `chardet` 5.2.0 (LGPL-2.1-or-later), `click` 8.1.8, `idna` 3.10,
`ydiff` 1.4.2 (BSD-3-Clause), `patroni` 4.1.5, `urllib3` 2.3.0 (MIT), `psycopg2` 2.9.10 (LGPL-3.0-or-later, with an
OpenSSL linking exception), `python-dateutil` 2.9.0 (Apache-2.0 AND BSD-3-Clause), `systemd-python` 235
(LGPL-2.1-or-later).

## 6. Container images

- **Base images** pinned by digest; Go services on a distroless static base running as non-root; Node services on a
  distroless or hardened Node base pinned by digest (choice fixed at implementation). Rebuilt when the base digest
  changes, by a maintainer's pull request.
- **Our images** (gateway, collector, writer, engine proxy, health controller, range-list updater, control plane,
  jobs, portal, Umami) are built in the release workflow,
  signed with cosign keyless, given SLSA provenance and SBOMs, and referenced by digest in Compose (ADR-0019/0023).
- **`scf-otelcol`** is built with `ocb` **v0.165.0** from the committed `builder-config.yaml` pinned to exact
  component versions (core v0.165.0 / stable v1.71.0, contrib v0.165.1); the `ocb` binary's SHA-256 and its Sigstore
  bundle (identity `…/opentelemetry-collector-releases/.github/workflows/base-binary-release.yaml@refs/tags/v0.165.0`)
  are verified before use, and the build runs with `GOWORK=off` (C-107; exact values in
  `spikes/s04-collector-build/README.md`). The alpha components `signal_to_metrics` and `health_check` stay pinned and
  are re-checked at every bump; the `failover` connector is not in the build (C-107).
- **PostgreSQL image** adds pgBackRest **2.60.0** from the PGDG apt repository (`2.60.0-1.pgdg13+1`), pinned —
  Debian's own package (2.55.1) is below the 2.59.3 floor (C-108). The WAL-G fallback's official binary contains
  GPL-3.0+ LZO code (ADR-0021).
- **Third-party images we do not rebuild** (PostgreSQL, monitoring stack) are pinned by digest; upstream signatures
  are verified where they exist. The monitoring stack (`infra/compose/compose.monitoring.yaml`, lean profile
  `infra/ansible/roles/compose_stack`): Prometheus, Alertmanager, node exporter, prometheus-community
  **postgres_exporter v0.20.1** (`quay.io/prometheuscommunity/postgres-exporter`, Apache-2.0; read-only role
  `scf_monitor` = `pg_monitor`) and VictoriaLogs (Apache-2.0), Grafana OSS (AGPL-3.0, unmodified separate container,
  §5.1 exception).
- **Deploy verification** (ADR-0019): the Ansible playbook — run from a service-operator workstation, or by a
  pull-based agent on the nodes (C-79), never from build automation, refuses any image of ours that is not
  `<release registry>/<catalogue name>@sha256:…` and any image of the merged production configuration that is
  neither a release image nor digest-pinned, runs `cosign verify` and `cosign
  verify-attestation --type spdxjson` for every image digest against the release workflow's keyless identity on the
  workstation before anything reaches the node (`infra/ansible/roles/compose_stack/tasks/verify.yml`), deploys the
  tracker only from its signed release directories (SHA256SUMS, `cosign verify-blob`, manifest equal to the one in
  the gateway image; `tasks/tracker.yml`), fails on any error, and the task output is the deploy log's record. SLSA
  provenance in GitHub's attestation store is checked with `gh attestation verify` before the playbook (runbook
  `deploy-verify.md`); the playbook does not call the GitHub API.

### 6.1 Why we rebuild Umami instead of deploying upstream's image (ADR-0003)

Read at tag v3.5.0 (`d3c62a8`) by the research:

| Upstream build property | Consequence for us |
|---|---|
| Release workflow has **no signing, no attestation and no SBOM** | Nothing to verify at deploy. |
| Actions pinned by **tag**, a third-party runner, a **shared build cache** | The exact pattern behind 2025–2026 Actions compromises (§9). |
| **Moving tags** (`latest`, major, major.minor) | A pull can change bytes silently. |
| Runner stage **rewrites `pnpm-workspace.yaml` and runs `pnpm add` without a lockfile** (including `chalk`, hijacked on 2025-09-08), with `strictDepBuilds: false` | Transitive versions are resolved at image-build time; the image is not reproducible from the lockfile. |
| Geo database downloaded from an **unpinned branch of a third-party repository** | Unpinned third-party input in the image. |
| `public/script.js` **rewritten at container start** from environment variables | Served bytes depend on runtime config; we do not serve it (we ship our own tracker). |

Our build (C-104, verified in S-02): Umami source fetched by commit SHA and checksum-verified; our own Dockerfile
with a digest-pinned base, kept in `vendor/umami/` with `copy-closure.mjs`, the SHA and the pnpm/Node pins;
`pnpm install --frozen-lockfile`; runner dependencies taken from the builder stage, not added unlocked; upstream's
`strictDepBuilds: false` override is dropped and the lockfile's own `allowBuilds` is the reviewed list (today
`@prisma/engines` and `prisma`; `strictDepBuilds: true` may also be set explicitly); `SKIP_BUILD_GEO=1` (geo is
done at our gateway, ADR-0006), so the image contains no geo database; **two images** from one Dockerfile —
`umami` (87 MB compressed against 312 MB upstream) and the one-shot `umami-migrate` — both signed, attested and
SBOM'd like our own images. Not bit-for-bit reproducible, and Prisma's schema engine is downloaded during the build
(§2.2). `public/script.js` and `recorder.js` remain in the image but are blocked at the engine proxy. The empty patch queue `vendor/umami/patches/` lets us ship a fix
within 24 h when upstream has none (ADR-0003). Contract tests run the adapter against our built container on every
change and against upstream's newest tag nightly.

## 7. Secrets (ADR-0019, ADR-0023)

- **Build automation never holds production credentials (C-79).** It builds, tests, signs and publishes only. npm publishing and
  image signing use OIDC; there are no long-lived publish credentials. No SSH key, hoster token, DNS credential,
  database credential or age key of the running service is stored in GitHub, so a compromised workflow can at most
  produce a bad artifact, which deploy-time verification and the release approvals are there to stop.
- **Deploy path (C-79).** Deployments run from a service-operator workstation (or a pull-based agent on the nodes)
  with secrets decrypted by SOPS at deploy time. Hoster API tokens and SSH deploy keys are held by the service
  operator, scoped per project and rotated on a schedule and on any maintainer change. The OpenTofu state
  credentials are not stored on any server.
- **Runtime:** SOPS + age; encrypted files in the repository; one age recipient per maintainer and per host.
- **Secret scanning and push protection** on the repository; our key formats carry a fixed prefix and checksum so
  scanners find them (ADR-0016).
- **People:** hardware-key 2FA on GitHub, npm, registrar, DNS providers and hosters; no classic or long-lived personal
  tokens on maintainer machines. The 2026 incident pattern (social engineering, RATs, stolen CLI OAuth tokens; §9)
  means a maintainer machine is part of the supply chain.
- At **handover** secrets are rotated or replaced, not just re-encrypted, because git history keeps old ciphertext
  encrypted to our keys — **except** the three key peppers (`ing`, `op`, `pub`) and the snapshot-signing key, which
  are handed over securely and rotated afterwards (rotating them at cut-over would invalidate every token; C-50, C-81;
  §10).

## 8. Domains and DNS (ADR-0017, ADR-0023)

**What runs today (v1 host) differs from the design below, which is the design for the funded service
window:** one domain, `usagemap.dev`, for every name (apex, `app`, `status`, `e1`, `e2`); **one DNS provider**
(Cloudflare, DNS-only, records in OpenTofu `infra/opentofu/envs/v1-small`); a **CAA** record `issue
"letsencrypt.org"` without an `accounturi` binding; **no certificate-transparency watch running** (the
`CTUnexpectedCertificate` alert is marked "outside" in `ops/alerts/coverage.json`: a scheduled workflow or external
CT monitor, neither of which exists); registry lock and the registrar's
2FA are not evidenced in the repository. The DNS token on the VM (for ACME DNS-01) can edit **every** DNS record of
the zone, not only `_acme-challenge` — so on v1 a compromise of the VM could also redirect the tracker hostnames (C-61's
separation applies to the multi-node design only). SRI still protects pages that pin the tracker: a redirected host
can stop the script, not change it.

- Dedicated, transferable domains `<domain-a>` and `<domain-b>`; the tracker's two ingest hosts sit on
  different domains (ADR-0004), so one registrar incident does not stop analytics. The domains are **transferred** to
  the successor service operator at handover (C-50).
- **Registry lock** where the TLD offers it; registrar account with hardware-key 2FA; renewal prepaid well beyond the
  service year.
- **CAA** records limiting issuance to our CA, bound to our ACME account (`accounturi`).
- **Certificate-transparency monitoring** with alerts on any certificate for our names not issued to our account
  (monitoring plan, `CTUnexpectedCertificate`).
- **Two DNS providers** (ADR-0017). Static records are kept in git and applied to both providers by one
  multi-provider tool (DNSControl or octoDNS, chosen at implementation); the health controller owns only the ingest
  and portal A/AAAA record sets (C-27). Record drift alerts.
- **Edge DNS credential (C-61).** Edge nodes hold a credential that can only write a delegated `_acme-challenge` zone
  for their DNS-01 certificates; they cannot change service records. A compromised edge can therefore not redirect the
  tracker host; certificates it could still request show up in CT monitoring.
- **No DNSSEC at launch (C-31).** Multi-signer DNSSEC across two DNS providers is an availability risk we do not take
  for a 99.99 % target. Registry lock, CAA and CT monitoring are in place from day one, and SRI protects tenants'
  pages from a hijacked script host. Revisited after the first six months of operation.

## 9. Incident lessons that shaped the controls

Only incidents with a primary source are cited, and each citation should be re-checked against that source before it is
quoted elsewhere. AppsFlyer (March 2026), the closest analogue to our product, is *not* cited here because only the
vendor's statement via the press was available.

| Incident (primary source per research) | What happened | Control it shaped |
|---|---|---|
| polyfill.io, 2024 (Sansec) | Domain and GitHub account bought; malicious JS served to 100k+ sites | SRI in every snippet; no aliases; domain controls; npm/self-host modes; domain-continuity at handover |
| Ledger Connect Kit, Dec 2023 (Ledger) | Phished ex-employee's npm access; dApps loaded the kit from a CDN at runtime and picked up a drainer | No runtime loading; pinned versions; staged publishing with human approval; offboarding = access removal |
| Lottie Player, Oct 2024 (LottieFiles issue) | Compromised token pushed versions that prompted wallet connection; unpinned CDN users got them automatically | No moving aliases; no tokens; SRI |
| @solana/web3.js, Dec 2024 (GHSA-jcxm-7wvp-g6p5) | Publish-access account compromised; key-stealing versions for ~5 h | Trusted publishing only; "disallow tokens"; staged approval |
| chalk/debug, Sep 2025 (Aikido) | Maintainer phished (2FA code captured); browser payload hooked `window.ethereum` and `fetch` to swap addresses | Least-power tracker contract (no wallet objects, no `fetch` patching); hardware-key 2FA; minimum release age |
| Shai-Hulud 2.0, Nov 2025 (Datadog) | Self-propagating worm via preinstall scripts; 796 packages | `strictDepBuilds` + `allowBuilds`; minimum release age; no publish tokens |
| s1ngularity / Nx, Aug 2025 (Nx GHSA) | `pull_request_target` injection stole the npm token | No `pull_request_target`; zizmor/actionlint; no secrets in PR workflows |
| tj-actions / reviewdog, Mar 2025 (advisories) | Tags moved to malicious commits; SHA-pinning the outer action did not help because a composite action pulled a mutable tag | SHA pins **plus** the transitive Actions lockfile |
| xz-utils, Mar 2024 (Freund, oss-security) | Long-con maintainer; backdoor only in release tarballs and test fixtures | Reproducible tracker build from git; build from source for Umami; no binary blobs |
| Bybit / Safe{Wallet}, Feb 2025 (FBI PSA; Safe) | Developer machine compromised; front-end JS modified; ~$1.5B | Maintainer machines in scope; signed artifacts verified at deploy; served-hash drift monitor |
| React2Shell CVE-2025-55182, Dec 2025 (react.dev) | Unauthenticated RCE in React Server Components used by Next.js | Umami never internet-reachable; payloads rebuilt by the gateway; 24 h process |
| Trivy / trivy-action, Mar 2026 (Aqua GHSA-69fq-xp46-6x23) | The security scanner and its Action tags were made malicious; CI credentials stolen | Scanners as pinned, signature-verified binaries in jobs without secrets; canaries |
| Axios, Mar 2026 (maintainer post-mortem) | Two weeks of social engineering; RAT; publish from a personal account with 2FA | No personal-account publishing; staged approval by a second person |
| TanStack, May 2026 (TanStack) | Cache poisoning via `pull_request_target`; malicious versions published **through trusted publishing** | No shared caches in release jobs; staged human approval (trusted publishing is not enough) |
| AsyncAPI, Jul 2026 (Microsoft) | Legitimate workflows published malicious versions **with valid provenance**; payload at import time | Provenance is not proof; minimum release age and trust policy; reproducible-build comparison |
| SubQuery @subql/common, Oct 2026 (StepSecurity) | Release workflow pulled an unverified tarball and published it | Release jobs verify every input by hash; no network fetches of unpinned inputs |
| LiteLLM, Oct 2026 (LiteLLM) | Stolen CLI OAuth tokens; branch protection disabled by an org owner; images **validly signed** with the old key | Keyless signing bound to workflow identity; ruleset bypass list minimal and audited; ≥ 2 org owners |

## 10. Handover implications

- **Signing identity changes.** With Sigstore keyless signing there is no key to hand over; the signer identity is
  the workflow URI in `ORG/REPO`. After repository transfer, new signatures carry the new identity, old signatures
  stay valid under the old one and remain in the transparency log. Fulcio certificates also embed the repository and
  owner numeric IDs; a transfer is expected to keep the repository ID and change the owner ID (to be verified with a
  test transfer).
- **Unverified until rehearsed (C-50).** What happens to the signing identity, provider accounts and the container
  registry on a repository transfer is unverified until the handover rehearsal and is listed as such in the handover
  plan.
- **Tenant verification across the change.** Proposed: the verification tool accepts the old identity for versions
  up to the last pre-handover release and the new identity after it, and pins the repository ID; a signed transition
  statement is published by both sides (§12 SC-03).
- **npm.** New accounts of the successor service operator are added as organisation owners; trusted publishing is
  re-pointed to the new repository and workflow; the old configuration is deleted; our members are removed after the
  successor has staged and approved one test release. Package names do not change, so tenants' lockfiles keep working.
- **Domains (C-50).** The service domains are **transferred**. A redirect is insufficient for ingest from pinned
  trackers, because cross-origin redirects of beacons and POSTs are not reliable; it is offered only as a temporary
  measure for the portal. SRI makes a hostile or careless future owner a denial of service for SRI embeds, not code
  execution, and the hash-drift monitor keeps running against the signed manifests. Non-SRI embeds remain exposed
  (threat model TM-TRK-04/08).
- **Secrets.** SOPS files are re-encrypted to the successor's recipients only; ours are revoked; hoster tokens and
  deploy keys (held by the service operator, never by build automation, C-79) are replaced; the SEP-10 signing key and its
  `stellar.toml` are on the rotation list (C-15). The three peppers `ing`, `op` and `pub` and the snapshot-signing key
  are handed over securely and **not** rotated at cut-over; because every stored key hash records its pepper version,
  they can be rotated afterwards with overlap by issuing new tokens (C-50, C-81). The key that encrypts the per-tenant
  Umami credentials (C-40, C-85) and the audit-anchor account key (C-63) are handover items.
- **Release approvers.** The two-person rule continues only if the successor service operator names two approvers;
  this is an acceptance criterion of the handover.

## 11. Threat → control → evidence

| Threat (threat model) | Control (ADR) | Evidence anyone can check |
|---|---|---|
| Our edge serves modified tracker bytes (TM-TRK-03) | Files compiled into the signed binary; SRI in snippets; immutable URLs (ADR-0004/0005) | Hash-drift monitor history; deploy verification logs; snippet e2e test |
| Domain or DNS takeover; successor service operator (TM-TRK-04) | Registry lock, CAA, CT monitoring, two DNS providers, DNS as code (ADR-0017/0023, C-27); no DNSSEC at launch (C-31); edge credential limited to `_acme-challenge` (C-61); domain transfer at handover (C-50); SRI | CAA records; CT alert configuration; credential-scope test; handover checklist |
| Malicious npm version (TM-TRK-02) | No tokens; stage-only trusted publishing; human 2FA approval; second-person GitHub approval (ADR-0023) | npm package settings screenshot; environment rules; release records with two approvers |
| Compromised repo or build ships a release (TM-TRK-01) | Reproducible build checked independently; signed manifest; L3 provenance; rulesets (ADR-0023) | Rebuild job results; `gh attestation verify`; ruleset export |
| Compromised dependency (TM-TRK-01, TM-ISO-06) | pnpm/Go intake rules; zero tracker deps (ADR-0004/0023) | `pnpm-workspace.yaml`; `go.sum` |
| Compromised Action or scanner (TM-TRK-01) | SHA pins; scanners as verified binaries without secrets (ADR-0023) | Workflow files |
| Workflow injection / pwn request (TM-TRK-01) | No `pull_request_target`; least privilege (ADR-0023) | Workflow files |
| Tampered image at deploy (TM-OPS-04) | Digest-only Compose; cosign and provenance verification before start (ADR-0019) | Deploy logs with verification output |
| Compromised workflow deploys or reaches production directly | Build automation holds no production credentials; deploys run from a service-operator workstation or a pull-based agent with SOPS-decrypted secrets (C-79) | Repository and environment secret listings (no deploy or hoster credentials); deploy logs showing where each deploy ran |
| Upstream Umami build weaknesses (TM-UMA-06) | Rebuild from pinned commit; patch queue (ADR-0003) | Dockerfile; SBOM; contract-test runs |
| Wallets Kit adapter alters signing (TM-TRK-07) | Allow-list serializer; transparency tests; same release controls (ADR-0029/0023) | Test results attached to the release |
| Harmful released tracker version (TM-TRK-09) | Withdrawal for a security defect: `410 Gone` on the file and its events, advisory published (C-37) | Withdrawal drill; advisory list |
| Secrets theft from build automation or laptops (TM-OPS-02) | OIDC; no production credentials in build automation (C-79); SOPS; push protection; hardware-key 2FA (ADR-0019/0023) | Settings audit; secret-scanning reports |
| Handover breaks the trust chain | Keyless signing; npm org transfer; rotation with the C-50 exceptions; domain transfer (ADR-0023, C-50) | Handover rehearsal log |

## 12. Open points

Resolved since the first draft: SC-02 by C-31 (no DNSSEC at launch, revisit after six months); SC-05 by C-37
(withdrawal with `410 Gone` for a security defect); SC-06 by C-61 (edge DNS credential limited to `_acme-challenge`).

| ID | Open point | What would close it |
|---|---|---|
| SC-01 | Open: egress blocking on release jobs (e.g. harden-runner in block mode, or GitHub's native egress firewall when available); incidents show exfiltration from runners and ADR-0023 does not cover it. | A register decision. |
| SC-03 | Open: a signed identity-transition statement at handover, and a verification tool that pins the repository ID and accepts both identities by version range. C-50 records that the signing identity's behaviour on transfer is unverified. | The handover rehearsal (C-50), then a register decision. |
| SC-04 | Open: count `no-cors` tracker fetches per referring origin and warn tenants whose embed lacks SRI. | Threat-model OP-06. |
| SC-07 | Open: OpenVEX statements, reviewed by a second maintainer and expiring after 90 days, to close "not reachable" findings auditably. | A register decision. |
| SC-08 | Open: the names of the two release approvers and the two npm owners (claim C6 depends on them). | The service operator naming its release approvers and npm scope. |
| SC-09 | Open: pin Prisma's `schema-engine` by our own checksum (vendor the binary, `PRISMA_SCHEMA_ENGINE_BINARY`), and add `slsa-verifier` for osv-scanner's provenance (C-104, C-106). | Changes to the Umami build and to the scanner setup. |

