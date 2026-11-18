# Quickstarts

Per-stack recipes for the [tenant onboarding guide](../tenant-onboarding.md). **Status (docs.quickstarts-run): checked against the code;** each recipe's status line says how it was run. The script-tag, npm, Node/Express, Python/FastAPI, Go, Rust/axum and Collector fan-out guides run as test fixtures (`tests/quickstarts/40-quickstarts.e2e.test.ts`); the others are checked against the code or measured in spikes, as their status lines say.

Placeholders used throughout: ingest hosts `https://ingest-a.example-analytics.org` and
`https://ingest-b.example-analytics.net`, OTLP endpoint `https://ingest.scf.example`, npm scope `@scf-analytics`,
site key `YOUR_22_CHAR_SITE_KEY`, ingest token `scfa_ing_…`. The portal's **Snippet** page fills in the real values for
your site.

## Web (browser tracker 1.2.0; recipes checked with 1.1.0, whose snippet API 1.2.0 keeps)

| Recipe | How it was checked |
|---|---|
| [Script tag with SRI](web-script-tag.md) | tracker e2e: static fixture, SRI mismatch, strict CSP with Trusted Types (`tracker/e2e/smoke.spec.ts`, `fixtures.spec.ts`) |
| [npm package](web-npm.md) | tracker e2e: React Router SPA with `init()` called twice under StrictMode (`fixtures.spec.ts`) |
| [Next.js](web-nextjs.md) | framework browser suite: `examples/nextjs` built and served with `next start`, driven in Chromium (`tests/quickstarts/frameworks/`) |
| [Vite + React SPA](web-vite-react.md) | framework browser suite: `examples/vite-react`; tracker e2e: React Router SPA fixture |
| [Vue](web-vue.md) | tracker e2e: Vue Router SPA with the script tag and command queue |
| [Consent mode](web-consent-mode.md) | tracker e2e: `privacy.spec.ts` (nothing — not even the challenge — before `grantConsent()`) |
| [Strict profile](web-strict-profile.md) | tracker e2e: `privacy.spec.ts` (instrumented property reads); build-time static check |

### Frameworks, generators and site builders (tracker.ssr-frameworks)

The tenant guides in [`docs/onboarding`](../../onboarding/README.md) cover each framework with a complete example app
under `examples/` (own pnpm workspace and lockfile; licence exception for examples only, never shipped — register
C-135, decision D11). The framework browser suite `tests/quickstarts/frameworks/` (`run.sh`; no Docker) installs them
from the frozen lockfile, builds each in production mode, serves it with its own production server and drives it in
Chromium against the protocol-v1 mock gateway (schemas and proof of work checked): one page view per load, per
client-side navigation and on back; one custom event; a deep link with query and fragment counted once, as its path;
no request to any other host; no console error. `tests/quickstarts/frameworks.test.ts` (unit) keeps the guides' code
identical to the examples' files, their SRI hashes equal to the build's and their "tested with" versions equal to the
pins.

| Guide | Example | Install | Served by |
|---|---|---|---|
| [Plain HTML](../../onboarding/web-html.md) | `examples/html` | script tag + SRI | static files |
| [Static site generators](../../onboarding/web-static-site-generators.md) (Eleventy run; Hugo, Jekyll, Docusaurus not run) | `examples/eleventy` | script tag + SRI | static files |
| [Astro](../../onboarding/web-astro.md) (with view transitions) | `examples/astro` | script tag + SRI | static files |
| [React SPA (Vite)](../../onboarding/web-react-spa.md) | `examples/vite-react` | npm | static files, SPA fallback |
| [Next.js App Router](../../onboarding/web-nextjs.md) | `examples/nextjs` | npm | `next start` |
| [Next.js + Stellar Wallets Kit](../../onboarding/web-nextjs.md#5-wallets-dapps) | `examples/nextjs-wallets-kit` | npm + Wallets Kit adapter | `next start` |
| [Nuxt](../../onboarding/web-nuxt.md) | `examples/nuxt` | npm (client plugin) | Nitro server |
| [SvelteKit](../../onboarding/web-sveltekit.md) | `examples/sveltekit` | npm | adapter-node |
| [React Router framework mode / Remix](../../onboarding/web-react-router.md) | `examples/react-router` | npm | `react-router-serve` |
| [Site builders and CMSs](../../onboarding/web-cms.md) (WordPress, Webflow, Framer, Ghost) | — (the snippet: `examples/html`) | script tag + SRI | not run: third-party services |

The portal also generates an Angular snippet (`services/control-plane/src/lifecycle/handlers.ts`); it is not covered
by a fixture.

## API (OpenTelemetry dual export)

**Every API recipe here is taken from the measured spike READMEs** — `spikes/s06a-dual-export-node-python/README.md`
and `spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md` (C-102, C-105) — not from earlier research notes, which
had bugs in every in-SDK recipe. The spikes ran each stack end to end against a stand-in for the UsageMap endpoint that
required a bearer token. The UsageMap endpoint (the gateway's OTLP front door and ingest tokens) is built; the recipes marked so run
against it as test fixtures (`make quickstarts`).

Read [API: rules for every stack](api-common.md) first.

| Recipe | Pattern | Spike result |
|---|---|---|
| [Tenant-side Collector fan-out](api-collector-fanout.md) — **recommended** | your Collector sends everything to your APM and a filtered copy to UsageMap | works as written (S-06a, S-06b); no header leak; minimal resource |
| [Node.js / Express](api-node-express.md) | in-SDK, two metric readers | works after two fixes (S-06a) |
| [Next.js](api-nextjs.md) | `@vercel/otel`, SERVER spans only | works after two fixes (S-06a) |
| [Python / FastAPI](api-python-fastapi.md) | in-SDK, filtered second reader | works after two fixes (S-06a) |
| [Go `net/http`](api-go.md) | in-SDK, filtered second reader | works (S-06b) |
| [Rust / axum](api-rust-axum.md) | in-SDK, second periodic exporter | works; **environment headers override the token** (S-06b) |
| [Java / Spring Boot](api-java-spring.md) | Java agent with a declarative config file, or the tenant Collector | works (S-06b) |
| [.NET](api-dotnet.md) | named OTLP exporters | works (S-06b) |

Untested and therefore not documented here: AWS Lambda, Vercel's own runtime, gRPC and OTLP/JSON export, Go gin/chi,
Rust actix-web, Spring WebFlux, .NET controllers, the Java agent extension route.
