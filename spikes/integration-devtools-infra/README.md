# integration-devtools-infra: `stellar scf` CLI plugin, edge middleware, Scaffold Stellar template overlay

**Result:** PASS (with one stated gap). All three mechanisms work locally against our real sanitise step. The gap: the
real `stellar` binary was not run, because building or running a downloaded CLI is outside the spike rules. Plugin
dispatch was checked by reading `stellar-cli` v30.0.1 source instead.

## Question

1. Can a `stellar scf check` plugin show a developer, locally and offline, exactly what UsageMap would keep, redact
   and drop from their OTLP payload? Can it do that by reusing the production sanitise code rather than a copy that
   drifts?
2. Can a dependency-free middleware for fetch-handler runtimes (Cloudflare Workers, Vercel edge, Deno, Bun) emit
   `http.server.request.duration` with route templates? Its output must pass the real sanitise step with nothing
   dropped and no leaks.
3. Can a Scaffold Stellar template overlay wire the tracker, the Wallets Kit adapter and the OTel environment
   variables without breaking a fresh `stellar scaffold init`? Can a Scaffold extension pick up the project's own
   contract ids at `post-deploy`?

## Method

Toolchain from `mise` (Go 1.27.4, Node 24.22.3). No npm or Go downloads: Go ran with `GOWORK=off GOPROXY=off` from
the module cache, and the two Node packages have no dependencies.

| Part | Directory | Re-run |
|---|---|---|
| CLI plugin | `stellar-scf/` (Go; `replace` → `collector/processor/scfsanitizeprocessor` + `packages/pathnorm`) | `cd stellar-scf && GOWORK=off go test -count=1 ./... && GOWORK=off go build -o "$BIN/stellar-scf" .` |
| Edge middleware | `edge-middleware/` (`usagemap-edge.mjs`, `example-worker.mjs`, `test/`) | `cd edge-middleware && STELLAR_SCF_BIN="$BIN/stellar-scf" node --test test/*.test.mjs` |
| Scaffold overlay | `scaffold-template/overlay/` (files only) | `git apply --check overlay/templates/react/src/main.tsx.patch` inside a clone of `stellar-scaffold/ui` |
| Scaffold extension | `scaffold-template/extension/` (`stellar-scaffold-usagemap`, Node) | `cd scaffold-template/extension && node --test test/*.test.mjs` |

Upstream read at: `stellar/stellar-cli` v30.0.1 (`cmd/soroban-cli/src/commands/plugin/{default,search,mod}.rs`),
`theahaco/scaffold-stellar` tag `stellar-scaffold-cli-v0.0.34` (`docs/site/docs/{extensions,community-templates}.md`),
and `stellar-scaffold/ui` @ `2a5c5f8` (2026-11-17): `scaffold.yml`, `app-lib/{env,wallet}.ts`,
`templates/react/{vite.config.ts,src/main.tsx}`.

## Observations

### 1. `stellar scf check` (Go, about 600 lines plus 150 lines of tests)

- `check` builds the processor with `scfsanitizeprocessor.NewFactory()`, `processortest.NewNopSettings` and a
  `consumertest` sink: the same factory the Collector uses. It passes gateway metadata for a placeholder tenant
  (`x-scf-allowed-services` from `--services`, `x-scf-received-at` = the newest timestamp in the payload unless
  `--received-at now`). The report is computed from what reaches the sink, including `scf.ingest.dropped` and the
  trace drop markers.
- The output on `testdata/sample.metrics.json`, a hand-made anchor API payload, is below. One of its points carries
  only `url.path` with a G-address, `client.address`, `user_agent.original` and `url.full` with a query token.

