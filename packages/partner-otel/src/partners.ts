// SPDX-License-Identifier: Apache-2.0
// The closed partner table: SCF Integration List building blocks with a public HTTP API (SCF handbook @ cf94e36,
// 2026-11-13), their official API hosts and their route templates. Sources (read 2026-11-19, no outside interaction):
// the partners' official npm SDKs (base-URL constants and route strings) and published API references:
//   soroswap        @soroswap/sdk 0.5.1 (MIT)              dist/soroswap-sdk.js          api.soroswap.finance (?network=)
//   defindex        @defindex/sdk 0.3.0 (MIT)              dist/defindex-sdk.js          api.defindex.io (?network=)
//   trustless_work  @trustless-work/escrow 3.0.5 (MIT)     dist/index.js                 api. / dev.api.trustlesswork.com
//   stellar_broker  @stellar-broker/client 0.8.0 (MIT)     src/client.js, src/estimate.js api.stellar.broker
//   etherfuse       api.etherfuse.com/openapi-v2.json (v2.0.0)                           api. / api.sand.etherfuse.com
//   alfredpay       alfredpay API reference 1.1.5 (sandbox host only; production host not yet published)
//   blindpay        @blindpay/node 6.2.1 (MIT)             dist/index.mjs                api.blindpay.com/v1
//   bridge          Bridge OpenAPI (apidocs.bridge.xyz)                                  api. / api.sandbox.bridge.xyz/v0
//   mercuryo        widget.docs.mercuryo.io API reference                                api.mercuryo.io / sandbox-api.mrcr.io
//   koywe           @koyweforest/cli 0.16.1 (MIT)          dist/core/config.js           api. / api-sandbox.koywe.com/api/v1
//   abroad          docs.abroad.finance API reference                                    api.abroad.finance
//   allbridge       @allbridge/bridge-core-sdk 3.38.0 (MIT) dist/src/configs/mainnet.js  api.core.allbridge.io
//   sodax           @sodax/sdk 2.2.0 (MIT)                 dist/index.cjs                api.sodax.com/v1
//   aquarius        docs.aqua.network backend API                                        amm-api(-testnet).aqua.network
// Not here: Blend and Reflector (no REST API: contracts only, measured on chain), MoneyGram and Anchor Platform
// anchors (SEP-10/24 — measured by @usagemap/anchor-otel), Axelar / CCTP / LayerZero / NEAR Intents / Sushiswap /
// Templar (no partner REST host verified). Adding a partner is a contract change: this file, the Collector's
// `partner.go` and wire-formats §f.5 step 4b together (TestPartnerTableMatchesPackage keeps them identical).
//
// The table is data, kept in one literal so the Collector's test can read it: `hosts` maps an exact API host to the
// environment it serves ("mainnet" = production, "testnet" = sandbox, "query" = one host for both, the
// `network` query parameter decides, "unknown" = cannot tell), `operations` are route templates. A request path
// matches a template when, after any prefix (a version such as `/v1`, `/api/external/v2`), its segments equal the
// template's, `{id}`/`{type}` matching any one segment; a literal match beats a placeholder.

