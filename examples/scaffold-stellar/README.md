# Scaffold Stellar (community template + post-deploy extension)

UsageMap's [Scaffold Stellar](https://github.com/stellar-scaffold/cli) community template makes a new Stellar dApp
measured from its first deploy, and sends **nothing until you turn it on**: web and wallet analytics start when
`PUBLIC_USAGEMAP_SITE` is set, and the post-deploy extension records each deployed contract and (opt-in) registers it
with your footprint. This folder shows the pieces the template adds and lets you run the extension the way Scaffold
does. Guide: [Register your footprint](../../docs/onboarding/footprint.md#register-from-your-deploy-script-scaffold-stellar)
and the template's [README](../../templates/scaffold-stellar/README.md).

## Run it

1. **Install:** nothing for the extension demo (Node 24). For a whole dApp: `./assemble.sh /tmp/my-dapp
   <tracker.tgz>` builds the template from the official React template at the pinned commit (needs git and
   github.com). `stellar scaffold init my-dapp --template <org>/<repo>#v0.1.0` works only once the template is in a
   public repository (not yet).
2. **Set your key:** in the dApp, `PUBLIC_USAGEMAP_SITE=<22-character site key>` in `app/.env` (portal: **Project →
   Websites**). For registration: `export SCF_FOOTPRINT_KEY=scfa_reg_… USAGEMAP_TENANT_ID=<project id>` (portal:
   **Footprint**) and `register: true` in `scaffold.yml` (or `USAGEMAP_REGISTER=1`).
3. **Run:** `cd examples/scaffold-stellar && ./try-extension.sh` → the manifest, `recorded guess_the_number on
   testnet`, the dry-run request it would send, and `.usagemap/contracts.json`. In the dApp: `npm start`.

## The lines that add UsageMap

The template imports `app/src/usagemap.ts` first in `app/src/main.tsx`, and merges `scaffold.usagemap.yml` into the
project's `scaffold.yml`.

`app/src/usagemap.ts`:

```ts
export const usagemap = site
	? init(consentRequired ? { site, consent: "required" } : { site })
	: undefined

if (usagemap) {
	// Wallet modal, connect, sign and submit events with the wallet type and
	// network only: never an address, a transaction or an amount.
	attachWalletsKit(StellarWalletsKit)
}
```

`scaffold.usagemap.yml`:

```yaml
extensions:
  usagemap:
    # Networks whose deployments are recorded (local deployments are throwaway).
    networks: [testnet, mainnet]
    # Where the list is written, relative to the project root.
    out: .usagemap/contracts.json
    # true: also register each deployed contract with UsageMap as "claimed"
    # (you then prove ownership on the portal). Default: dry run.
    register: false
```

`usagemap.env.example`:

```sh
PUBLIC_USAGEMAP_SITE=
# …
USAGEMAP_TENANT_ID=
SCF_FOOTPRINT_KEY=
```

These three files are copies of the template's overlay (`templates/scaffold-stellar/overlay`). The extension reads
only what Scaffold passes after a deploy (network, contract name and id, wasm hash); it never reads identities or
keys of the Stellar CLI, and never sends the RPC URL or local paths.

## What you'll see in the portal

Web and wallet events (page views, wallet modal, connect, sign) on the **Websites** and **Wallets** pages, as for any
dApp with the tracker and the Wallets Kit adapter; events from `localhost` appear only in the first-event panel. With
registration on, each testnet or mainnet deploy adds the contract on **Footprint** as `claimed`; it is counted once you
have proven the deploying account.

## Test it without the app

```sh
SCF_FOOTPRINT_KEY=scfa_reg_… USAGEMAP_TENANT_ID=<project id> USAGEMAP_REGISTER=1 ./try-extension.sh
# → usagemap: registered CAAXJE… as claimed (409 "already registered" is fine too)
```

## Tested by

`tests/quickstarts/integrations/tools.spec.ts` (`scaffold-stellar`): checks that the three files are byte for byte the
template's overlay files and that `assemble.sh` pins the commit of `templates/scaffold-stellar/UPSTREAM.json`; runs
`try-extension.sh` as a dry run (nothing sent, the contract recorded) and with `USAGEMAP_REGISTER=1`, a registration
key and a tenant id against a local stand-in of the control plane, and checks the one request
(`POST /v1/tenants/{id}/footprint/register`, `Authorization: Bearer scfa_reg_…`, body `{kind, subject, network,
label}`) and that the key is never printed. **Not run:** `assemble.sh` (it clones github.com), `stellar scaffold init`
(needs a public template repository) and a browser run of the generated dApp (the template's own tests type-check
`usagemap.ts` against the real kit and tracker types).
