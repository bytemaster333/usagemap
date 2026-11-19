// SPDX-License-Identifier: Apache-2.0
// The wallet side of an anchor flow with SDF's Wallet SDK: resolve the anchor's stellar.toml (SEP-1), authenticate
// (SEP-10), read SEP-24 info and start an interactive deposit. One line makes every step measurable in UsageMap
// (latency, outcome class, funnel event per anchor home domain); amounts, accounts, tokens and URLs are never sent.

import { Keypair } from "@stellar/stellar-sdk";
import { SigningKeypair, Wallet } from "@stellar/typescript-wallet-sdk";
import { instrumentWalletSdk } from "@usagemap/anchor-otel";
import { shutdown } from "./otel.mjs";

const HOME_DOMAIN = process.env.ANCHOR_HOME_DOMAIN ?? "testanchor.stellar.org";
const ASSET = process.env.ASSET_CODE ?? "SRT";

const wallet = Wallet.TestNet();
instrumentWalletSdk(wallet); // UsageMap: before wallet.anchor(…)

const anchor = wallet.anchor({
  homeDomain: HOME_DOMAIN,
  allowHttp: process.env.ALLOW_HTTP === "1",
});
const authToken = await (await anchor.sep10()).authenticate({
  accountKp: SigningKeypair.fromSecret(Keypair.random().secret()), // a throwaway testnet key
});
const info = await anchor.sep24().info();
console.log(`SEP-24 deposit of ${ASSET} enabled: ${info.deposit[ASSET]?.enabled === true}`);
const deposit = await anchor.sep24().deposit({ assetCode: ASSET, authToken });
console.log(`interactive deposit started (${deposit.type})`);

await shutdown(); // export now; a long-running backend exports every 60 s instead
