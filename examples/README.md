# Examples: one minimal app per UsageMap integration

Each folder is the smallest runnable app that shows exactly how one UsageMap integration is added. Every folder has
a README with the same parts: **three steps** (install, set your key, run), **the lines that add UsageMap** (copied
verbatim from the code; `tests/quickstarts/examples.test.ts` fails if they drift), what you will see in the portal,
the test command that works without the app, and the test in this repository that runs it.

They are test targets and copy-paste material, **never shipped**: no image, package or release contains anything
from this directory.

Commands below run from the repository root. Examples marked *(repo)* use a package from this repository, because
the `@usagemap` packages are not on npm yet: build it first with
`pnpm install && pnpm --filter <package> build` (the README of each example has the exact line).

<!-- The table is the index the docs site copies. One row per folder; tests/quickstarts/examples.test.ts checks that
every folder has a row, every row a folder, and that the guide link is the one the folder's README names first. -->

## Websites

| Example | Integration | Run | Guide |
|---|---|---|---|
| [`html`](html/) | Script tag with SRI, plain HTML | `cd examples/html && python3 -m http.server 5173` | [Plain HTML](../docs/onboarding/web-html.md) |
| [`eleventy`](eleventy/) | Script tag, Eleventy layout | `pnpm -C examples/eleventy dev` | [Static site generators](../docs/onboarding/web-static-site-generators.md) |
| [`astro`](astro/) | Script tag, Astro with view transitions | `pnpm -C examples/astro dev` | [Astro](../docs/onboarding/web-astro.md) |
| [`vitepress`](vitepress/) | Script tag via VitePress `head` | `pnpm -C examples/vitepress dev` | [Documentation sites](../docs/onboarding/web-docs-sites.md) |
| [`docusaurus`](docusaurus/) | Script tag via Docusaurus `scripts` | `pnpm -C examples/docusaurus dev` | [Documentation sites](../docs/onboarding/web-docs-sites.md#docusaurus) |
| [`vite-react`](vite-react/) | npm tracker, React SPA *(repo)* | `pnpm -C examples/vite-react dev` | [React SPA](../docs/onboarding/web-react-spa.md) |
| [`nextjs`](nextjs/) | npm tracker, Next.js App Router *(repo)* | `pnpm -C examples/nextjs dev` | [Next.js](../docs/onboarding/web-nextjs.md) |
| [`nuxt`](nuxt/) | npm tracker, Nuxt client plugin *(repo)* | `pnpm -C examples/nuxt dev` | [Nuxt](../docs/onboarding/web-nuxt.md) |
| [`sveltekit`](sveltekit/) | npm tracker, SvelteKit *(repo)* | `pnpm -C examples/sveltekit dev` | [SvelteKit](../docs/onboarding/web-sveltekit.md) |
| [`react-router`](react-router/) | npm tracker, React Router framework mode / Remix *(repo)* | `pnpm -C examples/react-router dev` | [React Router / Remix](../docs/onboarding/web-react-router.md) |
| [`telegram-mini-app`](telegram-mini-app/) | Tracker in a Telegram Mini App (+ optional app-event counts) *(repo)* | `pnpm -C examples/telegram-mini-app dev` | [Mobile and Telegram Mini Apps](../docs/onboarding/mobile.md#telegram-mini-apps) |

## Wallets and dApps

| Example | Integration | Run | Guide |
|---|---|---|---|
| [`wallets-kit`](wallets-kit/) | Stellar Wallets Kit adapter, vanilla Vite *(repo)* | `pnpm -C examples/wallets-kit dev` | [Wallet adapters](../docs/onboarding/wallets.md#stellar-wallets-kit) |
| [`nextjs-wallets-kit`](nextjs-wallets-kit/) | Stellar Wallets Kit adapter in Next.js *(repo)* | `pnpm -C examples/nextjs-wallets-kit dev` | [Next.js, wallets](../docs/onboarding/web-nextjs.md#5-wallets-dapps) |
| [`walletconnect`](walletconnect/) | WalletConnect funnel through the Wallets Kit module *(repo)* | `pnpm -C examples/walletconnect dev` | [Wallet adapters](../docs/onboarding/wallets.md#connect-failures-wallet-context-and-walletconnect-tracker-120) |
| [`freighter`](freighter/) | Freighter called directly (`wrapFreighter`) *(repo)* | `pnpm -C examples/freighter dev` | [Wallet adapters](../docs/onboarding/wallets.md#wallets-called-directly-freighter-albedo-xbull-lobstr-hana-hot) |
| [`passkey`](passkey/) | Passkey smart accounts (`attachSmartAccountKit`) *(repo)* | `pnpm -C examples/passkey dev` | [Wallet adapters](../docs/onboarding/wallets.md#passkey-wallets-and-smart-accounts) |
| [`privy`](privy/) | Privy embedded Stellar wallets (`wrapPrivyStellar`) *(repo)* | `pnpm -C examples/privy dev` | [Wallet adapters](../docs/onboarding/wallets.md#privy-embedded-stellar-wallets) |
| [`stellar-rpc-browser`](stellar-rpc-browser/) | Browser RPC / Horizon telemetry (aggregate only) *(repo)* | `pnpm -C examples/stellar-rpc-browser dev` | [Wallet adapters](../docs/onboarding/wallets.md#browser-rpc--horizon-telemetry-aggregate-only) |

## APIs and backends

| Example | Integration | Run | Guide |
|---|---|---|---|
| [`api-node-express`](api-node-express/) | OpenTelemetry, zero code, Node.js / Express | `pnpm -C examples/api-node-express run start:scf-only` | [Node.js / Express](../docs/onboarding/api-node-express.md) |
| [`api-python-fastapi`](api-python-fastapi/) | OpenTelemetry, zero code, Python / FastAPI | `opentelemetry-instrument uvicorn app:app` | [Python / FastAPI](../docs/onboarding/api-python-fastapi.md) |
| [`api-go-nethttp`](api-go-nethttp/) | OpenTelemetry, Go `net/http` | `go run ./cmd/scf-only` | [Go](../docs/onboarding/api-go.md) |
| [`api-java-spring`](api-java-spring/) | OpenTelemetry Java agent, Spring Boot | `java -javaagent:target/opentelemetry-javaagent.jar -jar target/app.jar` | [Java / Spring Boot](../docs/onboarding/api-java-spring.md) |
| [`api-rust-axum`](api-rust-axum/) | OpenTelemetry, Rust / axum | `cargo run --release --bin scf-only` | [Rust / axum](../docs/onboarding/api-rust-axum.md) |
| [`api-anchor-platform`](api-anchor-platform/) | Anchor Platform 5.x, configuration only | `docker run --env-file otel-scf-only.env …` | [Anchor Platform 5.x](../docs/onboarding/api-anchor-platform.md) |
| [`anchor-platform-listener`](anchor-platform-listener/) | Anchor Platform events from Kafka (`ap-listener`) | `cd examples/anchor-platform-listener && ./run.sh` | [Anchors](../docs/onboarding/anchors.md#anchor-side-anchor-platform-5x) |
| [`anchor-wallet-sdk`](anchor-wallet-sdk/) | Wallet-side SEP funnel (`@usagemap/anchor-otel`) *(repo)* | `pnpm -C examples/anchor-wallet-sdk start` | [Anchors](../docs/onboarding/anchors.md#wallet-side-scf-analyticsanchor-otel) |
| [`stellar-rpc-node`](stellar-rpc-node/) | Stellar RPC / Horizon client metrics, Node (`@usagemap/stellar-otel`) *(repo)* | `pnpm -C examples/stellar-rpc-node start` | [Node.js / Express](../docs/onboarding/api-node-express.md) |
| [`stellar-rpc-python`](stellar-rpc-python/) | Stellar RPC client metrics, Python (`stellar-otel-py`) *(repo)* | `PYTHONPATH=../../packages/stellar-otel-py/src .venv/bin/python main.py` | [Python / FastAPI](../docs/onboarding/api-python-fastapi.md#5-optional-stellar-rpc-and-horizon-calls-py-stellar-base) |
| [`partner-calls`](partner-calls/) | Calls to SCF Integration List partners (`@usagemap/partner-otel`) *(repo)* | `pnpm -C examples/partner-calls start` | [Partner calls](../docs/onboarding/api-partner-calls.md) |
| [`api-x402`](api-x402/) | x402 payment counters (`@usagemap/payments-otel`) *(repo)* | `pnpm -C examples/api-x402 start` | [Payments (x402, MPP)](../docs/onboarding/payments.md) |
| [`payments-mpp`](payments-mpp/) | MPP payment counters via mppx *(repo)* | `pnpm -C examples/payments-mpp start`, then `pnpm run pay` | [Payments (x402, MPP)](../docs/onboarding/payments.md#3-mpp-mppx) |
| [`edge-cloudflare-workers`](edge-cloudflare-workers/) | Edge wrapper, Cloudflare Workers (`@usagemap/edge-otel`) *(repo)* | `pnpm -C examples/edge-cloudflare-workers dev` | [Cloudflare Workers](../docs/onboarding/api-cloudflare-workers.md) |
| [`edge-vercel`](edge-vercel/) | Edge wrapper, Vercel Edge functions *(repo)* | `pnpm -C examples/edge-vercel start` | [Cloudflare Workers and edge runtimes](../docs/onboarding/api-cloudflare-workers.md) |
| [`edge-deno`](edge-deno/) | Edge wrapper, `Deno.serve` *(repo)* | `cd examples/edge-deno && deno task start` | [Cloudflare Workers and edge runtimes](../docs/onboarding/api-cloudflare-workers.md) |
| [`edge-bun`](edge-bun/) | Edge wrapper, `Bun.serve` *(repo)* | `cd examples/edge-bun && bun run index.ts` | [Cloudflare Workers and edge runtimes](../docs/onboarding/api-cloudflare-workers.md) |

## Mobile apps

| Example | Integration | Run | Guide |
|---|---|---|---|
| [`mobile-react-native`](mobile-react-native/) | App events, React Native / Expo (self-attested) | `npx expo start` (phone or emulator) | [Mobile apps](../docs/onboarding/mobile.md#react-native-and-expo) |
| [`mobile-flutter`](mobile-flutter/) | App events, Flutter / Dart (self-attested) | `flutter run --dart-define=USAGEMAP_SITE=…` (device or emulator) | [Mobile apps](../docs/onboarding/mobile.md#flutter-and-dart) |

## On-chain and developer tools

| Example | Integration | Run | Guide |
|---|---|---|---|
| [`footprint-register`](footprint-register/) | Register contracts with a scoped `scfa_reg_…` key | `./register.sh <C…> testnet my-contract` | [Register your footprint](../docs/onboarding/footprint.md#register-from-your-deploy-script-scaffold-stellar) |
| [`scaffold-stellar`](scaffold-stellar/) | Scaffold Stellar template + post-deploy extension | `cd examples/scaffold-stellar && ./try-extension.sh` | [Register from your deploy script](../docs/onboarding/footprint.md#register-from-your-deploy-script-scaffold-stellar) |
| [`stellar-scf-cli`](stellar-scf-cli/) | `stellar scf` CLI plugin: check payloads offline | `cd examples/stellar-scf-cli && ./check.sh` | [Troubleshooting](../docs/onboarding/troubleshooting.md) |
| [`pin-action`](pin-action/) | GitHub Action that keeps tracker pins and SRI current | `tools/pin-action/run check examples/pin-action/site` | [Plain HTML](../docs/onboarding/web-html.md) |
| [`mcp-claude`](mcp-claude/) | Local MCP server for Claude Code, Claude Desktop, Cursor | copy `mcp.json` to `.mcp.json`, restart your client; `/mcp` lists `usagemap` | [Get your project measured](../docs/onboarding/README.md) |

## How they are tested

| Suite | Examples | Command |
|---|---|---|
| README drift (no build, no network) | all | `pnpm --dir tests exec vitest run --project unit quickstarts/examples.test.ts` |
| Framework apps in Chromium against a mock of the ingest protocol | websites, `nextjs-wallets-kit` | `tests/quickstarts/frameworks/run.sh` (`QS_FRAMEWORKS=nextjs,…`) |
| Browser integrations in Chromium against the same mock | wallets, `stellar-rpc-browser`, `telegram-mini-app` | `tests/quickstarts/integrations/browser/run.sh` |
| Backends in both export modes against a local OTLP receiver | `api-*` except `api-x402` | `tests/quickstarts/backends/run.sh` (`QS_BACKENDS=…`) |
| Server, edge, mobile and tool integrations against local stand-ins | the rest | `tests/quickstarts/integrations/run.sh` (`QS_INTEGRATIONS=…`) |
| x402 counters with a fake facilitator | `api-x402` | `pnpm --filter @usagemap/payments-otel run test:example` |

The backend services share one route (`/accounts/{id}`: `GABC` 200, `GMISSING` 404, `GBOOM` 500) in two modes:
**UsageMap only** (configured by the standard OpenTelemetry environment variables) and **dual export** (your APM keeps
its export, a filtered copy goes to UsageMap). Every version is pinned exactly (`package.json`, the full
`requirements.txt`, `go.mod`/`go.sum`, `pom.xml`, `Cargo.toml`/`Cargo.lock`, image digests in the suites). The Python
set includes `typing_extensions` (PSF-2.0) and `certifi` (MPL-2.0); like everything here they fall under the
examples-only licence exception below.

## Separate workspace, licence exception

This directory is its own pnpm workspace with its own lockfile, outside the product's workspace. Frameworks pull in
dependencies whose licences the product's allow-list does not accept (for example `caniuse-lite`, CC-BY-4.0, and
`sharp`'s LGPL binaries under Next.js and Astro). The licence exception covers this directory only, because nothing
in it is distributed (register C-135, decision D11). The supply-chain settings are the product's: exact versions,
nothing younger than three days, every install script denied (`pnpm-workspace.yaml`). The tracker and the other
`@usagemap` packages are installed from this repository (`file:` / `link:`) because they are not on npm yet.
