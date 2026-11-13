# S-09 — Do dependency scanners read pnpm 12 two-document lockfiles?
**Result:** PASS — pnpm 12.19 does write a two-document lockfile, and osv-scanner 2.7.1, Trivy 0.76.2, Grype 0.121.3
and `pnpm audit` all found the canary in it; a lockfile cut to its first document makes all four report nothing,
which is exactly what the canary is there to catch.

## Question
Does pnpm 12 write the two-YAML-document lockfile the supply-chain research describes, and if so
when? Do OSV-Scanner, Trivy, Grype and `pnpm audit`,
run as pinned and verified binaries, find a known-vulnerable dependency in such a lockfile? Which scanners should CI
use, and what should the canary test be?

## Method (versions, commands, how to re-run: one command if possible)
Re-run: `spikes/s09-scanners-pnpm-lockfile/run.sh` (needs network: GitHub releases, npm registry, the Trivy DB on
`mirror.gcr.io`/GHCR, the Grype DB on `grype.anchore.io`). Binaries and vulnerability DBs go to
`$S09_WORK` (default: `/tmp/usagemap-spikes/s09`), never into the repository.

**Canary.** A throwaway pnpm workspace (`fixtures/<variant>/`, root + one package `app`) with:
- `lodash` **4.17.20** as a production dependency: **GHSA-35jh-r3h4-6jhm** / CVE-2021-23337 (command injection in
  `template`, high; fixed in 4.17.21). osv-scanner reports four advisories for this version in total:
  GHSA-29mw-wpgm-hmr9, GHSA-35jh-r3h4-6jhm, GHSA-r5fr-rjxr-66jc, GHSA-xxjr-mmjv-4gpg.
- `minimist` **1.2.5** as a devDependency: **GHSA-xvch-5gv4-984h** / CVE-2021-44906 (prototype pollution,
  critical; fixed in 1.2.6).

Both versions are years old, so `minimumReleaseAge: 4320` does not interfere. Lockfiles are produced with
`pnpm install --lockfile-only` (nothing is installed or executed).

| Fixture | Root configuration | Lockfile documents |
|---|---|---|
| `a-plain` | no package-manager pin | 1 (no `---`) |
| `b-packageManager` | `"packageManager": "pnpm@12.19.0"` | 2 |
| `c-devEngines` | `"devEngines": {"packageManager": {"name": "pnpm", "version": "12.19.0"}}` | 2 |
| `d-configDependencies` | `configDependencies: {is-number: 7.0.0}` in `pnpm-workspace.yaml`, no pin | 2 |
| `e-boot-doc-only` | negative control: `b`'s lockfile cut after its first document (what a first-document-only reader sees) | 1 |

**Tools — downloaded by `run.sh`, never GitHub marketplace actions:**

| Tool | Version (published) | Verification |
|---|---|---|
| cosign | v3.1.4 (2026-10-20, immutable release) | sha256 `424e2c97…aaf4bbfa` pinned (= GitHub asset digest = `cosign_checksums.txt`) |
| Trivy | **v0.76.2** (2026-11-05, immutable release) | sha256 `bc0fc726…54089fdbf` pinned **and** `cosign verify-blob --bundle trivy_0.76.2_Linux-64bit.tar.gz.sigstore.json --certificate-identity-regexp '^https://github\.com/aquasecurity/trivy/' --certificate-oidc-issuer https://token.actions.githubusercontent.com` → `Verified OK`; Rekor integrated time 2026-11-05T12:47:20Z |
| Grype | v0.121.3 (2026-11-09, immutable release) | sha256 `e9da18cc…1bec85` pinned; `grype_0.121.3_checksums.txt` cosign-verified (identity `^https://github\.com/anchore/grype/`) → `Verified OK`, and the tarball hash is listed in it |
| osv-scanner | v2.7.1 (2026-11-09) | sha256 `fb7dab19…efd2f6ee8` pinned (= GitHub asset digest = `osv-scanner_SHA256SUMS`). Not signature-verified here; the release ships SLSA provenance (`multiple.intoto.jsonl`) that `slsa-verifier` can check |
| pnpm | 12.19.0 (mise) | — |

