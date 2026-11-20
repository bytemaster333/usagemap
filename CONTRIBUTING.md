# Contributing

Thank you for helping. UsageMap is a public good for the Stellar ecosystem. It is free for projects to use, and
every line of it is open source under Apache-2.0. Security problems go to [`SECURITY.md`](SECURITY.md), never to a
public issue.

## Before you start

- **Read the design first.**
  - The capabilities and the tests that prove them are in [`docs/capabilities.md`](docs/capabilities.md).
  - Decisions are in the ADRs and the design-decision log ([`docs/adr/README.md`](docs/adr/README.md); later rows
    win).
  - The interfaces are `docs/data-model.md`, `docs/contracts/wire-formats.md` and `docs/api/*.openapi.yaml`. Change
    the document and the code together, never the code alone.
- **Order of work:** research → decide → design → build → verify. A change that adds or changes a capability updates
  its row in `docs/capabilities.md` in the same change. A new trade-off gets a `DV-nn` row there. A new design decision
  gets an ADR or a row in the decision log.
- **Where things live:** see the repository map in [`README.md`](README.md). Throwaway experiments that answer a
  question go under `spikes/`, each with a README that states what it proved.

## Toolchain

Pinned in [`mise.toml`](mise.toml): Node 24, Go 1.27, pnpm 12. The integration and end-to-end suites need Docker with
Compose v2.24+ and BuildKit.

```sh
mise install                 # the pinned toolchain
eval "$(mise env -s bash)"   # or let mise activate it in your shell
make install                 # toolchain + pnpm install --frozen-lockfile
```

## Checks and tests

| What | Command |
|---|---|
| Lint and static checks (go vet, Biome) | `make lint` |
| Go and TypeScript unit/integration tests | `make test` (or `make test-go`, `make test-ts`) |
| Whole stack locally | `make up`, then `make smoke` / `make e2e`; `make down` |
| One area | `make test-db`, `make test-portal`, `make test-jobs`, `make test-writer`, `make test-engine`, `make collector-it`, `make test-tracker-e2e` |
| SPDX headers | `node tools/spdx/check-headers.ts` (`--fix` inserts missing headers); self-test `node --test tools/spdx/*.test.ts` |

The quality bar is production code, written test first.
- Wherever a component talks to PostgreSQL or Umami, its integration tests run against the real database and the
  real pinned Umami.
- `go vet`, `biome check` and `tsc --noEmit` must be clean.
- TypeScript dependencies are added through the workspace with exact versions. Every new dependency must be at least
  three days old (`pnpm-workspace.yaml`) and under a licence on the allow-list.
- Some files are generated and tests check that they are current, for example the API types (generated with
  `pnpm --filter @usagemap/api-types generate`) and the portal's metric definitions. Edit the source document and
  regenerate; never hand-edit the output.

**Privacy invariants are tested, not hoped for.** Never store or log IP addresses, raw User-Agent strings, request
headers, tokens, Stellar secret seeds (`S…`), end-user wallet addresses, query strings or page titles. A change that
needs one of them is a design change (an ADR), not a patch.

**Byte-locked files.** Never edit these:
- `db/migrations/*.sql`, which are checksum-ledgered by `db/migrate.sh`. Add a new migration instead.
- `tracker/releases/**`, which are archived releases pinned by SRI hashes.

The SQL blocks in `docs/data-model.md` must stay identical to the migrations (`make test-db` checks it).

## Privacy invariants

UsageMap never stores or logs any of these, in any service, job, log line, metric label, audit row or test fixture
that leaves a test:

- IP addresses;
- raw User-Agent strings;
- request headers;
- tokens (API keys, session cookies, OAuth and ingest tokens);
- Stellar secret seeds (`S…`);
- end-user wallet addresses;
- query strings;
- page titles.

Tests enforce them, among others the Collector's sanitise processor tests
(`collector/processor/scfsanitizeprocessor`), the quickstart backends' attribute check
(`tests/quickstarts/backends/otlp-receiver.ts`) and the alert mailer's redaction tests (`ops/alert-mailer/test`). A change that would need one of them stored is a design change: it needs an ADR
first.

## Licensing

- All UsageMap code is **Apache-2.0** ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)). Contributions are accepted under
  the same licence (Apache-2.0 §5: inbound = outbound). There is **no CLA and no DCO sign-off**: the commit rules below
  forbid trailers, so `Signed-off-by` lines are not used.
- **Every source file starts with an SPDX header**:
  - `// SPDX-License-Identifier: Apache-2.0` for Go, TypeScript and JavaScript;
  - `# SPDX-License-Identifier: Apache-2.0` for shell and Dockerfiles, after a shebang or `# syntax=` line;
  - `-- SPDX-License-Identifier: Apache-2.0` for SQL.

  `tools/spdx/check-headers.ts` enforces this. Generated files and the paths listed with a reason in
  `tools/spdx/exemptions.json` are exempt. The REUSE tool itself is not used because it is GPL-licensed.
- **Dependencies** must be under a licence on the allow-list in `docs/security/supply-chain.md` §5.1; reviewers check
  it for every new dependency. Source-available licences are refused: BSL (Terraform ≥ 1.6, Nomad, Consul, Vault,
  Redpanda), SSPL, the Elastic License, and TimescaleDB TSL features.

## Commits

- **Exactly one line**, at most 72 characters, imperative mood: `add retry to webhook delivery`,
  `fix null check in session parser`, `bump next to 15.4`.
- No body, no bullet lists, **no trailers** (`Co-Authored-By`, `Signed-off-by`, …).
- One logical change per commit. Never rewrite pushed history.
- `.env*` files are secrets: never print, commit or copy them.

## Pull requests

Describe what changed and which capabilities (`docs/capabilities.md` IDs) it touches, with the proof (test path,
command output, document). Run the `make` targets above that cover the change before asking for review.
