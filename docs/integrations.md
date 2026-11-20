# Integrations: design catalogue

UsageMap meets Stellar developers in the tools they already use: the Wallets Kit, the JS SDK, Scaffold Stellar, the
Stellar CLI, their edge runtime, their docs site and their AI assistant. This page is the design view of those
integrations: what each one does, what it never sends, and where it lives. The user-facing guide, with the portal's
labels and step-by-step setup, is [`onboarding/integrations.md`](onboarding/integrations.md).

## 1. Principle: every integration is a four-step loop in the portal

1. **Pick.** The portal's integration catalogue lists every integration, filtered by the project's category and stack.
2. **Generated config.** The portal shows the exact snippet, env block, `scaffold.yml` block or wrapper line, with the
   tenant's site, services and routes already filled in.
3. **Test.** The portal offers a test command:
   - OTLP integrations get a copy-paste `curl`, or `stellar scf check` as an offline dry run.
   - Browser integrations get the tracker debug mode instead. Web ingest needs the proof-of-work challenge
     ([`contracts/wire-formats.md`](contracts/wire-formats.md) §a.2), so an honest pure-`curl` web test does not exist.
4. **See it arrive live.** The first-event panel shows what was received, kept and dropped, with the reason in plain
   language. Test traffic is never counted.

An integration is complete only when all four steps work and a test drives them.

## 2. Catalogue

