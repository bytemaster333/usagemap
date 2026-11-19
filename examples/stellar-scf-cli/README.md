# Stellar CLI plugin (`stellar scf`)

`stellar-scf` is one Go binary; on `PATH` the Stellar CLI runs it as `stellar scf …`. It answers "why is nothing
arriving?" offline: `check` runs the **production sanitise step** on an OTLP/JSON export of your service and prints
what UsageMap would keep, redact and drop; `route` shows what the path rules make of a raw path; `test` sends the
portal's test data point. This folder has two sample exports and a CI gate script. Guide:
[Troubleshooting](../../docs/onboarding/troubleshooting.md) and the plugin's
[README](../../tools/stellar-scf/README.md).

## Run it

1. **Install:** from the repository root, `(cd tools/stellar-scf && GOWORK=off go build -o "$HOME/.local/bin/stellar-scf" .)`
   (Go 1.27; until release binaries exist).
2. **Set your key:** nothing for `check` and `route` (offline). For `test` and `status`: `export
   USAGEMAP_INGEST_TOKEN=scfa_ing_…` (portal: **Ingest tokens**; read from the environment, never from argv).
3. **Run:** `cd examples/stellar-scf-cli && ./check.sh` → `KEPT 2`, `DROPPED 0`, and the attribute keys that are never
   stored; `./check.sh payload-with-drops.json` exits `3` and explains the drop.

## The lines that add UsageMap

`check.sh`:

```sh
scf="${STELLAR_SCF:-stellar-scf}" # the same binary is `stellar scf` when the Stellar CLI is installed
"$scf" check -f "${1:-payload.json}" --services my-api --fail-on-drop
```

More commands (flags go after `scf`):

`commands.sh`:

```sh
stellar scf route '/accounts/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H/payments?cursor=1'
# → /accounts/{account}/payments   (the input is never echoed back)
stellar scf init --site YOUR_22_CHAR_SITE_KEY --service my-api   # pinned <script> + OpenTelemetry variables
stellar scf test --service my-api --dry-run                      # the portal's test curl, nothing sent
USAGEMAP_INGEST_TOKEN=scfa_ing_… stellar scf test --service my-api  # sends it
```

`payload.json` is a typical export: route templates, plus `url.path` with an account address, `url.query`,
`client.address` and `user_agent.original`, which are removed (keys listed, values never shown).
`payload-with-drops.json` adds a point without `http.route` (stored as `{unknown}`) and a metric UsageMap does not store
(`metric_not_allowed`).

## What you'll see in the portal

Nothing from `check` and `route`: they run locally and send nothing. `test --service my-api` sends one marked data
point, the same one the portal's test command sends (scope `usagemap-test`, route `/usagemap-test`, a fresh
`service.instance.id`); it appears in the API service's data-quality table and the Integrations page's live check,
and is never counted in any figure.

## Test it without the app

```sh
stellar scf test --service my-api --dry-run   # prints the curl; the token is a placeholder
```

## Tested by

`tests/quickstarts/integrations/tools.spec.ts` (`stellar-scf-cli`): builds `tools/stellar-scf` with the pinned Go
toolchain, runs `check.sh` on both payloads (exit `0` with every point kept and the never-stored keys listed; exit `3`
with `metric_not_allowed`), checks that no attribute value (the address, the query, the client address, the user
agent) is echoed, runs `route` on the address path, `test --dry-run`, and `test --service my-api` against a local OTLP
stand-in (one data point with route `/usagemap-test`, bearer token). **Not run:** the real `stellar` binary's plugin
dispatch (the plugin's own tests cover it by reading the CLI's source; no `stellar` CLI in CI).
