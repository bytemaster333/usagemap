# @usagemap/anchor-otel

OpenTelemetry metrics for the **wallet side** of Stellar anchor flows (SEP-1/6/10/12/24/31/38), through SDF's Wallet
SDK (`@stellar/typescript-wallet-sdk` 6.x) or any axios instance: each SEP step's latency and outcome class, and funnel
events (`authenticated`, `customer_needs_info`, `deposit_interactive_started`, `deposit_completed`, `withdraw_failed`,
…) per anchor **public home domain**.

Never an attribute: amounts, accounts, memos, KYC fields, tokens, transaction ids, URLs or query strings.

```ts
import { Wallet } from "@stellar/typescript-wallet-sdk";
import { instrumentWalletSdk } from "@usagemap/anchor-otel";

const wallet = Wallet.MainNet();
instrumentWalletSdk(wallet); // before wallet.anchor(…)
```

Metrics: `stellar.anchor.request.duration` (histogram, s) and `stellar.anchor.events` (counter). Attribute sets, the
SEP-31/plain-axios variant, options and the privacy rules: [docs/onboarding/anchors.md](../../docs/onboarding/anchors.md).

Tests: `pnpm --filter @usagemap/anchor-otel test` (real Wallet SDK 6.0.0 against an in-process anchor).
