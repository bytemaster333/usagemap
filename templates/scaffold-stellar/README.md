# UsageMap community template for Scaffold Stellar

A [Scaffold Stellar](https://github.com/stellar-scaffold/cli) community template. A new Stellar dApp made from it is
measured by UsageMap from its first deploy, and sends **nothing until the developer turns it on**:

```sh
stellar scaffold init my-dapp --template <org>/<repo>#v0.1.0
```

This directory holds the **overlay** (files only) and the script that assembles the template repository from the
official React template at a pinned commit. The `--template org/repo#tag` line works only once the assembled tree is
pushed to a **public** repository: `init` downloads it without credentials. Making a repository public is the
maintainers' decision and is not done by this script.

## What the template pre-wires

| Where | What |
|---|---|
| `app/src/usagemap.ts`, first import in `app/src/main.tsx` | The pinned tracker (`@usagemap/tracker` **1.1.0**, exact pin) and the Stellar Wallets Kit adapter (`attachWalletsKit`, C-151). The adapter records wallet type and network only. Everything is off unless `PUBLIC_USAGEMAP_SITE` is set; the debug panel runs in Vite dev mode only. |
| `scaffold.yml` → `extensions.usagemap` | The post-deploy extension `stellar-scaffold-usagemap` (`tools/stellar-scaffold-usagemap`, an npm workspace, so its binary is in `node_modules/.bin`) |
| `usagemap.env.example` | `PUBLIC_USAGEMAP_SITE` / `PUBLIC_USAGEMAP_CONSENT`, the registration variables, and the standard `OTEL_*` variables for a backend (the token is kept out of `PUBLIC_`) |
| `USAGEMAP.md` | The developer-facing guide in the generated project, including how to remove UsageMap |
| `USAGEMAP_TEMPLATE.json` | Provenance: the upstream repository and commit, the overlay version, the tracker spec, and the SHA-256 of every added or changed file |

### The post-deploy extension

Scaffold calls the extension once per deployed contract with a JSON object on stdin. The protocol is the Scaffold
docs' "Extensions" page at `stellar-scaffold/cli@9edb742`. For each deployment the extension:

1. Uses only **testnet and mainnet** deployments. It detects them by network passphrase, so a `testnet-dev` that
   extends testnet counts as testnet. Local and custom networks are skipped.
2. Writes `{network, contract, contract_id, wasm_hash}` to `.usagemap/contracts.json`.
   - A redeploy replaces the entry.
   - The path must stay inside the project.
   - Ids that are not strictly valid contract StrKeys are ignored.
3. Registers the contract with UsageMap's Registered Footprint (`POST /v1/tenants/{id}/footprint/register`,
   operation `registerFootprintContract`, status `claimed` until the project proves ownership on the portal).
   **Only** when `register: true` is set (or `USAGEMAP_REGISTER=1`) **and** both `SCF_FOOTPRINT_KEY` (alias
   `USAGEMAP_FOOTPRINT_KEY`) and `USAGEMAP_TENANT_ID` are set.
   - The key is a **footprint registration key** `scfa_reg_…` created by a project admin on the portal: scope
     `footprint:register` only, one project, optionally one network, hashed at rest, revocable, rate-limited. It can
     add `claimed` contracts and nothing else; a portal session is never needed.
   - Otherwise it is a **dry run** that prints the exact request and sends nothing.
   - It needs https (http only for localhost) and follows no redirects.
   - `409` (already declared) counts as success; `401` (revoked or expired key), `403` (key bound to another
     network), `404` (key of another project) and `429` are explained and exit non-zero, which Scaffold logs.

It never reads Stellar CLI identities, accounts or keys. It never prints the key. It never sends the RPC URL, the
passphrase or local paths. It is plain Node ≥ 18 ESM with no dependencies.

## Assemble the template repository

```sh
git clone https://github.com/stellar-scaffold/ui /tmp/ui && git -C /tmp/ui checkout 2a5c5f8ae5ce7fa7931387e97158362caf597b30
node templates/scaffold-stellar/assemble.mjs --upstream /tmp/ui --out /tmp/usagemap-scaffold-template
# until the npm scope exists: --tracker-tarball <npm pack of a tracker built with TRACKER_HOSTS=<live ingest hosts>>
```

The script does the following:

- Copies the checkout without `.git`, `node_modules` or build output.
- Promotes `templates/react` to `app/` exactly as `init` does for an official template. This follows
  `instantiate.rs` at the pinned CLI commit: `templates/` removed, root workspaces rewritten, e2e snapshots pruned.
  `init` copies community templates as they are.
- Applies the overlay. Every edit checks its anchor and **fails loudly** if upstream has changed shape: an
  `extensions:` key already present, `main.tsx` without imports or `createRoot`, the kit no longer in `app-lib`, a
  `scaffold.yml` that is not version 2.

Nothing from the checkout is executed, and nothing is installed. Before tagging a release of the assembled
repository:

1. Run `npm install --package-lock-only --ignore-scripts` there. The upstream lockfile still names
   `templates/react`.
2. Run the upstream CI recipe: `stellar scaffold init tmp --template <org>/<repo>#<branch> -y`, then build.

## Tests

```sh
cd templates/scaffold-stellar && node --test test/*.test.mjs
SCAFFOLD_UI_DIR=/tmp/ui node --test test/*.test.mjs   # also against the real upstream checkout
```

- `test/extension.test.mjs` (11 tests) drives the binary exactly as Scaffold does: `manifest`, then `post-deploy`
  with the documented stdin. A mock UsageMap API checks that:
  - a dry run sends nothing, with or without a key;
  - an opted-in run sends exactly one claim `{kind, subject, network, label}` with `Authorization: Bearer`;
  - `409`, `401`, `422` and network failures are handled;
  - unsafe URLs, keys and tenant ids are refused before anything is sent;
  - the key is never printed.
- `test/assemble.test.mjs`:
  - against a fixture with the monorepo's shape: the overlay, provenance hashes, vendored-tarball mode and every
    fail-loud anchor;
  - with `SCAFFOLD_UI_DIR` set, against the pinned `stellar-scaffold/ui@2a5c5f8`, read-only. This checks that the
    checkout stays unchanged, `main.tsx` is the upstream file plus one first line, the upstream dependencies, scripts
    and `scaffold.yml` are kept verbatim, and the facts the overlay relies on (`envPrefix: "PUBLIC_"`,
    `StellarWalletsKit.init` at module load in `app-lib/wallet.ts`) still hold.

## Not yet shown (stated, not hidden)

- **No real `stellar scaffold init` → `npm install` → `build` → browser run.** That needs the `stellar-scaffold`
  binary and the published npm packages.
  - The tracker is **not on npm** yet. Until it is, the template must
    be assembled with `--tracker-tarball` (a tracker built for the live ingest hosts), or `npm install` fails.
  - `app/src/usagemap.ts` was type-checked (2026-11-19, `tsc` 7) against the real Stellar Wallets Kit 2.8.0 types,
    Vite 8 client types and the tracker 1.1.0 types, but not built or run in a browser.
- **Registration needs a control-plane change.** `addFootprintItem` accepts only a portal session (cookie + CSRF)
  today. Until it also accepts a scoped bearer key, an opted-in run is answered `401`, which the extension reports.
- Only the React template is covered (not `templates/svelte`). Windows `PATH` lookup of the npm `.cmd` shim by
  Scaffold has not been checked.
