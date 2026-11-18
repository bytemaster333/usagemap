// SPDX-License-Identifier: Apache-2.0
// UsageMap analytics for a Scaffold Stellar app. Imported FIRST in main.tsx:
// app-lib/wallet.ts copies `StellarWalletsKit.signTransaction` into an export
// when it is evaluated (wallet.ts:34 in stellar-scaffold/ui @ 2a5c5f8), so the
// adapter must wrap the kit before that module runs.
//
// Configuration is two PUBLIC_ variables (Vite `envPrefix: "PUBLIC_"` in the
// template's vite.config.ts). Without PUBLIC_USAGEMAP_SITE nothing loads, so a
// fresh `stellar scaffold init` works offline and sends nothing.
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit"
import { init } from "@usagemap/tracker"
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit"

const site = import.meta.env.PUBLIC_USAGEMAP_SITE as string | undefined
const consent = import.meta.env.PUBLIC_USAGEMAP_CONSENT === "required" ? "required" : undefined

export const usagemap = site ? init({ site, consent }) : undefined

if (usagemap) {
	// Wallet connect / sign / submit events with wallet type and network only:
	// never an address, transaction or amount (event schema v1).
	attachWalletsKit(StellarWalletsKit)
}

if (import.meta.env.DEV && site) {
	// Debug panel: why an event was or was not sent (GPC, dev origin, consent…).
	void import("@usagemap/tracker/debug")
}
