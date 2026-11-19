// SPDX-License-Identifier: Apache-2.0
// The demo cohort: synthetic projects shaped on the SCF award mix (390 awards;
// summarised in README.md): payments-heavy, about 80 % with a website and 45 % with an API, the five SCF
// categories, rounds #30–#45 weighted to recent rounds, award stages. The structural facts (which project has a website,
// an API, contracts, which cohort it falls in) are fixed in the table below so the shares and cohort sizes are exact;
// volumes and noise come from the seed phrase. Names are invented and never those of real projects; every slug starts
// with `demo-` and every name with `DEMO · `.

import { logUniform, type Rng, rngFor } from "./random.ts";
import { demoContractId } from "./stellar.ts";

export const DEMO_SLUG_PREFIX = "demo-";
export const DEMO_NAME_PREFIX = "DEMO · ";
export const DEMO_DESCRIPTION =
  "Synthetic demo data for the guided demo. Not a real project; every figure is generated.";
export const DEFAULT_PHRASE = "scf-analytics demo seed v1 — not a real key";

export type Category =
  | "end_user_application"
  | "financial_protocols"
  | "applications"
  | "developer_tooling"
  | "infrastructure_services";
export type Stage = "t0_prelaunch" | "t1_mvp" | "t2_testnet" | "t3_mainnet";
export type Product =
  | "payments"
  | "api_sdk"
  | "defi"
  | "web_dapp"
  | "infrastructure"
  | "wallet"
  | "rwa"
  | "marketplace";
export type Level = "L1" | "L2" | "L3" | "L4";
export type Anomaly = "spike" | "suspect_high" | null;
export type ApiKind = "horizon" | "rpc" | "rest" | "x402";

export interface WebsitePlan {
  name: string;
  host: string;
  /** typical daily unique visitors at the end of the history */
  baseVisitors: number;
  /** relative growth over the history (0.3 = +30 %) */
  growth: number;
  /** share of sessions that are suspect on an ordinary day */
  suspectShare: number;
  /** the site has a wallet flow (Stellar event schema v1 counts) */
  wallet: boolean;
  /** share of wallet events on testnet */
  testnetShare: number;
  anomaly: Anomaly;
  paths: string[];
}

export interface ApiPlan {
  serviceName: string;
  displayName: string;
  baseUrl: string;
  kind: ApiKind;
  /** typical daily requests */
  baseRequests: number;
  errorRate5xx: number;
  assurance: 0 | 1 | 2;
}

export interface ContractPlan {
  contractId: string;
  network: "public" | "testnet";
  label: string;
  verified: boolean;
  /** typical daily invocations */
  baseInvocations: number;
}

export interface TenantPlan {
  index: number;
  slug: string;
  name: string;
  description: string;
  product: Product;
  categories: Category[];
  round: number;
  stage: Stage;
  level: Level;
  /** a confirmed registry link exists (L3 and L4 only), so the project is in the SCF cohorts */
  registryLinked: boolean;
  website: WebsitePlan | null;
  api: ApiPlan | null;
  contracts: ContractPlan[];
  publicStats: boolean;
  sealEnabled: boolean;
  onchainEnabled: boolean;
  /** create a signed-snapshot request (v2 preset) through the API */
  snapshotPreset: "build_tranche" | "pg_renewal_quarter" | null;
}

interface Row {
  word: string;
  suffix: string;
  product: Product;
  cat: Category[];
  round: number;
  stage: Stage;
  level: Level;
  web: boolean;
  api: ApiKind | null;
  contracts: number;
  anomaly?: Anomaly;
  wallet?: boolean;
}

