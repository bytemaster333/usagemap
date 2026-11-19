// SPDX-License-Identifier: Apache-2.0
// A vanilla dApp that connects mobile wallets through WalletConnect, using Stellar Wallets Kit's WalletConnect module.
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import {
  WalletConnectModule,
  WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import { init } from "@usagemap/tracker";
import { attachWalletsKit, wrapWalletsKitModules } from "@usagemap/tracker/wallets-kit";

const walletConnect = new WalletConnectModule({
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "", // cloud.reown.com → your project
  metadata: {
    name: "UsageMap example",
    description: "WalletConnect example",
    url: location.origin,
    icons: [],
  },
  allowedChains: [WalletConnectTargetChain.TESTNET],
});

// UsageMap: page views, wallet events and the WalletConnect funnel (session proposed → approved | rejected)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
StellarWalletsKit.init({
  modules: wrapWalletsKitModules([walletConnect]),
  network: Networks.TESTNET,
});
attachWalletsKit(StellarWalletsKit);

const $ = (id: string) => document.getElementById(id) as HTMLButtonElement;
const step = (name: string, f: () => Promise<unknown>) => async () => {
  try {
    await f();
    $("log").textContent = `${name}: ok`;
  } catch {
    $("log").textContent = `${name}: failed`;
  }
};

$("connect").onclick = step("connect", async () => {
  await StellarWalletsKit.authModal();
  $("sign").disabled = false;
});
$("sign").onclick = step("sign", () =>
  StellarWalletsKit.signMessage("Sign in to the example dApp"),
);
