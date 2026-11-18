// SPDX-License-Identifier: Apache-2.0
// UsageMap web + wallet analytics for this Scaffold Stellar app (see USAGEMAP.md).
//
// Imported FIRST in main.tsx, before anything that loads app-lib/wallet.ts:
// that module initialises Stellar Wallets Kit and copies its methods when it
// is evaluated. The adapter observes the kit's selected wallet module, so sign
// calls through those copied references are counted too.
//
// Configuration is one public variable in app/.env (Vite exposes PUBLIC_*):
//   PUBLIC_USAGEMAP_SITE=<22-character site key from the portal>
//   PUBLIC_USAGEMAP_CONSENT=required   (optional: send nothing until consent)
// Without PUBLIC_USAGEMAP_SITE nothing runs and nothing is sent.
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit"
import { init } from "@usagemap/tracker"
import { debug } from "@usagemap/tracker/debug"
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit"

const site = (
	import.meta.env.PUBLIC_USAGEMAP_SITE as string | undefined
)?.trim()
const consentRequired = import.meta.env.PUBLIC_USAGEMAP_CONSENT === "required"

if (import.meta.env.DEV && site) {
	// Debug panel, development only (removed from production builds): why an
	// event was or was not sent (GPC, dev origin, consent …). Must start first.
	debug()
}

export const usagemap = site
	? init(consentRequired ? { site, consent: "required" } : { site })
	: undefined

if (usagemap) {
	// Wallet modal, connect, sign and submit events with the wallet type and
	// network only: never an address, a transaction or an amount.
	attachWalletsKit(StellarWalletsKit)
}