```
UsageMap dry run (scfsanitize, scf-path-rules/1.1.0)
signal metrics · 6 input data points · received at 2026-11-12T16:00:00Z (newest timestamp in the payload)

KEPT 3
  http.server.request.duration   anchor-api             GET     /sep24/transactions/{id}           200  count=40
  http.server.request.duration   anchor-api             GET     {unknown}                          200  count=12
  http.server.request.duration   anchor-api             POST    /auth                              200  count=9

DROPPED 3
  client_metric_ignored    anchor-api             1
  metric_not_allowed       anchor-api             1
  service_not_allowed      {not_allowed}          1

NEVER STORED (attribute keys removed; values not shown)
  client.address, host.name, process.command_args, server.address, url.full, url.path,
  user_agent.original

HINTS
  - client_metric_ignored: client-side metrics (http.client.*, rpc.client.*) are not stored yet; …
  - metric_not_allowed: only http.server.request.duration (or legacy http.server.duration) is stored; …
  - service_not_allowed: service.name is not declared for this project: register it on the project's API services page …
  - route {unknown}: the metric point has no http.route; enable your framework's instrumentation … url.path is never used for metrics.
```

- On the processor's real SDK fixtures (`node-express.traces.json`): 42 spans in, 18 SERVER spans kept with routes
  such as `/accounts/{id}` and `/assets/{code}/{issuer}`, and 24 dropped as `span_not_server`. Forty attribute keys
  are listed as never stored, among them `client.address`, `url.query` and `user_agent.original`.
- `--json` gives a machine-readable report, and `--fail-on-drop` exits 3, so the check can run in CI or in a GitHub
  Action.
- Tests: 5 pass (`go vet` clean, `gofmt` clean). They cover reasons and counts, routes, the never-stored list, the
  rule that no value of a removed attribute is echoed (`CANARY-RES-*`, IP, UA, query token, G-address, host name),
  trace normalisation, `--received-at now` turning the old sample into `too_old`, and exit codes.
- **Plugin dispatch (source, not executed).** In `default.rs:64-89`, `stellar scf check -f x.json` collects the
  arguments up to the first one that starts with `--`. It then tries `stellar-scf-check-f-x.json`,
  `stellar-scf-check-f`, `stellar-scf-check` and finally `stellar-scf`, using `which`. `stellar-scf` then runs with
  `check -f x.json`, and the environment and stdio are inherited (`Command::new(..).args(args).spawn()`). Two things
  follow:
  - A global flag placed before the plugin name (`stellar --quiet scf …`) makes the chain empty, so it does not
    dispatch.
  - `stellar plugin ls` lists every `stellar-*`/`soroban-*` binary on PATH (`default.rs:44-62`).
  - `stellar plugin search` lists GitHub repositories with the topic `stellar-cli-plugin` (`search.rs:29`). No
    registry and no approval.

### 2. Edge middleware (dependency-free ESM, about 230 lines)

- `withUsageMap(handler, opts | (env) => opts)` wraps a `{ fetch(request, env, ctx) }` handler. It records method,
  route template, status and duration. One delta histogram per window is exported as OTLP/HTTP JSON to
  `<endpoint>/v1/metrics` with `Authorization: Bearer <token>`, scheduled through `ctx.waitUntil`. On runtimes
  without `ctx`, a `waitUntil` can be passed in; on Vercel that is `waitUntil` from `@vercel/functions`.
- Routes come from templates (`/sep24/transactions/:id` → `/sep24/transactions/{id}`). Paths that match no template
  are folded segment by segment:
  - StrKey G/M → `{account}`, C → `{contract}`
  - S-seed → `{redacted}`
  - 64-hex → `{hash}`
  - digits → `{id}`
  - UUID → `{uuid}`
  - anything else that is not a plain word → `{value}`
  - more than six segments → `*`

  The Collector applies `pathnorm` again after this.
- Node 24 shim test: a Workers-style anchor API (`example-worker.mjs`, five route templates) handled seven requests
  that carried a UA, `cf-connecting-ip`, a cookie, query strings and a G-address in the path.
  - Nothing was exported before the 10 s window closed. Exactly one `waitUntil` export followed it.
  - The body had six series (`POST /auth 200`, `GET /sep24/transactions/{id} 200` ×2, `GET /accounts/{account}
    404`, `GET /boom 500` (the handler threw, and the error was re-thrown to the runtime), …).
  - None of the request's sensitive values reached the export.
- **Cross-check:** the captured export was run through `stellar-scf check --services anchor-edge --fail-on-drop`.
  All six points were kept and nothing was dropped or redacted. So what the middleware emits is exactly what the
  platform stores.
