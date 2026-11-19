// SPDX-License-Identifier: Apache-2.0
// A vanilla dApp that calls Freighter directly (no Wallets Kit): connect, sign a message.

import * as freighterApi from "@stellar/freighter-api";
import { init } from "@usagemap/tracker";
import { wrapFreighter } from "@usagemap/tracker/wallets";

// UsageMap: page views, plus wallet events for every call made through the wrapped API
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
const freighter = wrapFreighter(freighterApi, {
  networkPassphrase: "Test SDF Network ; September 2015",
});

const $ = (id: string) => document.getElementById(id) as HTMLButtonElement;
const show = (text: string) => {
  $("log").textContent = text;
};

$("connect").onclick = async () => {
  const { address, error } = await freighter.requestAccess();
  show(error || !address ? "connect: failed" : "connect: ok");
  $("sign").disabled = !address;
};
$("sign").onclick = async () => {
  const { error } = await freighter.signMessage("Sign in to the example dApp", {
    networkPassphrase: "Test SDF Network ; September 2015",
  });
  show(error ? "sign: failed" : "sign: ok");
};
