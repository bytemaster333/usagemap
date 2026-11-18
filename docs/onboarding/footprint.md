# Register your footprint

Your **footprint** is the list of Stellar identifiers your project owns: the contracts it deployed (and, later,
its issuing and app accounts). The platform uses it to count your on-chain usage next to your web and API
numbers: daily contract invocations, successful invocations and distinct invokers, read from public ledger data.

It is a required setup step: declare at least one contract, or state that your project has no on-chain footprint
(for example a developer tool). The setup wizard does not finish until you do one or the other; your analytics work
either way.

## Only what your project controls

Declare only identifiers your project controls, **never a user's address**. The platform never collects a visitor's
address; the only Stellar addresses it stores are the ones a project declares as its own. A declared item is a
*claim* until it is proven. An item that cannot be proven is marked `rejected`, is never used, and is deleted 30
days later.

## Step by step (contracts)

1. Prove that a Stellar account belongs to your project (portal: **Verification** → **Stellar account**: sign a
   challenge with the account, as at sign-in). This is the account that deployed your contracts or administers them.
2. Portal: **Footprint** → **Add contract**: the contract ID (`C…`), the network (mainnet or testnet), an optional
   label, and optionally the API service it belongs to.
3. The platform checks the ledger: the item becomes `verified` when the contract's **deployer or current admin** is
   a Stellar account your project has proven. It usually takes a few minutes; you can ask for an immediate check.
4. Only `verified` contracts are counted. Testnet and mainnet are counted separately.

| Status | Meaning |
|---|---|
| `claimed` | declared, not yet checked |
| `verified` | the ledger shows the deployer or admin is one of your proven accounts; re-checked weekly |
| `rejected` | the check failed (`not_deployer_or_admin`, `not_found_on_ledger`, `claimed_by_other_tenant`); not used; deleted after 30 days |
| in conflict | the same contract is verified for two projects; it is counted for neither until an SCF operator resolves it |

## Accounts and WASM hashes

Issuing accounts, app or treasury accounts and WASM hashes of factory products can be declared in a later release.
Until then the portal does not accept them, and nothing counts them. When they arrive, an account is verified only if
it is listed in your verified domain's `stellar.toml` **and** its own `home_domain` on the ledger is that domain, or if
its signers sign a challenge; a WASM hash will only filter which contract instances count (instances created by your
verified deployer or factory), never count by itself.

## No footprint

Portal: **Footprint** → "This project has no on-chain footprint". You can add contracts at any time later.

## Register from your deploy script (Scaffold Stellar)

A **footprint registration key** (`scfa_reg_…`) lets a build tool add a freshly deployed contract as a `claimed`
footprint item, and nothing else: it cannot verify, remove or read anything. Create one on the Footprint page (admin or
owner; at most five; optionally limited to `mainnet` or `testnet`). The Scaffold Stellar extension
(`templates/scaffold-stellar`) uses it after each deploy when `register: true` (or `USAGEMAP_REGISTER=1`) is set and
`SCF_FOOTPRINT_KEY` and `USAGEMAP_TENANT_ID` are present; otherwise it prints the request as a dry run. You still verify
the contract as above. The key stops working when you revoke it or when its creator is no longer an admin or owner.

## Protocols your users interact with

Once a contract is verified, the **Protocols** page (`/t/<project>/protocols`) shows per day how many of the
transactions that touch your contracts also touch Blend, Soroswap, DeFindex, Aquarius or Reflector. The figures come
from the public ledger and are exact counts, but **lower bounds**: contracts a protocol creates at run time and our
curated registry does not list are not seen. Only the protocol name is kept — no account, no other contract. These
figures are for you; SCF operators see them per registry project, never on a public page.

## What SCF sees

SCF operators see your footprint items with their status. Your on-chain counts appear in traction snapshots (when
you have at least one verified contract and on-chain correlation is on) and in programme cohorts only as sums over at
least five projects. See the [methodology](../methodology/scf-methodology-1.0.0.md#on-chain-figures).