- An exporter failure (network down) is counted and swallowed, so the app never breaks.
- Tests: 4 pass.

### 3. Scaffold Stellar template overlay and extension

- The template facts that shaped the overlay (`stellar-scaffold/ui` @ `2a5c5f8`):
  - Vite `envPrefix: "PUBLIC_"` (`templates/react/vite.config.ts`).
  - `.env.example` at the template root is copied to `.env` by `init` (`community-templates.md`, "Repo shape").
  - `app-lib/wallet.ts:14` calls `StellarWalletsKit.init`, and `wallet.ts:34` captures
    `export const signTransaction = StellarWalletsKit.signTransaction` at module load. So the adapter must run first.
  - `app-lib/wallet.ts:143` and `app-lib/subscription.ts:17` each create their own `rpc.Server`, so the RPC hook
    has two instances to attach to.
- The overlay files:
  - `src/usagemap.ts` loads nothing unless `PUBLIC_USAGEMAP_SITE` is set, so a fresh `init` works offline and sends
    nothing. Otherwise it calls `init({ site, consent })` and `attachWalletsKit(StellarWalletsKit)`, and loads the
    debug module only in `DEV`.
  - `main.tsx.patch` adds `import "./usagemap"` as the first import. ES modules are evaluated in import order, so
    the wrapper is in place before `app-lib/wallet.ts` copies the method. `git apply --check` passes against
    `2a5c5f8`.
  - `usagemap.env.example`: the two `PUBLIC_` web variables plus the standard `OTEL_*` variables for a backend,
    with the token kept out of `PUBLIC_`.
  - `scaffold.yml.fragment` and `package.json.fragment` (tracker pinned exactly at `1.1.0`).
- **Extension `stellar-scaffold-usagemap` (Node):**
  - `manifest` returns `{"name":"usagemap","version":"0.0.0-spike","hooks":["post-deploy"]}`.
  - `post-deploy` reads the documented stdin. It writes `.usagemap/contracts.json` with
    `{network, contract, contract_id, wasm_hash}`, one entry per (network, contract), replaced on redeploy.
  - It skips `local` deployments by default, refuses an `out` path outside the project, and ignores non-C ids.
  - It writes no RPC URL, passphrase or paths, and never reads identities.
  - Tests: 5 pass. They drive the binary exactly as Scaffold does: `manifest`, then the hook with JSON on stdin.
- **Not done:** the overlay `usagemap.ts` was not type-checked or built inside a real Scaffold project. That needs
  installing SWK, the tracker and Vite in a scaffolded app, and the `stellar-scaffold` binary is not installed here.
  The ESM import-order argument is standard semantics, but it has not been observed in a browser.

## Answer to the question

1. **Yes.** A `stellar-scf` binary on PATH is a working `stellar scf` plugin with zero gatekeeping. Linking the
   production `scfsanitizeprocessor` gives a dry run that cannot drift from the Collector. The same code can back
   the portal's first-event panel (E4), the `npx` wizard (E7) and a GitHub Action (E9). Cost: one Go binary per
   OS/arch in the release pipeline. **Recommend building it (M).**
2. **Yes.** About 230 lines and no dependencies give Workers, Vercel edge, Deno and Bun projects the one metric we
   store, with real route templates. That is the gap in Cloudflare's own OTLP export, which sends traces only, with
   no `http.route` and no metrics. The caveats, stated:
   - On Workers, `Date.now()` advances only across I/O, so durations are I/O-inclusive wall time.
   - Isolates can be evicted between windows, which loses at most one window of counts.
   - Each export is one subrequest (Workers Free allows 50 per invocation).

   **Recommend shipping it as a package next to the tracker (S).**
3. **Yes, as files.**
   - A community template (`stellar scaffold init my-app --template <org>/<repo>#vX`) needs no approval.
   - The extension protocol is language-agnostic: the Scaffold docs show a Node extension. So owning a
     Rust binary is **not needed**; Node or our Go toolchain will do.
   - The `post-deploy` hook gives us the project's own contract ids for the "Register your Stellar contracts"
     footprint flow, with no form.

   Not yet shown: a real `init` → `build` → browser run. That is the next step if this template is pursued.