| Integration | What it gives the tenant | Privacy notes | Where |
|---|---|---|---|
| Browser tracker (script tag with SRI, or npm) | Page views, visitors, referrers, devices, countries; framework guides for static sites, SPAs and SSR frameworks | Version-pinned; no cookies; path normalised | `tracker/`, `examples/`, [`guides/quickstarts/`](guides/quickstarts/) |
| Wallets Kit adapter and module wrapper `withUsageMap(modules)` | Wallet connect/sign events from the Stellar Wallets Kit, including modules referenced before analytics loads | Address-free by construction; Stellar event schema v1 values only | `tracker/src/wallets-kit.ts`, [`onboarding/wallets.md`](onboarding/wallets.md) |
| Wallet wrappers (Freighter, LOBSTR, Albedo, xBull, HOT) and passkey/smart-account adapter | The same wallet events for apps not using the kit | Event names only; never imports the wallet SDKs | `tracker/src/wallets.ts`, `tracker/src/passkey.ts` |
| Dual-export OpenTelemetry recipes per stack | API volume, status codes and latency percentiles from the tenant's existing OTel setup | Collector keeps only allow-listed attributes; traces and logs dropped | [`onboarding/api-dual-export.md`](onboarding/api-dual-export.md), `services/control-plane/src/api/otel-recipes.ts` |
| Stellar SDK telemetry `instrumentStellarRpc` / `instrumentHorizon` (Node, Python, Go) | RPC latency by method; submit/poll/simulate outcome classes; transaction failure classes | No RPC URL (provider keys live in paths), no address, no hash; result codes decoded in memory and discarded | `packages/stellar-otel`, `packages/stellar-otel-py` |
| Browser RPC panel | Client-observed RPC health and transaction outcomes for pure dApps | Only through a session-free daily aggregate | `tracker/` |
| `stellar scf` CLI plugin (`check`, `init`, `status`) | Offline answer to "why is nothing arriving", using the production sanitiser; `--fail-on-drop` for CI | Never reads the CLI `identity/` directory; echoes attribute keys only, never values | `tools/stellar-scf` |
| Edge middleware `withUsageMap(handler)` (Workers, Vercel edge, Deno, Bun) | Route-templated API metrics from runtimes with no native metrics export | Drops User-Agent, IP, cookies, query strings and account addresses before export | `packages/edge-otel` |
| Scaffold Stellar template and post-deploy extension | New dApps are measured from the start; deploys register contract IDs for the on-chain footprint | Nothing is sent while `PUBLIC_USAGEMAP_SITE` is empty | `templates/scaffold-stellar` |
| Contract and account registration (footprint) | On-chain correlation of the tenant's own contracts | Hints only pre-fill; the tenant confirms | [`onboarding/footprint.md`](onboarding/footprint.md) |
| Protocol grouping with `stellar.toml` auto-detect (SEP-1/6/10/12/24/31/38/45, Horizon-shaped, RPC) | API traffic grouped by Stellar surface without configuration | Reads only the public `stellar.toml` | control plane |
| Anchor Platform recipe and listener | API intake and SEP-6/24/31 funnel counts for anchors | Route templates keep `/sep12/customer/{account}` unexpanded; counts only | [`onboarding/api-anchor-platform.md`](onboarding/api-anchor-platform.md), `tools/ap-listener`, `packages/anchor-otel` |
| Payment hooks (x402, MPP) | "Paid" next to "402 required" | Never forwards `payer`, `transaction` or `amount` | `packages/payments-otel`, [`onboarding/payments.md`](onboarding/payments.md) |
| Partner API calls | Calls to ecosystem partner APIs as a separate, self-attested stream | Self-attested; never counted as API usage | `packages/partner-otel`, [`onboarding/api-partner-calls.md`](onboarding/api-partner-calls.md) |
| Hosted `badge.svg` and Shields endpoint JSON | Fresh numbers on README badges | Viewers fetch through Shields and never contact UsageMap | [`onboarding/share-with-scf.md`](onboarding/share-with-scf.md) |
| Consent-gated ecosystem feed `usagemap/ecosystem-feed/0` | Measured usage for ecosystem directories that choose to pull it | Card aggregates only; "self-attested" label on API figures; "measurement, not endorsement" | control plane |
| Docs-site plugins (Docusaurus, GitBook, Mintlify) and Astro integration | Tracker on documentation sites | As the tracker | [`onboarding/web-docs-sites.md`](onboarding/web-docs-sites.md), [`onboarding/web-astro.md`](onboarding/web-astro.md) |
| Mobile (React Native, Flutter) over OTLP/HTTP JSON | App events from mobile apps | Self-attested; no bot verification possible | `packages/mobile-rn`, `packages/mobile-flutter`, [`onboarding/mobile.md`](onboarding/mobile.md) |
| MCP server (read-only aggregates over the tenant's API keys) | Project metrics in AI assistants | Same aggregates as the portal; covered by the isolation matrix | `tools/mcp`, [`ai/mcp.md`](ai/mcp.md) |
| Agent skill `SKILL.md` ("instrument this Stellar dApp") | AI coding agents set UsageMap up correctly | — | [`ai/usagemap-instrument/SKILL.md`](ai/usagemap-instrument/SKILL.md) |
| GitHub Action for tracker pins | SRI-aware upgrade PRs (generic dependency bots cannot rewrite `integrity`) | — | `tools/pin-action` |
| SCF project sign-up and personalised integration kit | A new tenant picks its SCF-awarded project from the public registry and gets the integrations that fit its category, pre-configured | A claim never grants trust; claims are checked against existing tenants | [ADR-0032](adr/0032-scf-programme-integration.md), [`onboarding/scf-projects.md`](onboarding/scf-projects.md) |

## 3. Decided against, and licence traps

- **Metered RPC/Horizon relay: not in v1.**
  - The relay would sit in every call of the transaction path; on a single non-HA VM a relay outage breaks the
    tenant's dApp, not just its analytics.
  - It would see end-user IPs and transaction XDR in flight, which widens the processor role.
  - It would be an open-proxy target holding provider keys, and it adds latency far from its region.
  - Stellar SDK telemetry gives the same per-method data with no hop and no XDR, and on-chain counts are the stronger
    evidence anyway. A relay stays a possible later option: opt-in, server-side only, behind an HA edge.
- **WordPress directory plugin: no.** The directory rules require explicit consent before contacting external servers
  (a consent UI) and add a PHP maintenance cost. The mu-plugin snippet in
  [`onboarding/web-cms.md`](onboarding/web-cms.md) stays.
- **Webflow / Framer apps: no.** Both have a site-wide head field, so the documented script tag is enough.
- **Licence traps:**
  - WalletConnect `@walletconnect/sign-client` ≥ 2.23 and `@reown/appkit` use the *WalletConnect Community License*,
    which is not OSI-approved. The Wallets Kit 2.8.0 hard-depends on both, so the tracker **never imports the kit**:
    the app passes its kit class or modules in. Only `examples/` lockfiles contain these packages, under an
    examples-only licence exception.
  - The xBull and HOT wallet SDKs publish **no licence**. The tracker wraps the functions the app passes and never
    depends on them.
  - Every new package is checked against the licence allow-list (`docs/security/supply-chain.md` §5.1).