export const PARTNERS = {
  soroswap: {
    hosts: { "api.soroswap.finance": "query" },
    operations: [
      "/quote",
      "/quote/build",
      "/send",
      "/pools",
      "/pools/{id}/{id}",
      "/liquidity/add",
      "/liquidity/remove",
      "/liquidity/positions/{id}",
      "/asset-list",
      "/price",
      "/balances/{id}",
      "/protocols",
      "/health",
    ],
  },
  defindex: {
    hosts: { "api.defindex.io": "query" },
    operations: [
      "/health",
      "/factory/address",
      "/factory/create-vault",
      "/factory/create-vault-deposit",
      "/vault/{id}",
      "/vault/{id}/balance",
      "/vault/{id}/apy",
      "/vault/{id}/report",
      "/vault/{id}/deposit",
      "/vault/{id}/withdraw",
      "/vault/{id}/withdraw-shares",
      "/vault/{id}/rebalance",
      "/send",
    ],
  },
  trustless_work: {
    hosts: { "api.trustlesswork.com": "mainnet", "dev.api.trustlesswork.com": "testnet" },
    operations: [
      "/deployer/{type}",
      "/escrow/{type}/update-escrow",
      "/escrow/{type}/fund-escrow",
      "/escrow/{type}/approve-milestone",
      "/escrow/{type}/change-milestone-status",
      "/escrow/{type}/release-funds",
      "/escrow/{type}/resolve-dispute",
      "/escrow/{type}/dispute-escrow",
      "/helper/get-escrows-by-signer",
      "/helper/get-escrows-by-role",
      "/helper/get-multiple-escrow-balance",
      "/helper/send-transaction",
      "/indexer/update-from-txHash",
    ],
  },
  stellar_broker: {
    hosts: { "api.stellar.broker": "mainnet" },
    operations: ["/quote"],
  },
  etherfuse: {
    hosts: { "api.etherfuse.com": "mainnet", "api.sand.etherfuse.com": "testnet" },
    operations: [
      "/organization",
      "/organization/{id}/quote",
      "/organization/{id}/order",
      "/organization/{id}/order/{id}",
      "/organization/{id}/order/{id}/cancel",
      "/organization/{id}/order/{id}/fiat_received",
      "/organization/{id}/payment_account",
      "/organization/{id}/payment_accounts",
      "/organization/{id}/kyc",
      "/orders",
      "/me",
      "/supported_assets",
    ],
  },
  alfredpay: {
    hosts: { "api.sandbox.alfredpay.io": "testnet" },
    operations: [
      "/customers",
      "/customers/{id}",
      "/customers/{id}/quotes",
      "/quotes",
      "/conversions",
      "/conversions/{id}",
      "/payouts/fiat",
      "/payouts/fiat/{id}",
      "/linked_accounts",
      "/balances",
      "/countries/{id}",
      "/countries/{id}/banks",
    ],
  },
  blindpay: {
    hosts: { "api.blindpay.com": "unknown" },
    operations: [
      "/quotes",
      "/payouts",
      "/payouts/{id}",
      "/payouts/stellar",
      "/payouts/stellar/authorize",
      "/payin-quotes",
      "/payins",
      "/payins/{id}",
      "/customers",
      "/customers/{id}",
      "/customers/{id}/bank-accounts",
      "/customers/{id}/blockchain-wallets",
      "/transfers",
      "/webhook-endpoints",
      "/create-asset-trustline",
    ],
  },
  bridge: {
    hosts: { "api.bridge.xyz": "mainnet", "api.sandbox.bridge.xyz": "testnet" },
    operations: [
      "/customers",
      "/customers/{id}",
      "/customers/{id}/kyc_link",
      "/customers/tos_links",
      "/customers/{id}/external_accounts",
      "/customers/{id}/liquidation_addresses",
      "/customers/{id}/liquidation_addresses/{id}/drains",
      "/customers/{id}/virtual_accounts",
      "/transfers",
      "/transfers/{id}",
      "/wallets",
    ],
  },
  mercuryo: {
    hosts: { "api.mercuryo.io": "mainnet", "sandbox-api.mrcr.io": "testnet" },
    operations: [
      "/lib/currencies",
      "/widget/buy/rate",
      "/widget/sell/rate",
      "/public/rates",
      "/public/convert",
      "/public/currencies-buy",
      "/public/currency-limits",
      "/sdk-partner/sign-up",
      "/sdk-partner/user/sign-in",
      "/sdk-partner/user/kyc-status",
      "/sdk-partner/transactions",
    ],
  },
  koywe: {
    hosts: { "api.koywe.com": "mainnet", "api-sandbox.koywe.com": "testnet" },
    operations: [
      "/auth/sign-in",
      "/auth/me",
      "/organizations/{id}",
      "/organizations/{id}/merchants/{id}/quotes",
      "/organizations/{id}/webhooks",
      "/quotes/{id}",
      "/orders",
      "/orders/{id}",
      "/deals",
      "/deals/{id}/confirm",
      "/accounts",
      "/contacts/{id}/accounts",
      "/virtual-accounts",
    ],
  },
  abroad: {
    hosts: { "api.abroad.finance": "mainnet" },
    operations: [
      "/quote",
      "/quote/reverse",
      "/quote/onramp",
      "/transaction",
      "/transaction/{id}",
      "/transactions/list",
      "/kyc",
      "/kyc/status",
      "/payments/banks",
      "/payments/liquidity",
      "/payments/notify",
      "/public/corridors",
    ],
  },
  allbridge: {
    hosts: { "api.core.allbridge.io": "mainnet" },
    operations: [
      "/token-info",
      "/chain/{id}/{id}",
      "/check/{id}/{id}",
      "/receive-fee",
      "/near-intents/quote",
      "/near-intents/deposit",
      "/near-intents/deposit/submit",
      "/lifi-intents/quote",
      "/lifi-intents/order",
    ],
  },
  sodax: {
    hosts: { "api.sodax.com": "mainnet" },
    operations: [
      "/swaps/quote",
      "/swaps/tokens",
      "/swaps/intents",
      "/swaps/intents/{id}",
      "/swaps/intents/submit",
      "/swaps/intents/status",
      "/swaps/submit-tx",
      "/bridge/tokens",
      "/bridge/fee",
      "/bridge/submit-tx",
      "/sponsorships/stellar/config",
      "/sponsorships/stellar/accounts",
      "/intent/{id}",
      "/intent/user/{id}",
    ],
  },
  aquarius: {
    hosts: { "amm-api.aqua.network": "mainnet", "amm-api-testnet.aqua.network": "testnet" },
    operations: [
      "/find-path",
      "/find-path-strict-receive",
      "/pools",
      "/pools/user/{id}",
      "/statistics/totals",
      "/statistics/all-time",
    ],
  },
} as const;

export type Partner = keyof typeof PARTNERS;
export const PARTNER_IDS = Object.keys(PARTNERS) as Partner[];
