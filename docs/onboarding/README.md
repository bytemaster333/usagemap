# Get your project measured

This is the tenant documentation of the platform: how to get your website, dApp or API counted, what is counted, and
how to show the numbers to SCF. Every page starts with what to do; the reasons come after.

## Pick your path

| You have | Start here | Then |
|---|---|---|
| An SCF-awarded project | [Sign up from the SCF registry](registry-projects.md) | the integration kit |
| A static site or plain HTML pages | [Plain HTML in 10 minutes](web-html.md) | [Dev origins and debug mode](dev-origins-and-debug.md) |
| A site from Eleventy, Hugo or Jekyll | [Static site generators](web-static-site-generators.md) | |
| A documentation site (VitePress, Docusaurus) | [Documentation sites](web-docs-sites.md) | |
| A WordPress, Webflow, Framer or Ghost site | [Site builders and CMSs](web-cms.md) | |
| A Next.js app (App Router) | [Next.js in 10 minutes](web-nextjs.md) | [Wallet adapters](wallets.md) if it is a dApp |
| A React single-page app (Vite, Scaffold Stellar) | [React SPA in 10 minutes](web-react-spa.md) | [Wallet adapters](wallets.md) |
| A React Router (framework mode) or Remix app | [React Router and Remix in 10 minutes](web-react-router.md) | |
| A Nuxt app | [Nuxt in 10 minutes](web-nuxt.md) | |
| A SvelteKit app | [SvelteKit in 10 minutes](web-sveltekit.md) | |
| An Astro site | [Astro in 10 minutes](web-astro.md) | |
| A Node.js / Express API | [Node.js API in 10 minutes](api-node-express.md) | [Already have an APM?](api-dual-export.md) |
| Next.js route handlers | [Next.js API in 10 minutes](api-nextjs.md) | |
| A Rust axum API | [Rust axum in 10 minutes](api-rust-axum.md) | |
| A Go `net/http` API | [Go in 10 minutes](api-go.md) | |
| A Python FastAPI API | [Python FastAPI in 10 minutes](api-python-fastapi.md) | |
| A Java / Spring Boot API | [Java agent in 10 minutes](api-java-spring.md) | |
| A Stellar Anchor Platform (5.x) deployment | [Anchor Platform: configuration only](api-anchor-platform.md) | |
| Agent payments on Stellar (x402, MPP) | [Payments: x402 and MPP hooks](payments.md) | |
| A backend that calls Soroswap, DeFindex, ramps or bridges | [Calls to SCF Integration List partners](api-partner-calls.md) | |
| An anchor, or a wallet that uses anchors (SEP-6/24/31) | [Anchors and anchor-using wallets](anchors.md) | [Anchor Platform](api-anchor-platform.md) |
| A mobile app (React Native, Expo, Flutter, Swift, Kotlin) or a Telegram Mini App | [Mobile apps and Telegram Mini Apps](mobile.md) (self-attested counts) | |
| A Cloudflare Worker | [Cloudflare Workers](api-cloudflare-workers.md) (not yet measured end to end) | |
| Smart contracts or project accounts on Stellar | [Register your footprint](footprint.md) | [Register from your deploy script](footprint.md#register-from-your-deploy-script-scaffold-stellar), [protocols your users interact with](footprint.md#protocols-your-users-interact-with) |
| Numbers to put in an SCF application | [Paste this URL into SCF](share-with-scf.md) | [Methodology](../methodology/scf-methodology-1.0.0.md) |
| Something that does not show up | [Troubleshooting](troubleshooting.md) | |

Every web page above is backed by a complete example app in the repository (`examples/`), which the repository's
browser tests build in production mode and check in a real browser: page views counted exactly once on load, on every
client-side navigation and on the back button, custom events delivered, nothing sent but the path. The site-builder
page says precisely what is and is not tested. Every API page from Node.js to the Anchor Platform is backed the same
way by an example service (`examples/api-*`), run against a local stand-in of the SCF endpoint with and without a
second exporter for your APM; each page says what that run proved.

## The steps every project goes through

1. **Sign in** to the portal with a Stellar wallet (or GitHub, where the deployment configures it — the live host
   does not yet) and **create your project** (a tenant).
2. **Add a website** (production domain) and/or **an API** (a service name). Add `localhost` as a dev origin so you
   can test before you deploy ([dev origins](dev-origins-and-debug.md)).
3. **Install**: the tracker snippet for the web, environment variables for an API.
4. **Register your footprint**: the Stellar contracts your project deployed, or say that you have none
   ([footprint](footprint.md)). The setup wizard does not finish without this step; ingest is never blocked by it.
5. **Check the first event**: the portal's first-event panel shows what arrived, what was kept and what was dropped.
6. **Verify your domain** so that page views can count as *verified*.
7. **Share** the public URLs with SCF ([paste this URL](share-with-scf.md)).

## Placeholders used on every page

The platform's final host names are not fixed yet. The portal's **Snippet** and **Ingest tokens** pages show the real
values for your project; these pages use placeholders:

| Placeholder | Stands for |
|---|---|
| `YOUR_22_CHAR_SITE_KEY` | your site's public key (portal: site → Snippet) |
| `https://ingest-a.example-analytics.org`, `https://ingest-b.example-analytics.net` | the two web ingest hosts (the tracker uses both) |
| `https://ingest.scf.example` | the OTLP endpoint for API telemetry |
| `scfa_ing_…` | an ingest token (portal: Ingest tokens; shown once) |
| `https://portal.example.invalid` | the portal and its public pages |
| `@usagemap/tracker` | the tracker's npm package |
| `your-project` | your project's slug |

## What the platform never collects

No IP addresses, no raw User-Agent strings, no query strings, no page titles, no cookies, and **no visitor's wallet
address, transaction hash, signature or amount**. The only Stellar addresses stored are the ones your project declares
as its own and proves ([footprint](footprint.md)); an address you could not prove is deleted 30 days later. Wallet
events are a closed vocabulary of names and enum values ([wallets](wallets.md)).

## Reference pages

- [Wallet events and adapters](wallets.md), including the [counted-only events](wallets.md#counted-only-events), connect
  failures, the WalletConnect funnel, Privy and browser RPC telemetry (tracker 1.2.0)
- [Stellar Disbursement Platform](api-sdp.md) and [OpenZeppelin Relayer](api-oz-relayer.md): why their metrics are not
  accepted
- [Dev origins and debug mode](dev-origins-and-debug.md)
- [Troubleshooting decision tree](troubleshooting.md)
- [Already have an APM: dual export](api-dual-export.md)
- [Metric definitions](../metrics/definitions.md) and the [public
  methodology](../methodology/scf-methodology-1.0.0.md)
- More recipes (consent mode, strict profile, Vue, Java, .NET, tenant Collector):
  [quickstarts](../guides/quickstarts/README.md)