// 20 projects. Linked (L3/L4) projects form the cohorts: categories end_user_application 6 and financial_protocols 5
// are shown (≥ cohort_min_tenants = 5), the others suppressed; rounds #44 and #45 have 5 each, older rounds fewer;
// six end-user applications have verified contracts, so that cohort also shows on-chain figures.
const TABLE: Row[] = [
  // payments, anchors and ramps (the largest product group in the award data)
  {
    word: "Alder",
    suffix: "Remit",
    product: "payments",
    cat: ["end_user_application"],
    round: 45,
    stage: "t3_mainnet",
    level: "L3",
    web: true,
    api: "rest",
    contracts: 1,
    wallet: true,
    anomaly: "spike",
  },
  {
    word: "Basalt",
    suffix: "Ramp",
    product: "payments",
    cat: ["financial_protocols"],
    round: 44,
    stage: "t3_mainnet",
    level: "L3",
    web: true,
    api: "horizon",
    contracts: 0,
    wallet: true,
  },
  {
    word: "Cobalt",
    suffix: "Payroll",
    product: "payments",
    cat: ["end_user_application"],
    round: 44,
    stage: "t2_testnet",
    level: "L3",
    web: true,
    api: null,
    contracts: 1,
    wallet: true,
  },
  {
    word: "Driftwood",
    suffix: "Anchor",
    product: "payments",
    cat: ["financial_protocols"],
    round: 45,
    stage: "t3_mainnet",
    level: "L4",
    web: true,
    api: "rest",
    contracts: 0,
  },
  {
    word: "Ember",
    suffix: "Invoices",
    product: "payments",
    cat: ["end_user_application"],
    round: 42,
    stage: "t3_mainnet",
    level: "L3",
    web: true,
    api: null,
    contracts: 1,
    wallet: true,
  },
  {
    word: "Fjord",
    suffix: "Cashout",
    product: "payments",
    cat: ["applications"],
    round: 37,
    stage: "t1_mvp",
    level: "L2",
    web: true,
    api: null,
    contracts: 0,
    wallet: true,
  },
  // API, SDK and developer tooling
  {
    word: "Garnet",
    suffix: "Indexer API",
    product: "api_sdk",
    cat: ["developer_tooling"],
    round: 44,
    stage: "t3_mainnet",
    level: "L3",
    web: false,
    api: "rpc",
    contracts: 0,
  },
  {
    word: "Heron",
    suffix: "SDK",
    product: "api_sdk",
    cat: ["developer_tooling"],
    round: 40,
    stage: "t2_testnet",
    level: "L3",
    web: true,
    api: "rest",
    contracts: 0,
  },
  {
    word: "Indigo",
    suffix: "Pay-per-call",
    product: "api_sdk",
    cat: ["infrastructure_services"],
    round: 45,
    stage: "t2_testnet",
    level: "L3",
    web: false,
    api: "x402",
    contracts: 1,
  },
  {
    word: "Juniper",
    suffix: "Price Feed",
    product: "api_sdk",
    cat: ["applications"],
    round: 31,
    stage: "t3_mainnet",
    level: "L1",
    web: false,
    api: "rest",
    contracts: 0,
  },
  // DeFi
  {
    word: "Kestrel",
    suffix: "Swap",
    product: "defi",
    cat: ["financial_protocols"],
    round: 45,
    stage: "t3_mainnet",
    level: "L3",
    web: true,
    api: null,
    contracts: 2,
    wallet: true,
    anomaly: "suspect_high",
  },
  {
    word: "Larch",
    suffix: "Lending",
    product: "defi",
    cat: ["financial_protocols"],
    round: 44,
    stage: "t2_testnet",
    level: "L3",
    web: true,
    api: null,
    contracts: 2,
    wallet: true,
  },
  {
    word: "Marigold",
    suffix: "Vaults",
    product: "defi",
    cat: ["financial_protocols"],
    round: 42,
    stage: "t1_mvp",
    level: "L3",
    web: true,
    api: null,
    contracts: 1,
    wallet: true,
  },
  // web dApps, wallets, RWA, marketplace, infrastructure
  {
    word: "Nimbus",
    suffix: "Quests",
    product: "web_dapp",
    cat: ["end_user_application"],
    round: 45,
    stage: "t2_testnet",
    level: "L3",
    web: true,
    api: null,
    contracts: 1,
    wallet: true,
  },
  {
    word: "Obsidian",
    suffix: "Wallet",
    product: "wallet",
    cat: ["end_user_application"],
    round: 44,
    stage: "t3_mainnet",
    level: "L4",
    web: true,
    api: null,
    contracts: 1,
    wallet: true,
  },
  {
    word: "Pelican",
    suffix: "Passkeys",
    product: "wallet",
    cat: ["end_user_application"],
    round: 35,
    stage: "t3_mainnet",
    level: "L3",
    web: true,
    api: null,
    contracts: 1,
    wallet: true,
  },
  {
    word: "Quartz",
    suffix: "Deeds",
    product: "rwa",
    cat: ["applications"],
    round: 40,
    stage: "t1_mvp",
    level: "L3",
    web: true,
    api: null,
    contracts: 1,
    wallet: true,
  },
  {
    word: "Rowan",
    suffix: "Market",
    product: "marketplace",
    cat: ["applications"],
    round: 33,
    stage: "t0_prelaunch",
    level: "L1",
    web: true,
    api: null,
    contracts: 0,
  },
  {
    word: "Sorrel",
    suffix: "Node Hosting",
    product: "infrastructure",
    cat: ["infrastructure_services"],
    round: 37,
    stage: "t3_mainnet",
    level: "L2",
    web: false,
    api: "horizon",
    contracts: 0,
  },
  {
    word: "Tamarack",
    suffix: "Explorer",
    product: "infrastructure",
    cat: ["developer_tooling"],
    round: 30,
    stage: "t3_mainnet",
    level: "L3",
    web: true,
    api: "rest",
    contracts: 0,
  },
];