**Why Trivy v0.76.2 is safe (GHSA-69fq-xp46-6x23, read via the GitHub advisory API on 2026-11-12):** the malicious
artefacts were the Trivy **v0.69.4** binary (exposure 2026-03-19 18:22 – ~21:42 UTC), Docker Hub images
**0.69.5/0.69.6** (2026-03-22/23), `trivy-action` tags < 0.35.0 and `setup-trivy` < 0.2.6. The advisory states
all malicious artefacts were removed and that releases are protected by GitHub immutable releases from v0.69.3 on.
v0.76.2 was published 2026-11-05, more than seven months after remediation, is an immutable release, and its
Sigstore bundle verifies against the `aquasecurity/trivy` GitHub Actions identity.

Commands per fixture (`$d`):
```
osv-scanner scan source --format json --lockfile $d/pnpm-lock.yaml
trivy fs --quiet --scanners vuln --include-dev-deps --format json $d      # and once without --include-dev-deps
grype dir:$d -o json -q
(cd $d && pnpm audit --json)
```

## Observations (raw facts, with excerpts of output)
**pnpm writes two documents whenever the root pins pnpm or has config dependencies.** `b`, `c` and `d` start with
`---` and contain a second `---`; `a` has none. The first ("boot") document of `b` (166 lines) is:
```yaml
---
lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.19.0
        version: 12.19.0
packages:
  '@pnpm/exe.android-arm64@12.19.0':
  …                                    # 16 pnpm / @pnpm/exe.<platform> packages
---
lockfileVersion: '9.0'
…
importers:
  .: {}
  app:
    dependencies:
      lodash: {specifier: 4.17.20, version: 4.17.20}
```
So a first-document-only reader does not see "no dependencies": it sees **only pnpm itself** (16 packages), which
looks plausible and is clean. The repository's own root `pnpm-lock.yaml` is already a two-document file (root
`package.json` has `"packageManager": "pnpm@12.19.0"`).

**Scanner results** (`results/summary.md`; `yes` = the canary's GHSA/CVE was reported for that package):

| fixture | osv-scanner | Trivy `--include-dev-deps` | Trivy (default) | Grype | `pnpm audit` |
|---|---|---|---|---|---|
| a-plain (1 doc) | lodash ✔ minimist ✔ | ✔ ✔ | ✔ **✘ (dev)** | ✔ ✔ | ✔ ✔ |
| b-packageManager (2 docs) | ✔ ✔ | ✔ ✔ | ✔ **✘ (dev)** | ✔ ✔ | ✔ ✔ |
| c-devEngines (2 docs) | ✔ ✔ | ✔ ✔ | ✔ **✘ (dev)** | ✔ ✔ | ✔ ✔ |
| d-configDependencies (2 docs) | ✔ ✔ | ✔ ✔ | ✔ **✘ (dev)** | ✔ ✔ | ✔ ✔ but stdout not pure JSON (below) |
| e-boot-doc-only (control) | ✘ ✘ | ✘ ✘ | ✘ ✘ | ✘ ✘ | error `ERR_PNPM_AUDIT_NO_LOCKFILE`, exit 1 |

Further facts:
- osv-scanner reads **both** documents: `found 18 packages` for `b`/`c` (16 boot + 2), `found 3` for `d`,
  `found 16` for the control. Trivy's package list for `b` (`--list-all-pkgs`) is only `lodash`, `minimist`: it
  ignores the boot document's pnpm packages (harmless: they are the package manager, not a dependency).
- **Trivy skips devDependencies by default** for pnpm; the minimist canary is found only with `--include-dev-deps`.
- **`pnpm audit --json` with `configDependencies`** prints `Installing config dependencies...` and
  `Installed config dependencies: is-number@7.0.0` to **stdout** before the JSON; a CI step that parses the output
  as JSON breaks. It also installs (downloads) the config dependencies into `node_modules` while auditing.
- Exit codes on `b` / on the control `e` (default flags): osv-scanner 1 / 0; Trivy 0 / 0 (1 / 0 with
  `--exit-code 1`); Grype 0 / 0 (2 / 0 with `--fail-on high`); `pnpm audit` 1 / 1 (the control fails because
  pnpm refuses the cut lockfile, i.e. it fails closed).
- Versions printed: `GitVersion: v3.1.4`, `Version: 0.76.2`, `Version: 0.121.3`, `osv-scanner version: 2.7.1`,
  `pnpm 12.19.0` (`results/versions.txt`).

## Answer to the question
- pnpm 12.19 writes the two-document lockfile when the root `package.json` pins pnpm through `packageManager` or
  `devEngines.packageManager`, or when `pnpm-workspace.yaml` has `configDependencies`. Without these it writes one
  document. Our repository therefore has, and will keep, a two-document lockfile.
- All four scanners at the versions above handle it: each reports both canaries (Trivy only with
  `--include-dev-deps`). The first-document-only failure mode is real in principle: when a tool sees only the first document, every
  scanner reports zero findings and exits 0 (except `pnpm audit`, which errors). Today's versions do not fail that
  way, but a regression in a future version would be silent without a canary.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)
