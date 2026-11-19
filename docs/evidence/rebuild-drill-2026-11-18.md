# Clean-clone rebuild drill, local — 2026-11-18

Capabilities: docs.deployment-guide (local part), ops.rebuild-from-repo / repo.monorepo-complete / repo.single-monorepo (local part) · script
[`tests/rebuild/run.sh`](../../tests/rebuild/run.sh).

**Result: `REBUILD-DRILL PASS commit=pre-release guide_defects=3 unrecovered=0`** (run 4). The platform was rebuilt
from a fresh clone of `main` on an empty host and passed the guide's smoke test (**157 passed, 0 failed**), but
`docs/guides/self-hosting.md` **cannot be followed verbatim**: three of its commands fail on a clean host, and each
needed a remedy the guide does not give. The guide is therefore **not yet verified**; the corrected text is below.

## Environment

- **Host:** a fresh `debian:13` (13.7) container, privileged, with its **own** Docker daemon whose image store and build
  cache live on a new, empty volume — nothing from this machine's Docker cache was visible (`docker info`: images 0).
  Host packages from Debian (the guide's §2 "Docker, Compose v2.24+ and BuildKit"): `docker.io` 26.1.5,
  `docker-compose` 2.26.1, `docker-buildx` 0.13.1, plus `git curl jq openssl`.
- **Repository:** `git clone --branch main` of this repository at `pre-release` (the committed tree only).
- **Procedure:** the harness extracts the shell blocks of §3 (first start), §4 (check it) and §6 (stop, reset) from the
  guide **at the cloned commit** and runs them line by line, timed. The only substitution is the placeholder
  `<repository>`. A failing line is recorded as a guide defect; the harness then applies one remedy and retries.

## Steps (run 4, 17:10:50–17:20:07 UTC, 9 min 17 s wall clock)

| § | Command (as in the guide) | Exit | s | Verdict |
|---|---|---|---|---|
| host | `apt-get install docker.io docker-cli docker-compose docker-buildx git curl jq openssl`; `dockerd` | 0 | 21 | ok |
| 3 | `git clone <repository> && cd <repository>` | 0 | 0 | ok (placeholder: see D5) |
| 3 | `infra/compose/scripts/init.sh` | 1 | 0 | **defect D1**: `node is required (mise install)` |
| | remedy: install mise, `mise install`, `pnpm install --frozen-lockfile` | 0 | 14 | applied |
| | retry `infra/compose/scripts/init.sh` | 0 | 7 | ok (secrets, PKI, tracker build) |
| 3 | `docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up -d --build --wait` | 17 | 11 | **defect D2**: `failed to solve: requested experimental feature source.git.checksum is not supported by build server, please update docker` |
| | remedy: Docker Engine 29.9.3 + Compose plugin (v5.8.0) from Docker's apt repository — the version `infra/ansible/roles/docker_engine` pins | 0 | 40 | applied |
| | retry `up -d --build --wait` (every image built from source, empty cache) | 0 | **221** | ok |
| 4 | `curl -fsS http://127.0.0.1:8080/healthz` | 0 | 0 | ok |
| 4 | `infra/compose/scripts/smoke.sh` | 1 | 29 | **defect D3**: the smoke stack's control plane, portal and gateway stay `Created` — §3's stack still holds 127.0.0.1:8080, 5173, 8443 |
| | remedy: `SCF_CONTROL_PLANE_PORT=18080 SCF_PORTAL_PORT=15173 SCF_INGEST_PORT=18443` | 0 | 0 | applied |
| | retry `infra/compose/scripts/smoke.sh` | 0 | 209 | ok — **157 passed, 0 failed** |
| 6 | `docker compose … down` | 0 | 3 | ok |
| 6 | `docker compose … down -v` | 0 | 0 | ok |

Disk on the fresh host after the run: images 1.26 GB, build cache 11.9 GB.

Earlier runs of the day (same commit): run 1 stopped at D2 on Debian's Docker and, through a harness bug, was reported
as PASS (fixed: a defect without a remedy now fails the run); run 2 failed on a harness defect (nested Docker on
cgroup v2 needs the controllers delegated, as `docker:dind` does — not a guide defect); run 3 found D3.

## Guide defects and the corrected text (`docs/guides/self-hosting.md`)

| # | Where | Defect | Exact replacement |
|---|---|---|---|
| D1 | §2, §3 | §3 needs Node (dev-secrets) and pnpm with the workspace dependencies (`init.sh` builds the git-ignored `tracker/dist` on every fresh clone); §2 lists mise only "for building and testing from source" | §2: replace the mise bullet with "- **The pinned toolchain, also for a first start:** [mise](https://mise.jdx.dev) installs Node, Go and pnpm from `mise.toml`; `init.sh` needs Node and builds the tracker with pnpm." §3 block, insert after the clone line: `mise install && eval "$(mise env -s bash)" && pnpm install --frozen-lockfile   # once: toolchain + workspace dependencies (or: make install)` |
| D2 | §2 | "Docker, Compose v2.24+ and BuildKit" is not enough: Debian 13's own Docker (26.1.5, buildx 0.13.1) cannot build the Umami image (`ADD --checksum` on a git source) | §2 first bullet: "- Linux host with **Docker Engine from Docker's own repository** (tested: 29.9.3 with the Compose plugin v5.8.0, the version `infra/ansible/roles/docker_engine` pins). Distribution packages can be too old: Debian 13's `docker.io` 26.1 fails the Umami build with \"source.git.checksum is not supported by build server\". Also `openssl`, `curl`, `jq`." |
| D3 | §4 | the smoke test publishes the same default ports as the §3 stack, so it fails while that stack runs | §4 block: `infra/compose/scripts/smoke.sh     # its own stack; with the §3 stack still up, give it other ports:` and a second line `SCF_CONTROL_PLANE_PORT=18080 SCF_PORTAL_PORT=15173 SCF_INGEST_PORT=18443 infra/compose/scripts/smoke.sh` |
| D4 | §4 | "runs 75 checks … Result on 2026-11-12: 75 passed, 0 failed" is stale | "runs about 160 checks … Result on 2026-11-18 (clean-clone rebuild drill, `docs/evidence/rebuild-drill-2026-11-18.md`): 157 passed, 0 failed." |
| D5 | §3 | `git clone <repository> && cd <repository>`: a URL cannot be `cd`'d into | `git clone <repository URL> && cd <repository directory>` |
| D6 | §2 | "Node 24.19.0" — `mise.toml` pins Node 24.22.2 | "(Node 24.22.2, Go 1.27.4, pnpm 12.19.0)" — or drop the versions and point at `mise.toml` |
| D7 | §2, §3 | first-build cost not stated | §2 add "- Disk for the first build: about 15 GB free (images 1.3 GB, BuildKit cache 12 GB on the drill host)." §3 replace the timing sentence with "On an empty host the first `up --build --wait` took 221 s (rebuild drill 2026-11-18); with built images `up --wait` takes about 30–40 s." |
| D8 | header | "on branch `build/e2e` on 2026-11-13" — the branch is `main` | "on branch `main`; followed in a clean-clone rebuild drill on 2026-11-18 (`docs/evidence/rebuild-drill-2026-11-18.md`), corrections D1–D8 applied." |

With D1–D3 applied, the guide's own commands rebuilt the platform from the repository alone. The drill should be
re-run after the guide is corrected (expect `guide_defects=0`); only then can docs.deployment-guide's local part be marked verified.

## Limits

- §10 (the production single host through `infra/ansible/playbooks/lean.yml`) and `docs/guides/deploy-azure.md` were
  not followed: the lean playbook is exercised in containers by `infra/ansible/tests/lean/run.sh`, and the Azure path was run later as the live rebuild drill (`live-rebuild-drill-2026-11-18.md`).
  The timed rebuild "provision → configure → restore" of ops.rebuild-from-repo / infra.iac-complete is therefore still open.
- §7–§8 (HA overlay, multi-node) were not part of this run; the HA overlay ran from a clean clone in the handover
  drill the same day (`docs/evidence/handover-drill-2026-11-18.md`).
- The host had outbound internet (Debian, Docker, mise and npm registries, GitHub for the Umami source), as §2 says.

## Reproduce

```sh
tests/rebuild/run.sh            # BRANCH=main; OUT=<dir> keeps steps.tsv and one log per step; KEEP=1 keeps the host
```