const PATHS: Record<Product, string[]> = {
  payments: ["/", "/send", "/receive", "/pricing", "/help", "/account", "/tx/{tx_hash}", "/fx"],
  api_sdk: [
    "/",
    "/docs",
    "/docs/quickstart",
    "/docs/reference",
    "/pricing",
    "/status",
    "/changelog",
  ],
  defi: ["/", "/swap", "/pools", "/pools/{id}", "/portfolio", "/docs", "/governance"],
  web_dapp: ["/", "/quests", "/quests/{id}", "/leaderboard", "/profile", "/about"],
  infrastructure: ["/", "/docs", "/status", "/pricing", "/network", "/ledger/{ledger}"],
  wallet: ["/", "/download", "/onboarding", "/security", "/help", "/assets"],
  rwa: ["/", "/listings", "/listings/{id}", "/verify", "/about", "/faq"],
  marketplace: ["/", "/browse", "/item/{id}", "/sell", "/about"],
};

const slugOf = (r: Row) =>
  `${DEMO_SLUG_PREFIX}${`${r.word}-${r.suffix}`.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(
    0,
    40,
  );

function websiteFor(r: Row, slug: string, rng: Rng): WebsitePlan | null {
  if (!r.web) return null;
  const stageBoost = { t0_prelaunch: 0.3, t1_mvp: 0.6, t2_testnet: 1, t3_mainnet: 1.6 }[r.stage];
  return {
    name: `${r.word} ${r.suffix} web`,
    host: `${slug.slice(DEMO_SLUG_PREFIX.length)}.demo.invalid`,
    baseVisitors: Math.round(logUniform(rng, 120, 2200) * stageBoost),
    growth: 0.1 + rng() * 0.6,
    suspectShare: r.anomaly === "suspect_high" ? 0.5 : 0.03 + rng() * 0.05,
    wallet: r.wallet === true,
    testnetShare: r.stage === "t3_mainnet" ? 0.08 + rng() * 0.1 : 0.85,
    anomaly: r.anomaly ?? null,
    paths: PATHS[r.product],
  };
}

function apiFor(r: Row, slug: string, rng: Rng): ApiPlan | null {
  if (!r.api) return null;
  const short = slug.slice(DEMO_SLUG_PREFIX.length);
  return {
    serviceName: `${short}-api`,
    displayName: `${r.word} ${r.suffix} API`,
    baseUrl: `https://api.${short}.demo.invalid`,
    kind: r.api,
    baseRequests: Math.round(logUniform(rng, 4000, 160000)),
    errorRate5xx: 0.002 + rng() * 0.01,
    assurance: r.level === "L1" ? 0 : r.level === "L2" ? 1 : 2,
  };
}

/** The whole demo cohort for a seed phrase. Pure and deterministic. */
export function buildPlan(phrase: string = DEFAULT_PHRASE): TenantPlan[] {
  return TABLE.map((r, index) => {
    const rng = rngFor(phrase, `tenant:${index}`);
    const slug = slugOf(r);
    const contracts: ContractPlan[] = Array.from({ length: r.contracts }, (_, i) => {
      const testnet = r.stage === "t1_mvp" || r.stage === "t2_testnet" || i === 1;
      return {
        contractId: demoContractId(phrase, `${slug}:${i}`),
        network: testnet ? "testnet" : "public",
        label: i === 0 ? "main contract" : "test deployment",
        // one contract stays claimed (not verified) to show that state
        verified: !(r.word === "Marigold"),
        baseInvocations: Math.round(logUniform(rng, 60, 4000)),
      };
    });
    const linked = r.level === "L3" || r.level === "L4";
    return {
      index,
      slug,
      name: `${DEMO_NAME_PREFIX}${r.word} ${r.suffix}`,
      description: DEMO_DESCRIPTION,
      product: r.product,
      categories: r.cat,
      round: r.round,
      stage: r.stage,
      level: r.level,
      registryLinked: linked,
      website: websiteFor(r, slug, rng),
      api: apiFor(r, slug, rng),
      contracts,
      publicStats: index % 3 === 0 || r.anomaly === "spike",
      sealEnabled: index % 2 === 0,
      onchainEnabled: contracts.length > 0,
      snapshotPreset: index === 0 ? "build_tranche" : index === 3 ? "pg_renewal_quarter" : null,
    };
  });
}

/** Cohort sizes over the registry-linked projects (what scf.op_cohorts groups by). */
export function cohortSizes(plan: TenantPlan[], by: "round" | "category" | "award_stage") {
  const out = new Map<string, number>();
  for (const t of plan.filter((x) => x.registryLinked)) {
    const keys =
      by === "round" ? [String(t.round)] : by === "award_stage" ? [t.stage] : t.categories;
    for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}
