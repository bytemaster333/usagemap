// SPDX-License-Identifier: Apache-2.0
// app/wallet.ts — the dApp's own Wallets Kit set-up (nothing analytics-specific here), written the way Scaffold
// Stellar's `src/util/wallet.ts` is: the kit's methods are re-exported as references copied when this module loads,
// i.e. before <Analytics/> attaches the adapter in its effect. The adapter still counts every signature made through
// them, because it observes the kit's wallet modules rather than these methods.
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";

export const signTransaction = StellarWalletsKit.signTransaction;
export const signMessage = StellarWalletsKit.signMessage;
export const disconnectWallet = StellarWalletsKit.disconnect;

let started = false;

/** Initialises the kit once, in the browser. */
export function startWallets(): typeof StellarWalletsKit {
  if (!started) {
    StellarWalletsKit.init({ modules: defaultModules(), network: Networks.TESTNET });
    started = true;
  }
  return StellarWalletsKit;
}
