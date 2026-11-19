// SPDX-License-Identifier: Apache-2.0
// A vanilla dApp on Stellar Wallets Kit 2.8.0: connect in the kit's modal, sign a message, disconnect.
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { init } from "@usagemap/tracker";
import { attachWalletsKit, wrapWalletsKitModules } from "@usagemap/tracker/wallets-kit";

// UsageMap: page views, plus wallet events from the kit (wallet type and network only, never the address)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
StellarWalletsKit.init({
  modules: wrapWalletsKitModules(defaultModules()),
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
  $("sign").disabled = $("disconnect").disabled = false;
});
$("sign").onclick = step("sign", () =>
  StellarWalletsKit.signMessage("Sign in to the example dApp"),
);
$("disconnect").onclick = step("disconnect", async () => {
  await StellarWalletsKit.disconnect();
  $("sign").disabled = $("disconnect").disabled = true;
});