- **ADR-0023 / `docs/security/supply-chain.md` "Scanners as verified binaries": confirmed**, with three precise
  additions: (1) Trivy must run with `--include-dev-deps` (and `--exit-code 1`), otherwise a dev-only canary is
  never reported; (2) Grype needs `--fail-on <severity>` to fail a job; (3) the Trivy pin must be a release after
  the GHSA-69fq-xp46-6x23 remediation, verified by cosign bundle against `^https://github\.com/aquasecurity/trivy/`
  (v0.76.2 here).
- The supply-chain doc's wording that a scanner "can silently report 'no dependencies'" should read: "a
  first-document-only reader sees only the pnpm packages of the boot document and reports no vulnerabilities".
- The supply-chain research's open item (whether scanners read both lockfile documents) is now answered for
  osv-scanner, Trivy, Grype and `pnpm audit`. Syft is covered indirectly through Grype (which catalogues with Syft);
  `dependency-review-action` and dependency bots were **not** tested (open issue).
- Recommended CI set: **osv-scanner** as the PR/lockfile gate (reads both documents, non-zero exit on findings, no
  server-side DB to download); **`pnpm audit`** as a second, independent source (GitHub advisory data via the
  registry) — but parse its JSON from the first `{` or run it where no `configDependencies` exist; **Grype + Trivy**
  stay on images (ADR-0023), Trivy also on the lockfile only with `--include-dev-deps`.

## Values the implementation must use (env vars, headers, config keys, flags, limits)
- Pins: `OSV_SCANNER_VERSION=2.7.1` sha256 `fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8`;
  `TRIVY_VERSION=0.76.2` tarball sha256 `bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf`;
  `GRYPE_VERSION=0.121.3` tarball sha256 `e9da18cc1429e786722e32161288103600efffd8e483c90761f90485bd1bec85`;
  `COSIGN_VERSION=3.1.4` sha256 `424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa`.
- cosign identities: Trivy `--certificate-identity-regexp '^https://github\.com/aquasecurity/trivy/'`, Grype
  `'^https://github\.com/anchore/grype/'`, issuer `https://token.actions.githubusercontent.com`.
- Flags: `osv-scanner scan source --lockfile pnpm-lock.yaml` (exit 1 on findings); `trivy fs --scanners vuln
  --include-dev-deps --exit-code 1`; `grype dir:. --fail-on high`; `pnpm audit --json` (tolerate a non-JSON
  preamble).
- **Canary test (permanent CI job):** a fixture directory `tests/canary/` that is a pnpm workspace whose root
  pins `"packageManager": "pnpm@<repo version>"` (so its lockfile is two-document, like the real one), with
  `lodash@4.17.20` (dependency) and `minimist@1.2.5` (devDependency), lockfile generated with `--lockfile-only` and
  committed, never installed. The job runs every gate scanner on it with the same flags as on the real lockfile and
  **fails unless** `GHSA-35jh-r3h4-6jhm` and `GHSA-xvch-5gv4-984h` are both reported. It runs in the same job,
  immediately before the real scan, so a scanner upgrade that loses the second document fails the build. The fixture
  is excluded from the repo workspace (`!tests/canary` / own `pnpm-workspace.yaml`) and from dependency bots.
  Add the boot-document-only negative control as a self-test of the job's assertion logic.

## Open issues
- `actions/dependency-review-action` (GitHub dependency graph) and dependency-bot vulnerability alerts were not
  tested; both need the same canary before being relied on.
- osv-scanner was only checksum-verified; add `slsa-verifier` against its `multiple.intoto.jsonl` provenance.
- The canary ages: if lodash 4.17.20 / minimist 1.2.5 advisories were ever withdrawn the canary would need
  replacing; assert on the advisory IDs, not on counts.
- `pnpm audit` uses the registry's audit endpoint (network, npm's data), so it cannot run in an egress-blocked job.
