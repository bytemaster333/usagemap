# `stellar-scf`: UsageMap's Stellar CLI plugin

`stellar-scf` is one Go binary. When it is on `PATH`, the Stellar CLI runs it as `stellar scf …`. The CLI's plugin
dispatch (stellar-cli v30.0.1, `cmd/soroban-cli/src/commands/plugin/default.rs`) looks up `stellar-<name>` on `PATH`
and runs it with the remaining arguments. The binary also works on its own as `stellar-scf …`.

| Command | What it does | Network |
|---|---|---|
| `check [FILE\|-]` | Runs a dry run of the **production sanitise step** on an OTLP/JSON payload (metrics or traces). The code is `collector/processor/scfsanitizeprocessor`, linked in, not a copy. It prints what UsageMap would keep (with the normalised `scf.route`), redact and drop, by reason code. It lists the attribute keys that are never stored (keys only, never values) and gives a fix hint per reason. | none |
| `route PATH\|-` | Shows what the production path rules (`packages/pathnorm`) make of one raw path, or of a route template with `--template`: the route, the rules that fired, and redaction counts by kind. The input is never echoed. | none |
| `init --site KEY [--service NAME]` | Prints the pinned tracker `<script>` (exact version, SRI hash, `crossorigin`), the npm alternative and the OpenTelemetry environment. These are the same shapes the portal's integration kit generates. The token stays a placeholder. | none, unless `--api` (one GET of `/v1/tracker/versions`) |
| `status` | Runs four checks. **Platform health** (`/public/v1/health`). **Site key at the edge** (`POST /v1/c`, the portal's web test). **Ingest token**: an offline CRC check, then an *empty* OTLP export that authenticates without storing anything. **Counted data** (`/public/v1/projects/<slug>/metrics.json`, public or with a share key). | public endpoints |
| `test` | Runs the portal's test commands. With `--site` it sends the web challenge. With `--service` it sends the portal's OTLP test point byte for byte (`src/integrations/test-commands.ts`): one cumulative request on route `/usagemap-test` from a fresh `service.instance.id=usagemap-test-…` whose stream started an hour earlier, so the metrics writer records only its arrival (`cumulative_first_point`) and never counts it. That data point is first checked offline by the real sanitise step. `--dry-run` prints the curl commands and sends nothing. | public endpoints |

```sh
stellar scf check payload.json --services anchor-api      # or: … | stellar scf check
stellar scf check -f payload.json --json --fail-on-drop   # CI gate: exit 3 when anything would be dropped
stellar scf route '/accounts/GA…/payments?cursor=1'       # → /accounts/{account}/payments
stellar scf init --site <22-char site key> --service anchor-api
USAGEMAP_INGEST_TOKEN=… stellar scf status --site <key> --slug my-project
USAGEMAP_INGEST_TOKEN=… stellar scf test --service anchor-api
```

Endpoints default to the public deployment: `--portal https://app.usagemap.dev`, and
`--ingest`/`--otlp https://e1.usagemap.dev`. Only `https` is accepted, or `http` for `localhost` (a local stack).
Redirects are never followed, so a bearer never travels to another origin.

Flags go **after** `scf`. `stellar --quiet scf check` does not reach the plugin: the CLI stops looking for a plugin
name at the first `--` argument.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | a `status`/`test` check failed |
| 2 | usage or input error |
| 3 | `check --fail-on-drop` would drop data |

## Privacy and secrets

- The plugin never reads the Stellar CLI configuration directory (its `identity/` holds secret keys), your home
  directory, or any file it was not given. `TestNeverTouchesStellarConfig` guards the source.
- Secrets never come from argv, which is visible in `ps` and in shell history. The ingest token comes from
  `$USAGEMAP_INGEST_TOKEN` or `--token-file`, and the share key from `$USAGEMAP_SHARE_KEY` or `--share-key-file`.
  They are never printed, not even in part. A mistyped key fails the offline checksum (wire-formats §k) and is never
  sent.
- `check` and `route` echo neither attribute values nor the input path: a seed or e-mail address in a route is
  reported only as a count by kind. When a route held a Stellar secret seed, the output says to rotate that account.

## Honest limits

- `status` → *counted data* reads the public metrics document. That document covers complete UTC days and is
  rebuilt hourly, so a first event today shows there tomorrow. The live first-event panel is in the portal (it needs
  a session).
- The web check proves the **site key** is live at the edge. Domain checks have no oracle by design (wire-formats
  §a.2), and page views need the tracker's proof of work, so the CLI cannot send a counted page view.
- `init` without `--api` uses a dated snapshot of the live release list (`releases/usagemap.dev.json`, 2026-11-19),
  embedded in the binary. For another deployment it refuses to guess a hash: pass `--api` or `--manifest FILE`.
- The real `stellar` binary was not run. The dispatch rule comes from reading its source at v30.0.1.
- Not built yet:
  - per-OS release binaries;
  - a listing in `stellar plugin search`, which needs a public repository with the topic `stellar-cli-plugin`.

## Build and test

```sh
eval "$(mise env -s bash)"
cd tools/stellar-scf
go test -count=1 ./...              # unit tests, the Collector golden cross-check, a build-and-exec plugin test
go build -o "$HOME/.local/bin/stellar-scf" .   # then: stellar scf version
go test -run TestReportsMatchCollectorGoldens -update ./...   # rewrite testdata/golden after a deliberate change
```

The tests share their vectors with the code they reuse:

- **Collector goldens.** Every SDK fixture of the processor (`collector/processor/scfsanitizeprocessor/testdata/sdk`)
  must yield exactly the kept series and the drop and redaction tallies of the processor's own goldens
  (`testdata/golden`). `testdata/golden/*.report.json` pin the CLI's report wording on top of that. A missing
  golden on either side fails the test; it is never skipped.
- **Path rules.** `route` runs the `packages/pathnorm` corpus (`testdata/vectors.json`).
- **Portal kit.** `test`'s data point is compared with the portal's OTLP test command
  (`services/control-plane/src/integrations/test-commands.ts` `otlpTestCurl`, rendered by the kit and the integration
  catalogue), byte for byte: the test renders it with the real function (Node) and runs it with `sh` against a fixed
  `date` and a recording `curl`. Nothing is parsed out of the TypeScript source, and a missing Node fails the test.
- **Keys.** The key checksum is checked against vectors computed with the control plane's `keys.ts`.

The module needs `./tools/stellar-scf` in `go.work`. Until it is listed there, run it with `GOWORK=off`.
