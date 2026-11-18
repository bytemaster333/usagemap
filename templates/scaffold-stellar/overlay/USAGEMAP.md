# UsageMap in this project

This project was created from the UsageMap community template for Scaffold Stellar. It is the official React
template with three things pre-wired:

- web and wallet analytics;
- a post-deploy extension that records the project's own contract ids;
- the environment variables for API analytics.

**Nothing is sent until you turn it on.**

## 1. Web and wallet analytics

`app/src/usagemap.ts` is imported first in `app/src/main.tsx`. It starts the pinned UsageMap tracker and attaches the
Stellar Wallets Kit adapter. The adapter counts wallet modal, connect, sign and submit events with the **wallet type
and network only**: never an address, a transaction or an amount.

To turn it on, add your site key from the portal (**Project → Websites**) to `app/.env`:

```sh
PUBLIC_USAGEMAP_SITE=your22charactersitekey
# PUBLIC_USAGEMAP_CONSENT=required   # if a consent banner must gate analytics
```

In `npm start` (Vite dev mode), a small debug panel explains why each event was or was not sent: Global Privacy
Control, a dev origin, consent mode and so on. Production builds leave it out.

## 2. Contract registration (post-deploy extension)

`scaffold.yml` registers the `usagemap` extension, which is `tools/stellar-scaffold-usagemap`. `npm install` links
its binary into `node_modules/.bin`, so Scaffold finds it whenever it runs from an npm script (`npm start`). In a
plain shell, run `npm exec -- stellar scaffold build`, or put `node_modules/.bin` on your `PATH`.

After every deployment to **testnet or mainnet**, the extension writes the contract to `.usagemap/contracts.json`.
It writes the network, the contract name, the contract id and the wasm hash. Local deployments are skipped. The
file holds public facts only; commit it if you like.

Registering the contracts with UsageMap is **opt-in**. Once registered, the portal can verify your on-chain usage.
To opt in:

1. Set `register: true` under `extensions.usagemap` in `scaffold.yml`.
2. On the portal page "Register your Stellar contracts", create a **registration key** (`scfa_reg_…`). It is shown
   once. It can only add contracts to this project as claims, optionally on one network; it cannot verify, remove
   or read anything, and you can revoke it there at any time.
3. Export `USAGEMAP_TENANT_ID` (the project id shown next to the key) and `SCF_FOOTPRINT_KEY` (the key) in your
   shell or CI. Never put them in `app/.env`. (`USAGEMAP_FOOTPRINT_KEY` is accepted as another name for the key.)
4. Deploy. Each contract is sent as a **claim**. Prove ownership on the portal page "Register your Stellar
   contracts" to make it verified.

Without the key or without `register: true`, the extension does a **dry run**. It prints the exact request it would
send and sends nothing. It never reads your Stellar CLI identities or keys. It never sends the RPC URL, the network
passphrase or any local path.

## 3. API analytics for a backend

If the project has a backend, `usagemap.env.example` lists the standard OpenTelemetry variables that send
`http.server.request.duration` to UsageMap. For edge runtimes (Cloudflare Workers, Vercel Edge, Deno, Bun), use
`@usagemap/edge-otel`.

## Removing UsageMap

1. Delete `app/src/usagemap.ts` and its import line in `app/src/main.tsx`.
2. Delete the `@usagemap/tracker` dependency in `app/package.json`.
3. Delete the `extensions.usagemap` block in `scaffold.yml`.
4. Delete `tools/stellar-scaffold-usagemap` and its entry in the root `package.json` workspaces.
