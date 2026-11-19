---
name: usagemap-instrument
description: Instruments a Stellar project (website, dApp or API) with UsageMap privacy-first analytics end to end — the SRI-pinned browser tracker, the Stellar Wallets Kit and wallet adapters, OpenTelemetry metrics for APIs, contract (footprint) registration, then a test request and a check that the data arrived. Use when a user asks to add UsageMap, usage analytics, usage metrics or "verified usage" numbers to a Stellar web app, dApp, Soroban project or HTTP API.
license: Apache-2.0
compatibility: Needs a shell with curl and openssl, and a human who can sign in to https://app.usagemap.dev with a Stellar wallet to create the project and hand over its site key and ingest token.
metadata:
  version: "1.1.0"
  homepage: "https://docs.usagemap.dev/ai-agents/"
  updated: "2026-11-19"
---

# Instrument a Stellar project with UsageMap

UsageMap (https://usagemap.dev) measures web and API usage of Stellar ecosystem projects without cookies, IP
addresses or visitor profiles, and shows **verified** (passed bot checks) next to **raw** figures. You, the agent,
do the code changes; the human does the steps that need their wallet. Work through the steps in order and stop at
each **Ask the human** line until you have the value.

Deployment values (usagemap.dev; the portal's **Snippet** and **Ingest tokens** pages show the exact ones):

| Value | usagemap.dev |
|---|---|
| Portal | `https://app.usagemap.dev` |
| Web ingest hosts (the tracker uses both) | `https://e1.usagemap.dev`, `https://e2.usagemap.dev` |
| OTLP endpoint for API metrics | `https://e1.usagemap.dev` (the SDK appends `/v1/metrics`) |
| Current tracker version | `1.2.0`; previous `1.1.0` (check `https://e1.usagemap.dev/lib/manifest.json`) |
| Site key | 22 letters and digits, public (portal: site → **Snippet**) |
| Ingest token | `scfa_ing_…`, **secret**, shown once (portal: **Ingest tokens**) |

## Hard rules

- **Never** put the ingest token in browser code, a public repository, a log line or a commit. It goes into the
  deployment's secret store or an untracked `.env` file that `.gitignore` already covers. The site key is public.
- **Never** send end-user data in custom events: no wallet addresses (`G…`, `C…`, `M…`), transaction hashes, e-mail
  addresses, amounts, query strings or tokens. The tracker refuses values that look like these; do not work around it.
- **Never** load the tracker from a URL without its `integrity` hash, and never use a "latest" URL (there is none).
- Do not edit the tracker file. A changed byte means the browser refuses to run it (analytics stops, the page works).
- If a step below does not apply to the project (no website, no API, no contracts), say so and skip it.

## Step 0 — what the project has

Inspect the repository and write down: web framework (plain HTML, Next.js, React/Vite, Scaffold Stellar, Nuxt,
SvelteKit, Astro, a site generator), whether it uses `@creit.tech/stellar-wallets-kit` or calls a wallet API
directly (`@stellar/freighter-api`, Albedo, xBull, LOBSTR, Hana, HOT), whether it submits transactions itself
(`@stellar/stellar-sdk` `rpc.Server` or `Horizon.Server`), its HTTP API servers and their language, and the Soroban
contracts it deploys.

**Ask the human** to sign in at `https://app.usagemap.dev` (Stellar wallet), create the project, then:
1. **Add a website** with the production domain and add `localhost` under the site's **Dev origins**;
2. **Add an API** with a service name for each API server;
3. copy the site key from site → **Snippet**, and create an ingest token under **Ingest tokens**.

## Step 1 — the browser tracker (websites and dApps)

Put this tag in the `<head>` of every page (for a framework, in its root layout or `index.html`; the framework
guides at https://docs.usagemap.dev/web/frameworks/ show the exact file):

```html
<script
  src="https://e1.usagemap.dev/lib/1.2.0/standard.js"
  integrity="sha384-LQ6Yh0GTmU5/SqFMPOIB8GnEv0brlfwn9tNxj8RHKmJtQLsApBuHoZnJ2M+/CyId"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  defer
></script>
```

- Prefer the snippet the portal shows (it carries the project's key and profile). Use `strict.js` instead of
  `standard.js` when the human chose the `strict` profile (page path only).
- **Check the hash yourself** before committing; the value must equal the `integrity` attribute after `sha384-`:

  ```sh
  curl -s https://e1.usagemap.dev/lib/1.2.0/standard.js | openssl dgst -sha384 -binary | openssl base64 -A; echo
  curl -s https://e1.usagemap.dev/lib/manifest.json   # every served version with its size and hashes
  ```

- If the site sends a Content-Security-Policy, add `script-src https://e1.usagemap.dev` and
  `connect-src https://e1.usagemap.dev https://e2.usagemap.dev`.
- Single-page apps: the tracker counts client-side navigations itself; do not add manual page-view calls.
- Custom events (optional): `window.scf && window.scf.track("signup", { plan: "free" })` — name 1–50 characters
  `[A-Za-z0-9][A-Za-z0-9_.:-]*`, at most 10 properties with lower-case keys, short scalar values.

## Step 2 — wallet events (dApps)

Wallet moments (connect, sign requested/approved/rejected, transaction submitted) are counted with closed names and
enum values only; addresses, hashes and XDR never leave the browser. The adapters are in the npm package
`@usagemap/tracker` (tracker 1.1.0+; 1.2.0 for the additions below). **Availability:** the package is published
to the npm registry together with UsageMap's public repository, which has not happened yet (2026-11-19). Never write
`npm install @usagemap/tracker` as if it were on npm. Until then:

- the human can install the package file from the release (`npm install ./scf-analytics-tracker-1.2.0.tgz`);

- with the script tag and the `standard` profile, the Wallets Kit's modal opening, closing and the wallet picked
  are already recorded from the kit's page elements, without wallet access;
- tell the human that full wallet events need the package, and leave the code below ready but commented if the
  package cannot be installed.

Stellar Wallets Kit (2.x static API):

```ts
import { init } from "@usagemap/tracker";
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";

init({ site: "YOUR_22_CHAR_SITE_KEY" });
attachWalletsKit(StellarWalletsKit); // returns detach()
```

Wallets called directly: wrap once and use the wrapped object (`wrapFreighter`, `wrapAlbedo`, `wrapXBull`,
`wrapLobstr`, `wrapHana`, `wrapHot`, `wrapInjected` from `@usagemap/tracker/wallets`). Own submissions:
`attachRpcServer(server)` or `attachHorizonServer(server)` from the same subpath. Passkey wallets:
`attachPasskeyKit` / `attachSmartAccountKit` from `@usagemap/tracker/passkey`. With the npm package, use
`init()` **instead of** the script tag, not both.

Tracker 1.2.0 additions:

- **Failed connects:** every adapter reports `wallet_connect_failed` with a closed reason; pass `networkPassphrase`
  to the adapter so it can detect `network_mismatch`. The WalletConnect funnel comes with the Wallets Kit adapter.
- **Wallets Kit modules called outside the kit:** pass `wrapWalletsKitModules(defaultModules())` as the `modules`
  option of `StellarWalletsKit.init`.
- **Privy embedded Stellar wallets:** `wrapPrivyStellar(useCreateWallet(), { networkPassphrase })`,
  `wrapPrivyStellar(useSignRawHash(), { networkPassphrase })`, `wrapPrivyStellar(usePrivy())` and
  `useLogin(privyLoginCallbacks({ … }))` from `@usagemap/tracker/privy`.
- **Browser RPC health (aggregate only):** `attachRpcTelemetry(server, { network })` or `attachHorizonTelemetry(server)`
  from `@usagemap/tracker/stellar-rpc`.

Details: https://docs.usagemap.dev/wallets/

## Step 3 — API metrics (OpenTelemetry)

UsageMap reads the standard HTTP server duration metric (`http.server.request.duration`) per route. Configure the
service's OpenTelemetry SDK with environment variables only; most stacks need no code change:

```sh
OTEL_SERVICE_NAME=<the service name added in the portal>
OTEL_EXPORTER_OTLP_ENDPOINT=https://e1.usagemap.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${SCF_OTLP_TOKEN}"   # the ingest token, from the secret store
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORTER=none
OTEL_RESOURCE_ATTRIBUTES="service.instance.id=${HOSTNAME}"
```

- The space after `Bearer` is written `%20` (the header value is percent-encoded).
- Traces and logs stay off: spans would count the service twice, and logs are not accepted.
- Per language (packages, exact versions, start command): Node.js/Express, Next.js, Python FastAPI, Go `net/http`,
  Rust axum — https://docs.usagemap.dev/api/
- If the service already exports to an APM, add UsageMap as a second exporter through a Collector instead of
  replacing it: https://docs.usagemap.dev/api/existing-apm/
- **Edge and fetch-handler runtimes** (Cloudflare Workers, Vercel Edge, Next.js route handlers, Deno, Bun): the
  package `@usagemap/edge-otel` wraps the handler and exports the same metric as OTLP/JSON without an
  OpenTelemetry SDK, e.g. for a Worker
  `export default withUsageMap({ fetch(req, env, ctx) { … } }, (env) => optionsFromEnv(env))`, configured with
  `USAGEMAP_ENDPOINT`, `USAGEMAP_TOKEN` (a Worker secret) and `USAGEMAP_SERVICE_NAME` (or the `OTEL_*` names above).
  The export never delays the response, and the wrapper turns into a pass-through when it is misconfigured.
- **Stellar RPC and Horizon calls a server makes** (`@stellar/stellar-sdk` 17): `@usagemap/stellar-otel` adds
  latency per RPC method or Horizon route and submit/poll/simulate outcome classes, through the app's own
  OpenTelemetry MeterProvider:
  `instrumentStellarRpc(new rpc.Server(RPC_URL), { network: "testnet" })` or `instrumentHorizon(server)`. It never
  records an address, hash, XDR or key.
- **Python servers using py-stellar-base:** `stellar-otel-py` passes an instrumented client to each server:
  `SorobanServer(RPC_URL, client=StellarRpcClient(network="testnet"))`,
  `Server(HORIZON_URL, client=HorizonClient(network="testnet"))`.
- **Paid APIs (x402, MPP):** `instrumentX402Http(httpServer)` or `instrumentMppx(mppx)` from
  `@usagemap/payments-otel`. **Calls to SCF Integration List partners:** `partnerFetch()` from
  `@usagemap/partner-otel`. **Wallets that use anchors (Wallet SDK):** `instrumentWalletSdk(wallet)` from
  `@usagemap/anchor-otel`. **Anchor Platform 5.x:** the OpenTelemetry Java agent (configuration only) and the
  `ap-listener` Kafka listener. Details: https://docs.usagemap.dev/api/payments-and-anchors/
- **Availability (2026-11-19):** these packages are in UsageMap's repository and are published to the npm registry
  (and PyPI) together with it, which has not happened yet. Never write `npm install @usagemap/…` as if they were
  on npm: the human installs them from the release. If that is not possible, use the environment variables above on
  servers; on an edge runtime, tell the human the package is needed and leave the wrapper ready but commented.
  Edge runtimes: https://docs.usagemap.dev/api/edge/

**Mobile apps** (React Native, Expo, Flutter): named app events to `/v1/app-events` with the site key, through a
helper file copied from the example app; they are labelled self-attested. A Telegram Mini App uses the web tracker.
Details: https://docs.usagemap.dev/mobile/

## Step 4 — register the footprint (contracts)

The footprint is the list of Stellar contracts the project deployed; UsageMap counts their public on-chain
invocations next to the web and API numbers. It is a human step because it needs the project's wallet.

**Ask the human** to:
1. prove the deployer or admin account (portal: **Verification** → **Stellar account**: sign a challenge);
2. add each contract (portal: **Footprint** → **Add contract**: the `C…` ID, mainnet or testnet), or tick
   "This project has no on-chain footprint".

Help them by listing the contract IDs you found (deployment scripts, `.stellar/`, `environments.toml`, README). For
contracts deployed by a script, the human can create a **footprint registration key** (`scfa_reg_…`, portal:
**Footprint**) that only adds contracts as `claimed`: https://docs.usagemap.dev/tools/
Declare only contracts the project controls, never a user's address. A contract becomes `verified` when the ledger
shows its deployer or admin is a proven account. Details: https://docs.usagemap.dev/onchain/

## Step 5 — test, and check that it arrived

**Web.** A pure `curl` cannot produce a counted page view: the tracker must fetch a challenge and solve a proof of
work in a real browser. So:
1. run the site locally on `http://localhost:<port>` (declared as a dev origin in Step 0) and open a page in a
   browser without Global Privacy Control (Brave turns GPC on, and the tracker then sends nothing, by design);
2. ask the human to open site → **Installation** in the portal: the **first-event panel** lists the page views from
   `localhost` as `dev` with the verdict they would have had, about a minute later. Dev events are never counted;
3. if nothing arrives, load the tracker's debug module (`@usagemap/tracker/debug`, development only): it
   names the reason in the console (GPC, Do Not Track, opt-out, blocked request, undeclared origin).
   Troubleshooting: https://docs.usagemap.dev/troubleshooting/

After deploying, the human verifies the domain (site → **Domains**: DNS TXT, a `/.well-known/` file or a meta tag);
until then production page views count as `suspect` (`domain_unverified`), not `verified`.

**API.** Send one OTLP/JSON data point with the ingest token (it never leaves your shell):

```sh
NOW=$(date +%s); START=$((NOW - 10))     # a 10-second interval ending now
curl -s -w ' %{http_code}\n' https://e1.usagemap.dev/v1/metrics \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $SCF_OTLP_TOKEN" \
  --data '{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"YOUR_SERVICE"}}]},
  "scopeMetrics":[{"scope":{"name":"usagemap-skill-test"},"metrics":[{"name":"http.server.request.duration","unit":"s",
  "histogram":{"aggregationTemporality":1,"dataPoints":[{"startTimeUnixNano":"'"$START"'000000000",
  "timeUnixNano":"'"$NOW"'000000000","count":"1","sum":0.05,"bucketCounts":["1","0"],"explicitBounds":[0.1],
  "attributes":[{"key":"http.route","value":{"stringValue":"/skill-test"}},
  {"key":"http.request.method","value":{"stringValue":"GET"}},
  {"key":"http.response.status_code","value":{"intValue":"200"}}]}]}}]}]}]}'
```

Expect `{"partialSuccess":{}} 200`. `401` (`missing or invalid SCF ingest token`) means a wrong or revoked token.
Use the service name added in the portal: an unknown name is registered automatically only while the project is under
its service quota. The test point is real data: it counts as one request on the route `/skill-test`. Then ask the human to open the service's page (or the API wizard) in the
portal: within a minute it shows the `/skill-test` route, and its data-quality table lists anything that was
received but dropped, with the reason. Then start the real service with the Step 3 environment and send a few real
requests; the real routes (`/accounts/{id}`) appear after one export interval (60 s).

## Step 6 — hand over

Tell the human, in this order: what you changed (files), the tracker version and hash you pinned, which steps
they still have to do in the portal (domain verification, footprint, sharing with SCF), and where the numbers are:
the portal dashboards, and the public link for SCF (https://docs.usagemap.dev/sharing/).

## More

- Every integration with its example app and test command: https://docs.usagemap.dev/integrations/ (the portal's
  **Integrations** page generates the same configuration for the project, with a live check)

- Docs index for language models: https://docs.usagemap.dev/llms.txt (all docs in one file: https://docs.usagemap.dev/llms-full.txt)
- What is counted and how: https://docs.usagemap.dev/dashboard/ and https://app.usagemap.dev/docs/methodology/1.0.0
- What is never collected: https://docs.usagemap.dev/privacy/
