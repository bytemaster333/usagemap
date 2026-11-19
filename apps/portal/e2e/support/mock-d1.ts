// SPDX-License-Identifier: Apache-2.0
// Mock control plane, part 3: the usage, trust and snapshot endpoints (C-136, C-137) — trust scores and annotations, on-chain daily
// counts, API assurance, the first-event panel (dev events, dev origins, debug mode), the wallet funnel, the Registered
// Footprint (contracts), traction snapshots v2 with their public series list, the daily seal (proofs and days, built
// here with a real RFC 9162 tree over real snapshot hashes, including a testnet reset between two segments) and the
// operator cohorts. Rules followed where the portal depends on them: tenant scoping with indistinguishable 404s, the
// seal's 404 until a snapshot is sealed or when its tenant did not opt in, the cohort floor (suppressed cohorts, null
// figures below the small-count floor), and the snapshot series (numbered when signed, previous hash linked). Every
// JSON body is validated against the OpenAPI document by mock-server.ts.
// The Merkle code here is written independently of the portal's src/lib/seal.ts (node:crypto), so the browser
// verifier is not checked against itself; both are pinned to docs/contracts/vectors/seal-v1.json by the unit tests.

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import { snapshotBodyV3 } from "./mock-evidence.ts";
import { jcs, signSnapshot } from "./mock-programme.ts";

type Json = Record<string, unknown>;
type TenantRow = ControlPlane.Tenant & { members: Map<string, ControlPlane.TenantRole> };
type SiteRow = ControlPlane.Site & { tenantId: string };

export interface Answer {
  status: number;
  body?: unknown;
  type?: string;
}
type Handler = (c: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
  body: Json;
}) => Answer;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const sha = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hex = (b: Buffer) => b.toString("hex");
const ascii = (s: string) => Buffer.from(s, "ascii");

export const D1 = {
  docs: "a0000000-0000-4000-8000-000000000001",
  swap: "a0000000-0000-4000-8000-000000000003",
  docsSite: "b0000000-0000-4000-8000-000000000001",
  walletSite: "b0000000-0000-4000-8000-000000000002",
  horizonSvc: "d0000000-0000-4000-8000-000000000001",
  rpcSvc: "d0000000-0000-4000-8000-000000000002",
  /** Stellar Docs, series 1: build tranche, sealed on 2026-11-10 (testnet, since reset) */
  snap1: "d5100000-0000-4000-8000-000000000001",
  /** Stellar Docs, series 2: PG renewal quarter, sealed on 2026-11-12 (testnet, segment 2, confirmed) */
  snap2: "d5100000-0000-4000-8000-000000000002",
  /** Soroban Swap, series 1 and 3 — number 2 is missing from its list (a gap) */
  swap1: "d5200000-0000-4000-8000-000000000001",
  swap3: "d5200000-0000-4000-8000-000000000003",
  /** the mock's sealing transaction of 2026-11-12 */
  tx1112: "7a".repeat(32),
  tx1113: "7b".repeat(32),
  ledger1112: 1200,
  ledger1113: 18500,
} as const;

// --- Stellar strkey (for the sealing account and contract ids) ---

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
export function strKey(version: number, payload: Buffer): string {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const c = Buffer.alloc(2);
  c.writeUInt16LE(crc16(body));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of Buffer.concat([body, c])) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export const SEAL_ACCOUNT = strKey(6 << 3, sha(ascii("mock sealing account")));
export const contractId = (label: string) => strKey(2 << 3, sha(ascii(`contract ${label}`)));
export const CONTRACTS = {
  router: contractId("router"),
  routerTest: contractId("router-test"),
  vault: contractId("vault"),
  shared: contractId("shared"),
} as const;

// --- RFC 9162 tree (independent of src/lib/seal.ts) ---

const leafHash = (data: Buffer) => sha(Buffer.from([0]), data);
const nodeHash = (l: Buffer, r: Buffer) => sha(Buffer.from([1]), l, r);
const split = (n: number) => {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
};
function mth(h: Buffer[]): Buffer {
  if (h.length === 1) return h[0] as Buffer;
  const k = split(h.length);
  return nodeHash(mth(h.slice(0, k)), mth(h.slice(k)));
}
function path(m: number, h: Buffer[]): Buffer[] {
  if (h.length <= 1) return [];
  const k = split(h.length);
  return m < k
    ? [...path(m, h.slice(0, k)), mth(h.slice(k))]
    : [...path(m - k, h.slice(k)), mth(h.slice(0, k))];
}
const chainData = (network: string, day: string, prev: Buffer) =>
  Buffer.concat([
    ascii("scf-seal/1 chain"),
    Buffer.from([0]),
    ascii(network),
    Buffer.from([0]),
    ascii(day),
    prev,
  ]);
const auditData = (day: string, anchor: Buffer) =>
  Buffer.concat([ascii("scf-seal/1 audit"), Buffer.from([0]), ascii(day), anchor]);
const snapshotData = (salt: Buffer, id: string, h: Buffer) =>
  Buffer.concat([
    ascii("scf-seal/1 snapshot"),
    Buffer.from([0]),
    salt,
    Buffer.from(id.replaceAll("-", ""), "hex"),
    h,
  ]);

export const TESTNET_NOTICE =
  "Stellar testnet is reset several times a year; this seal is a demonstration, not durable evidence.";
export const STATEMENT =
  "Tamper-evidence of a published snapshot. It does not show that the numbers are genuine.";
export const SEAL_NETWORK: ControlPlane.SealNetwork = {
  name: "testnet",
  passphrase: "Test SDF Network ; September 2015",
  durable: false,
  notice: TESTNET_NOTICE,
  lookup: {
    horizon: "https://horizon-testnet.stellar.org",
    explorer: "https://stellar.expert/explorer/testnet/tx/{tx_hash}",
    ledger_files:
      "https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/testnet/2026-11-11",
  },
};

// --- traction snapshot v2 (wire-formats §i.3.2, §i.3.4) ---

type Preset = NonNullable<ControlPlane.TractionSnapshotCreate["preset"]>;
const PRESET_LABEL: Record<Preset, string> = {
  build_tranche: "SCF Build tranche",
  growth_hack_before: "before Growth Hack campaign",
  growth_hack_during: "during Growth Hack campaign",
  pg_renewal_quarter: "Public Goods renewal quarter",
  custom: "custom period",
};
const INT = new Intl.NumberFormat("en-US");
const pct = (x: number) => (x * 100).toFixed(1);

export interface SnapInput {
  id: string;
  tenant: { slug: string; name: string; verification_level: string };
  start: string;
  end: string;
  preset: Preset;
  seq: number;
  previous: string | null;
  issuedAt: string;
  sealEnabled: boolean;
  onchain: boolean;
}

export function snapshotBodyV2(s: SnapInput): Record<string, unknown> {
  const days = Math.round((Date.parse(s.end) - Date.parse(s.start)) / DAY);
  const base = "https://portal.example.invalid";
  const web = {
    verified: { pageviews: 48213, visitors_sum: 9118 },
    raw: { pageviews: 51034, visitors_sum: 9802 },
    visit_metrics: {
      visits: 12010,
      bounces: 5044,
      bounce_rate_pct: 42.0,
      avg_visit_duration_s: 91.5,
      suspect_pageview_share: 0.0553,
    },
    weekly: [
      {
        start: s.start,
        days: 7,
        pageviews_verified: 3710,
        pageviews_raw: 3925,
        visitors_sum_verified: 701,
      },
    ],
  };
  const api = {
    label: "self-attested telemetry",
    requests: 1204513,
    error_rate_5xx: 0.0031,
    p95_ms: 182.0,
    accuracy_class: "exp3",
    assurance_level: "A2",
    onchain_consistent: "consistent",
    weekly: [{ start: s.start, days: 7, requests: 92655 }],
  };
  const onchain = s.onchain
    ? {
        network: "mainnet",
        data_source: "ledger_files",
        verified_contracts: 1,
        invocations: 4820,
        successful_invocations: 4675,
        distinct_invokers_daily_sum: 1130,
        daily: [
          {
            day: s.start.slice(0, 10),
            invocations: 52,
            successful_invocations: 50,
            distinct_invokers: 14,
          },
        ],
        weekly: [
          {
            start: s.start,
            days: 7,
            invocations: 371,
            successful_invocations: 360,
            distinct_invokers_daily_sum: 87,
          },
        ],
      }
    : null;
  const confidence = { level: "medium", reasons: ["open_anomaly_flags"] };
  const anomaly = { open_web: 1, open_api: 0 };
  const links = {
    verify: `${base}/verify?snapshot=${s.id}`,
    public_list: `${base}/public/v1/projects/${s.tenant.slug}/snapshots`,
    definitions: `${base}/docs/metric-definitions/1`,
  };
  const lastDay = new Date(Date.parse(s.end) - DAY).toISOString().slice(0, 10);
  const text = [
    `${s.tenant.name} — measured usage, ${s.start.slice(0, 10)} to ${lastDay} (${days} days, ${PRESET_LABEL[s.preset]})`,
    `Snapshot ${s.seq} of this project (all are listed at the link below)`,
    `Web: ${INT.format(web.verified.pageviews)} verified page views (${INT.format(web.raw.pageviews)} raw; ${pct(web.visit_metrics.suspect_pageview_share)}% suspect); ${INT.format(web.verified.visitors_sum)} daily visitors (sum)`,
    `API (self-attested telemetry): ${INT.format(api.requests)} requests; 5xx ${pct(api.error_rate_5xx)}%; p95 ${api.p95_ms} ms; assurance ${api.assurance_level}`,
    ...(onchain
      ? [
          `On-chain (mainnet, 1 verified contracts): ${INT.format(onchain.invocations)} invocations, ${pct(onchain.successful_invocations / onchain.invocations)}% successful, ${INT.format(onchain.distinct_invokers_daily_sum)} daily invokers (sum)`,
        ]
      : []),
    `Coverage: ${days}/${days} days with web events; confidence medium: open anomaly flags`,
    `Open anomaly flags: web ${anomaly.open_web}, API ${anomaly.open_api}`,
    `Measured by portal.example.invalid (methodology scf-methodology/1.0.0). "Verified" means passed our bot checks, not endorsed by SCF or SDF.`,
    `Verify: ${links.verify}   All snapshots of this project: ${links.public_list}`,
  ].join("\n");
  return {
    schema: "scf-analytics/traction-snapshot/2",
    snapshot_id: s.id,
    issued_at: s.issuedAt,
    issuer: "portal.example.invalid",
    project: {
      slug: s.tenant.slug,
      name: s.tenant.name,
      verification_level: s.tenant.verification_level,
      registry_matches: ["stellarlight"],
    },
    series: { seq: s.seq, previous_sha256: s.previous },
    period: { start: s.start, end: s.end, days },
    preset: s.preset,
    methodology: { version: "scf-methodology/1.0.0", url: `${base}/docs/methodology/1.0.0` },
    web,
    api,
    onchain,
    coverage: {
      days_in_period: days,
      web_days_with_events: days,
      web_days_final: days,
      api_days_with_data: days,
      onchain_days_complete: onchain ? days : null,
    },
    confidence,
    anomaly_flags: anomaly,
    seal: {
      enabled: s.sealEnabled,
      network: s.sealEnabled ? "testnet" : null,
      proof_url: s.sealEnabled ? `${base}/public/v1/snapshots/${s.id}/seal` : null,
    },
    links,
    text,
  };
}

// --- state ---

export interface SnapshotRow extends ControlPlane.TractionSnapshotSummary {
  tenantId: string;
  polls: number;
  seq?: number;
  previous_sha256?: string | null;
  sha256?: string;
  signed_at?: string;
  doc?: {
    snapshot: Record<string, unknown>;
    signature: { alg: "Ed25519"; kid: string; sig: string };
  };
}

export interface D1State {
  trust: Map<string, ControlPlane.TrustScore[]>;
  annotations: (ControlPlane.Annotation & { tenantId: string })[];
  onchain: Map<string, ControlPlane.OnchainDay[]>;
  footprint: (ControlPlane.FootprintItem & { tenantId: string })[];
  devEvents: Map<string, ControlPlane.DevEvent[]>;
  sealDays: ControlPlane.SealDay[];
  proofs: Map<string, ControlPlane.SealProof[]>;
  /** the sealed audit-anchor documents by day (migration 0077) */
  anchors: Map<string, ControlPlane.AuditAnchorDocument>;
}

const component = (p: number, value: number, explanation: string, eco: number | null = null) => ({
  p,
  value,
  eco_percentile: eco,
  explanation,
});

function seedTrust(): Map<string, ControlPlane.TrustScore[]> {
  const docs: ControlPlane.TrustScore[] = [
    {
      site_id: D1.docsSite,
      day: "2026-11-12",
      window_days: 28,
      score: 84,
      components: {
        proof_coverage_low: component(
          0.92,
          0.94,
          "94% of page views carried a valid browser proof",
          71,
        ),
        network_datacenter_share_high: component(
          0.81,
          0.06,
          "6% of traffic from data-centre networks",
          64,
        ),
        step_change: component(0.55, 3.1, "One abrupt jump: 3.1× the previous days (9 Nov)", null),
      },
      reason_codes: ["step_change"],
      decision_rate: 0.02,
      algorithm_version: "trust/1.2.0",
    },
    {
      site_id: D1.docsSite,
      day: "2026-11-09",
      window_days: 1,
      score: 41,
      components: {},
      reason_codes: ["step_change", "burstiness_high"],
      decision_rate: null,
      algorithm_version: "trust/1.2.0",
    },
    {
      site_id: D1.docsSite,
      day: "2026-11-03",
      window_days: 1,
      score: 58,
      components: {},
      reason_codes: ["network_datacenter_share_high"],
      decision_rate: null,
      algorithm_version: "trust/1.2.0",
    },
    {
      site_id: D1.docsSite,
      day: "2026-11-05",
      window_days: 1,
      score: 88,
      components: {},
      reason_codes: [],
      decision_rate: null,
      algorithm_version: "trust/1.2.0",
    },
  ];
  const wallet: ControlPlane.TrustScore[] = [
    {
      site_id: D1.walletSite,
      day: "2026-11-12",
      window_days: 28,
      score: null,
      components: {},
      reason_codes: ["insufficient_data"],
      decision_rate: null,
      algorithm_version: "trust/1.2.0",
    },
  ];
  return new Map([
    [D1.docsSite, docs],
    [D1.walletSite, wallet],
  ]);
}

function seedOnchain(): Map<string, ControlPlane.OnchainDay[]> {
  const rows: ControlPlane.OnchainDay[] = [];
  for (let i = 0; i < 30; i++) {
    const day = new Date(Date.parse("2026-10-14T00:00:00Z") + i * DAY).toISOString().slice(0, 10);
    rows.push({
      contract_id: CONTRACTS.router,
      network: "public",
      contract_status: "verified",
      day,
      invocations: 150 + (i % 7) * 4,
      successful_invocations: 145 + (i % 7) * 4,
      distinct_invokers: 36 + (i % 5),
    });
    rows.push({
      contract_id: CONTRACTS.routerTest,
      network: "testnet",
      contract_status: "verified",
      day,
      invocations: 500,
      successful_invocations: 480,
      distinct_invokers: 12,
    });
    rows.push({
      contract_id: CONTRACTS.vault,
      network: "public",
      contract_status: "declared",
      day,
      invocations: 999,
      successful_invocations: 999,
      distinct_invokers: 99,
    });
  }
  return new Map([[D1.docs, rows]]);
}

function seedFootprint(): D1State["footprint"] {
  const at = "2026-10-01T10:00:00Z";
  const item = (
    id: string,
    kind: ControlPlane.FootprintKind,
    subject: string,
    network: "mainnet" | "testnet",
    label: string,
    status: ControlPlane.FootprintItem["status"],
    extra: Partial<ControlPlane.FootprintItem> = {},
  ) => ({
    tenantId: D1.docs,
    item_id: id,
    kind,
    subject,
    network,
    label,
    status,
    verification_method: status === "verified" ? ("deployer_admin_match" as const) : null,
    verified_at: status === "verified" ? "2026-10-02T09:00:00Z" : null,
    rejected_reason: null,
    last_checked_at: at,
    conflict_since: null,
    created_at: at,
    ...extra,
  });
  return [
    item(
      "f1000000-0000-4000-8000-000000000001",
      "contract",
      CONTRACTS.router,
      "mainnet",
      "router",
      "verified",
    ),
    item(
      "f1000000-0000-4000-8000-000000000002",
      "contract",
      CONTRACTS.routerTest,
      "testnet",
      "router (test)",
      "verified",
    ),
    item(
      "f1000000-0000-4000-8000-000000000003",
      "contract",
      CONTRACTS.vault,
      "mainnet",
      "vault",
      "claimed",
    ),
    item(
      "f1000000-0000-4000-8000-000000000004",
      "contract",
      CONTRACTS.shared,
      "mainnet",
      "shared pool",
      "verified",
      {
        conflict_since: "2026-11-08T12:00:00Z",
      },
    ),
    // An account item: in the contract, but not shown until accounts are counted (C-137).
    item(
      "f1000000-0000-4000-8000-000000000005",
      "issuing_account",
      strKey(6 << 3, sha(ascii("issuer"))),
      "mainnet",
      "issuer",
      "claimed",
    ),
  ];
}

/** footprint_status as the API derives it (Tenant schema). */
export function footprintStatus(
  t: TenantRow,
  items: D1State["footprint"],
): ControlPlane.Tenant["footprint_status"] {
  const mine = items.filter((i) => i.tenantId === t.tenant_id && i.status !== "rejected");
  if (mine.some((i) => i.status === "verified")) return "verified";
  if (mine.length > 0) return "claimed";
  return t.footprint_none_declared ? "none_declared" : "missing";
}

interface SealedLeaf {
  snapshot_id: string;
  snapshot_sha256: Buffer;
  salt: Buffer;
}

/** Builds the testnet chain 2026-11-10 … 2026-11-13 (a reset before 11-12) over the given snapshot leaves. */
/** A real audit-anchor document of `day` (wire-formats §m.1): its sha256 is the day's audit leaf. */
export function mockAnchorDoc(day: string): ControlPlane.AuditAnchorDocument {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  const body = {
    schema: "scf-analytics/audit-anchor/1" as const,
    date: day,
    generated_at: `${next}T00:00:00Z`,
    chains: [
      {
        chain_id: "00000000-0000-0000-0000-000000000000",
        seq: 300 + Number(day.slice(8, 10)),
        row_hash: hex(sha(ascii(`operator-log-${day}`))),
      },
    ],
  };
  return { ...body, sha256: hex(sha(Buffer.from(jcs(body), "utf8"))) };
}

function buildSeal(sealed: Record<string, SealedLeaf[]>): {
  days: ControlPlane.SealDay[];
  proofs: Map<string, ControlPlane.SealProof[]>;
  anchors: Map<string, ControlPlane.AuditAnchorDocument>;
} {
  const plan = [
    {
      day: "2026-11-10",
      segment: 1,
      status: "network_reset" as const,
      tx: "6a".repeat(32),
      ledger: 4_400_100,
    },
    {
      day: "2026-11-11",
      segment: 1,
      status: "network_reset" as const,
      tx: "6b".repeat(32),
      ledger: 4_417_300,
    },
    {
      day: "2026-11-12",
      segment: 2,
      status: "confirmed" as const,
      tx: D1.tx1112,
      ledger: D1.ledger1112,
    },
    {
      day: "2026-11-13",
      segment: 2,
      status: "confirmed" as const,
      tx: D1.tx1113,
      ledger: D1.ledger1113,
    },
  ];
  let prev: Buffer = Buffer.alloc(32);
  const days: ControlPlane.SealDay[] = [];
  const proofs = new Map<string, ControlPlane.SealProof[]>();
  const anchors = new Map<string, ControlPlane.AuditAnchorDocument>();
  for (const d of plan) {
    const doc = mockAnchorDoc(d.day);
    anchors.set(d.day, doc);
    const anchor = Buffer.from(doc.sha256, "hex");
    const chainLeaf = leafHash(chainData("testnet", d.day, prev));
    const auditLeaf = leafHash(auditData(d.day, anchor));
    const snaps = (sealed[d.day] ?? [])
      .map((s) => ({
        ...s,
        leaf: leafHash(snapshotData(s.salt, s.snapshot_id, s.snapshot_sha256)),
      }))
      .sort((a, b) => Buffer.compare(a.leaf, b.leaf));
    const hashes = [chainLeaf, auditLeaf, ...snaps.map((s) => s.leaf)];
    const root = mth(hashes);
    const headPath = path(0, hashes).slice(1).map(hex);
    const confirmedAt = iso(Date.parse(`${d.day}T00:31:05Z`) + DAY);
    const day: ControlPlane.SealDay = {
      day: d.day,
      network: SEAL_NETWORK,
      segment: d.segment,
      prev_root: hex(prev),
      root: hex(root),
      audit_anchor_sha256: hex(anchor),
      leaf_count: hashes.length,
      head_path: headPath,
      status: d.status,
      source_account: SEAL_ACCOUNT,
      tx_hash: d.tx,
      ledger: d.ledger,
      confirmed_at: confirmedAt,
    };
    days.push(day);
    snaps.forEach((s, i) => {
      proofs.set(s.snapshot_id, [
        {
          schema: "scf-analytics/seal-proof/1",
          network: SEAL_NETWORK,
          snapshot_id: s.snapshot_id,
          snapshot_sha256: hex(s.snapshot_sha256),
          day: d.day,
          segment: d.segment,
          leaf_index: i + 2,
          leaf_count: hashes.length,
          salt: hex(s.salt),
          leaf_hash: hex(s.leaf),
          audit_path: path(i + 2, hashes).map(hex),
          head_path: headPath,
          root: hex(root),
          prev_root: hex(prev),
          audit_anchor_sha256: hex(anchor),
          status: d.status,
          source_account: SEAL_ACCOUNT,
          tx_hash: d.tx,
          ledger: d.ledger,
          confirmed_at: confirmedAt,
          explorer_url: `https://stellar.expert/explorer/testnet/tx/${d.tx}`,
          statement: STATEMENT,
        },
      ]);
    });
    prev = root;
  }
  return { days, proofs, anchors };
}

/** Signs a snapshot row (v2 when it has a series number) and stores document and hash. */
export function signRow(
  row: SnapshotRow,
  t: TenantRow,
  rows: SnapshotRow[],
  onchain: boolean,
): void {
  const previous = rows
    .filter((r) => r.tenantId === row.tenantId && r.seq !== undefined && r.sha256)
    .sort((a, b) => (b.seq as number) - (a.seq as number))[0];
  row.seq = (previous?.seq ?? 0) + 1;
  row.previous_sha256 = previous?.sha256 ?? null;
  row.signed_at ??= iso(Date.now());
  const build = row.schema_version === 3 ? snapshotBodyV3 : snapshotBodyV2; // v3: SCF Evidence Link
  const body = build({
    id: row.snapshot_id,
    tenant: t,
    start: row.period_start,
    end: row.period_end,
    preset: (row.preset ?? "custom") as Preset,
    seq: row.seq,
    previous: row.previous_sha256,
    issuedAt: row.signed_at,
    sealEnabled: t.seal_enabled === true,
    onchain,
  });
  row.doc = signSnapshot(body) as NonNullable<SnapshotRow["doc"]>;
  row.sha256 = hex(sha(Buffer.from(jcs(body), "utf8")));
  row.status = "signed";
}

/** Adds the D1 rows to the shared tenants and snapshot list and returns the D1 state. */
export function seedD1(tenants: Map<string, TenantRow>, snapshots: SnapshotRow[]): D1State {
  const docs = tenants.get(D1.docs);
  const swap = tenants.get(D1.swap);
  const footprint = seedFootprint();
  if (docs) {
    docs.onchain_correlation_enabled = true;
    docs.seal_enabled = true;
    docs.footprint_none_declared = false;
    Object.assign(docs, { footprint_status: footprintStatus(docs, footprint) });
  }
  const mk = (
    tenantId: string,
    id: string,
    start: string,
    end: string,
    preset: Preset,
    signedAt: string,
  ): SnapshotRow => ({
    tenantId,
    polls: 0,
    snapshot_id: id,
    period_start: start,
    period_end: end,
    created_at: signedAt,
    revoked_at: null,
    status: "pending",
    verify_url: `https://portal.example.invalid/public/v1/snapshots/${id}`,
    schema_version: 2,
    preset,
    seal_proof_url: null,
    signed_at: signedAt,
  });
  const rows: SnapshotRow[] = [];
  if (docs) {
    const s1 = mk(
      D1.docs,
      D1.snap1,
      "2026-08-01T00:00:00Z",
      "2026-11-01T00:00:00Z",
      "build_tranche",
      "2026-11-10T09:00:00Z",
    );
    signRow(s1, docs, rows, true);
    rows.push(s1);
    const s2 = mk(
      D1.docs,
      D1.snap2,
      "2026-07-01T00:00:00Z",
      "2026-10-01T00:00:00Z",
      "pg_renewal_quarter",
      "2026-11-12T10:00:00Z",
    );
    signRow(s2, docs, rows, true);
    rows.push(s2);
  }
  if (swap) {
    const a = mk(
      D1.swap,
      D1.swap1,
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      "custom",
      "2026-11-01T09:00:00Z",
    );
    signRow(a, swap, rows, false);
    rows.push(a);
    // Number 2 was signed and then removed from the list by someone: the next one still links to it (a gap).
    const ghost: SnapshotRow = mk(
      D1.swap,
      randomUUID(),
      "2026-09-01T00:00:00Z",
      "2026-10-01T00:00:00Z",
      "custom",
      "2026-11-02T09:00:00Z",
    );
    signRow(ghost, swap, rows, false);
    rows.push(ghost);
    const c = mk(
      D1.swap,
      D1.swap3,
      "2026-10-01T00:00:00Z",
      "2026-11-01T00:00:00Z",
      "custom",
      "2026-11-03T09:00:00Z",
    );
    signRow(c, swap, rows, false);
    rows.push(c);
    rows.splice(rows.indexOf(ghost), 1);
  }
  const filler = (n: number): SealedLeaf => ({
    snapshot_id: `0193b7e2-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
    snapshot_sha256: sha(ascii(`other-tenant-snapshot-${n}`)),
    salt: sha(ascii(`other-salt-${n}`)),
  });
  const leafOf = (r: SnapshotRow | undefined): SealedLeaf[] =>
    r?.sha256
      ? [
          {
            snapshot_id: r.snapshot_id,
            snapshot_sha256: Buffer.from(r.sha256, "hex"),
            salt: sha(ascii(`salt-${r.snapshot_id}`)),
          },
        ]
      : [];
  const seal = buildSeal({
    "2026-11-10": [...leafOf(rows.find((r) => r.snapshot_id === D1.snap1)), filler(1)],
    "2026-11-12": [...leafOf(rows.find((r) => r.snapshot_id === D1.snap2)), filler(2), filler(3)],
  });
  for (const r of rows) {
    if (seal.proofs.has(r.snapshot_id))
      r.seal_proof_url = `https://portal.example.invalid/public/v1/snapshots/${r.snapshot_id}/seal`;
  }
  // newest first, in front of the existing (pre-series, v1) snapshots
  snapshots.unshift(...rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
  return {
    trust: seedTrust(),
    annotations: [
      {
        tenantId: D1.docs,
        annotation_id: "a1000000-0000-4000-8000-000000000001",
        site_id: D1.docsSite,
        service_id: null,
        start: "2026-11-09T00:00:00Z",
        end: "2026-11-10T00:00:00Z",
        author_kind: "tenant",
        body: "Mainnet launch announced on social media; traffic spike expected.",
        explains_reason_codes: ["step_change", "burstiness_high"],
        marks_explained: false,
        created_at: "2026-11-10T08:00:00Z",
      },
    ],
    onchain: seedOnchain(),
    footprint,
    devEvents: new Map(),
    sealDays: seal.days,
    proofs: seal.proofs,
    anchors: seal.anchors,
  };
}

// --- wallet funnel ---

type Funnel = ControlPlane.WalletFunnel;
type FunnelEvent = Funnel["steps"][number]["event"];

const NETWORK_FUNNEL: Record<
  "mainnet" | "testnet",
  {
    event: FunnelEvent;
    count: number;
    wallets?: Record<string, number>;
    props?: Record<string, Record<string, number>>;
  }[]
> = {
  mainnet: [
    { event: "wallet_modal_opened", count: 2900 },
    {
      event: "wallet_selected",
      count: 2100,
      wallets: { freighter: 1290, xbull: 300, lobstr: 240, albedo: 130, hana: 80, passkey: 60 },
    },
    {
      event: "wallet_connect",
      count: 1450,
      wallets: { freighter: 880, xbull: 210, lobstr: 160, albedo: 90, hana: 60, passkey: 50 },
      props: { connect_kind: { new: 930, restored: 520 } },
    },
    {
      event: "sign_requested",
      count: 610,
      wallets: { freighter: 380, xbull: 90, lobstr: 70, albedo: 40, hana: 20, passkey: 10 },
    },
    {
      event: "sign_approved",
      count: 540,
      wallets: { freighter: 340, xbull: 80, lobstr: 60, albedo: 33, hana: 17, passkey: 10 },
    },
    {
      event: "sign_rejected",
      count: 70,
      wallets: { freighter: 40, xbull: 10, lobstr: 10, albedo: 7, hana: 3 },
      props: { error_class: { user_rejected: 52, timeout: 9, unknown: 9 } },
    },
    {
      event: "tx_submitted",
      count: 560,
      props: { result_class: { success: 505, failed: 30, try_again_later: 25 } },
    },
    { event: "passkey_used", count: 48 },
  ],
  testnet: [
    { event: "wallet_modal_opened", count: 410 },
    { event: "wallet_selected", count: 330, wallets: { freighter: 300, xbull: 30 } },
    {
      event: "wallet_connect",
      count: 240,
      wallets: { freighter: 220, xbull: 20 },
      props: { connect_kind: { new: 200, restored: 40 } },
    },
    { event: "sign_requested", count: 190, wallets: { freighter: 175, xbull: 15 } },
    { event: "sign_approved", count: 180, wallets: { freighter: 166, xbull: 14 } },
    {
      event: "sign_rejected",
      count: 10,
      wallets: { freighter: 9, xbull: 1 },
      props: { error_class: { user_rejected: 10 } },
    },
    { event: "tx_submitted", count: 185, props: { result_class: { success: 170, failed: 15 } } },
  ],
};

export function walletFunnel(
  siteId: string,
  start: string,
  end: string,
  network: Funnel["network"],
  variant: "verified" | "raw",
): Funnel {
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / DAY));
  const scale = (n: number) => (variant === "raw" ? Math.round(n * 1.06) : n);
  const nets =
    siteId !== D1.docsSite
      ? []
      : network === "all"
        ? (["mainnet", "testnet"] as const)
        : network === "mainnet" || network === "testnet"
          ? [network]
          : [];
  const steps = new Map<FunnelEvent, Funnel["steps"][number]>();
  for (const n of nets)
    for (const s of NETWORK_FUNNEL[n]) {
      const cur = steps.get(s.event) ?? {
        event: s.event,
        count: 0,
        by_wallet: {},
        by_property: {},
      };
      cur.count += scale(s.count);
      for (const [w, c] of Object.entries(s.wallets ?? {}))
        cur.by_wallet[w as keyof typeof cur.by_wallet] =
          (cur.by_wallet[w as keyof typeof cur.by_wallet] ?? 0) + scale(c);
      for (const [k, vals] of Object.entries(s.props ?? {})) {
        const m = cur.by_property[k] ?? {};
        cur.by_property[k] = m;
        for (const [v, c] of Object.entries(vals)) m[v] = (m[v] ?? 0) + scale(c);
      }
      steps.set(s.event, cur);
    }
  const total = (e: FunnelEvent) => steps.get(e)?.count ?? 0;
  const txOk = Object.values(steps.get("tx_submitted")?.by_property.result_class ?? {}).length
    ? (steps.get("tx_submitted")?.by_property.result_class?.success ?? 0)
    : 0;
  const part = (t: number, d: number) =>
    Math.floor(t / days) + (d < t - Math.floor(t / days) * days ? 1 : 0);
  const daily =
    steps.size === 0
      ? []
      : Array.from({ length: days }, (_, d) => ({
          day: new Date(Date.parse(start) + d * DAY).toISOString().slice(0, 10),
          wallet_connect: part(total("wallet_connect"), d),
          sign_approved: part(total("sign_approved"), d),
          tx_submitted_success: part(txOk, d),
        }));
  return {
    range: { start, end },
    network,
    variant,
    schema: "scf-stellar-events/1",
    steps: [...steps.values()],
    daily,
  };
}

// --- cohorts ---

const cohort = (
  cohort: string,
  n: number,
  pv: number | null,
  onchainTenants: number | null,
  inv: number | null,
  ok: number | null,
): ControlPlane.Cohort => {
  const suppressed = n < 5;
  return {
    cohort,
    tenant_count: suppressed ? null : n,
    pageviews_verified: suppressed ? null : pv,
    pageviews_raw: suppressed || pv === null ? null : Math.round(pv * 1.07),
    visitors_sum_verified: suppressed || pv === null ? null : Math.round(pv / 5.2),
    tenants_with_onchain: suppressed ? null : onchainTenants,
    onchain_invocations: suppressed ? null : inv,
    onchain_successful_invocations: suppressed ? null : ok,
    suppressed,
  };
};
export function cohorts(
  by: ControlPlane.CohortList["by"],
  start: string,
  end: string,
): ControlPlane.CohortList {
  const rows: Record<ControlPlane.CohortList["by"], ControlPlane.Cohort[]> = {
    round: [
      cohort("45", 7, 184_300, 5, 61_200, 59_010),
      cohort("44", 6, 97_450, 2, null, null),
      cohort("43", 3, null, null, null, null),
      cohort("42", 5, null, 0, null, null),
    ],
    category: [
      cohort("end_user_application", 8, 142_000, 4, 30_100, 29_400),
      cohort("financial_protocols", 6, 88_900, 5, 44_000, 42_700),
      cohort("developer_tooling", 4, null, null, null, null),
      cohort("infrastructure_services", 2, null, null, null, null),
    ],
    award_stage: [
      cohort("t3_mainnet", 9, 201_000, 6, 70_800, 68_100),
      cohort("t2_testnet", 7, 66_100, 2, null, null),
      cohort("t1_mvp", 3, null, null, null, null),
    ],
  };
  return { by, range: { start, end }, min_tenants: 5, cohorts: rows[by] };
}

export const SEAL_STATEMENT = STATEMENT;

// --- handlers ---

export interface D1Helpers {
  tenants(): Map<string, TenantRow>;
  sites(): Map<string, SiteRow>;
  services(): Map<string, ControlPlane.Service & { tenantId: string }>;
  tenantOf(req: IncomingMessage, tenantId: string): TenantRow;
  operator(req: IncomingMessage): unknown;
  audit(
    req: IncomingMessage,
    action: ControlPlane.AuditAction,
    target: { type: string; id: string } | null,
    details?: Json,
  ): void;
  snapshots(): SnapshotRow[];
  d1(): D1State;
  /** the v1 behaviour of getPublicSnapshot (the seeded v1 snapshot and the tampered copy) */
  v1PublicSnapshot: Handler;
  notFound(): Error;
  invalid(pointer: string, detail: string): Error;
  /** any other problem response of the catalogue (status + code), e.g. 409 conflict or 422 unprocessable */
  problem(status: number, code: ControlPlane.ProblemCode, detail: string): Error;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}T00:00:00Z$/;

export function d1Handlers(h: D1Helpers): Record<string, Handler> {
  const siteOf = (req: IncomingMessage, tenantId: string, siteId: string): SiteRow => {
    h.tenantOf(req, tenantId);
    const s = h.sites().get(siteId);
    if (!s || s.tenantId !== tenantId) throw h.notFound();
    return s;
  };
  const dayRange = (q: URLSearchParams) => {
    const start = q.get("start") ?? "";
    const end = q.get("end") ?? "";
    if (!DAY_RE.test(start)) throw h.invalid("/start", "must be a UTC midnight");
    if (!DAY_RE.test(end) || end <= start) throw h.invalid("/end", "must be a later UTC midnight");
    return { start, end };
  };
  const publicTenant = (slug: string) => {
    const t = [...h.tenants().values()].find((x) => x.slug === slug);
    if (!t || (t.status !== "active" && t.status !== "suspended")) throw h.notFound();
    return t;
  };
  const summary = (r: SnapshotRow): ControlPlane.TractionSnapshotSummary => {
    const {
      tenantId: _t,
      polls: _p,
      seq: _s,
      previous_sha256: _ps,
      sha256: _h,
      signed_at: _sa,
      doc: _d,
      ...rest
    } = r;
    return rest;
  };
  const view = (t: TenantRow): ControlPlane.Tenant => {
    const { members: _m, ...rest } = t;
    return rest;
  };
  const footprintView = (i: D1State["footprint"][number]): ControlPlane.FootprintItem => {
    const { tenantId: _t, ...rest } = i;
    return rest;
  };
  const refreshStatus = (t: TenantRow) => {
    Object.assign(t, { footprint_status: footprintStatus(t, h.d1().footprint) });
  };

  return {
    // --- trust and annotations (D-2) ---
    listSiteTrustScores: ({ req, p, q }) => {
      const s = siteOf(req, p.tenantId as string, p.siteId as string);
      dayRange(q);
      return { status: 200, body: h.d1().trust.get(s.site_id) ?? [] };
    },
    listAnnotations: ({ req, p }) => {
      h.tenantOf(req, p.tenantId as string);
      return {
        status: 200,
        body: h
          .d1()
          .annotations.filter((a) => a.tenantId === p.tenantId)
          .map(({ tenantId: _t, ...a }) => a),
      };
    },
    createAnnotation: ({ req, p, body }) => {
      h.tenantOf(req, p.tenantId as string);
      const start = String(body.start ?? "");
      const end = String(body.end ?? "");
      if (!DAY_RE.test(start) || !DAY_RE.test(end) || end <= start)
        throw h.invalid("/end", "whole UTC days, end after start");
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (text === "" || text.length > 1000) throw h.invalid("/body", "1–1000 characters");
      if (typeof body.site_id === "string") siteOf(req, p.tenantId as string, body.site_id);
      const a = {
        tenantId: p.tenantId as string,
        annotation_id: randomUUID(),
        site_id: typeof body.site_id === "string" ? body.site_id : null,
        service_id: typeof body.service_id === "string" ? body.service_id : null,
        start,
        end,
        author_kind: "tenant" as const,
        body: text,
        explains_reason_codes: Array.isArray(body.explains_reason_codes)
          ? (body.explains_reason_codes as string[])
          : [],
        marks_explained: false,
        created_at: iso(Date.now()),
      };
      h.d1().annotations.push(a);
      h.audit(req, "trust.annotation.created", { type: "tenant", id: p.tenantId as string });
      const { tenantId: _t, ...out } = a;
      return { status: 201, body: out };
    },
    getOnchainDaily: ({ req, p, q }) => {
      h.tenantOf(req, p.tenantId as string);
      dayRange(q);
      return { status: 200, body: h.d1().onchain.get(p.tenantId as string) ?? [] };
    },
    getApiAssurance: ({ req, p, q }) => {
      h.tenantOf(req, p.tenantId as string);
      dayRange(q);
      const svc = h.services().get(p.serviceId as string);
      if (!svc || svc.tenantId !== p.tenantId) throw h.notFound();
      const rpc = svc.service_id === D1.rpcSvc;
      return {
        status: 200,
        body: [
          {
            day: "2026-11-12",
            level: rpc ? "A1" : "A2",
            onchain_badge: rpc ? "not_applicable" : "consistent",
            reason_codes: rpc ? ["a2_probe_failed"] : [],
          },
        ],
      };
    },
    // --- first-event panel (E2/E4) ---
    listSiteDevEvents: ({ req, p }) => {
      const s = siteOf(req, p.tenantId as string, p.siteId as string);
      return {
        status: 200,
        body: {
          site_id: s.site_id,
          dev_origins: s.dev_origins ?? [],
          debug_until: s.debug_until ?? null,
          events: (h.d1().devEvents.get(s.site_id) ?? []).slice(0, 100),
        },
      };
    },
    setSiteDebugMode: ({ req, p, body }) => {
      const s = siteOf(req, p.tenantId as string, p.siteId as string);
      if (typeof body.enabled !== "boolean") throw h.invalid("/enabled", "required");
      const minutes = Number(body.duration_minutes ?? 60);
      if (body.enabled && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440))
        throw h.invalid("/duration_minutes", "1–1440");
      Object.assign(s, { debug_until: body.enabled ? iso(Date.now() + minutes * 60_000) : null });
      h.audit(req, "site.debug_mode_set", { type: "site", id: s.site_id });
      return { status: 200, body: { site_id: s.site_id, debug_until: s.debug_until } };
    },
    // --- wallet funnel (D-6) ---
    getSiteWalletFunnel: ({ req, p, q }) => {
      const s = siteOf(req, p.tenantId as string, p.siteId as string);
      const { start, end } = dayRange(q);
      const network = (q.get("network") ?? "mainnet") as Funnel["network"];
      if (!["mainnet", "testnet", "futurenet", "local", "all"].includes(network))
        throw h.invalid("/network", "unknown network");
      const variant = q.get("variant") === "raw" ? "raw" : "verified";
      return { status: 200, body: walletFunnel(s.site_id, start, end, network, variant) };
    },
    // --- Registered Footprint, contracts (A5, C-137) ---
    listFootprint: ({ req, p }) => {
      h.tenantOf(req, p.tenantId as string);
      return {
        status: 200,
        body: h
          .d1()
          .footprint.filter((i) => i.tenantId === p.tenantId)
          .map(footprintView),
      };
    },
    addFootprintItem: ({ req, p, body }) => {
      const t = h.tenantOf(req, p.tenantId as string);
      if (body.kind !== "contract")
        // C-137, C-138: other kinds answer 422 (`unprocessable`) until they are counted
        throw h.problem(
          422,
          "unprocessable",
          "only contracts can be registered now; accounts and WASM hashes come later",
        );
      const subject = String(body.subject ?? "");
      if (!/^C[A-Z2-7]{55}$/.test(subject)) throw h.invalid("/subject", "a contract strkey");
      // C-138: mainnet | testnet; `public` is the deprecated alias of mainnet
      if (body.network !== "mainnet" && body.network !== "public" && body.network !== "testnet")
        throw h.invalid("/network", "mainnet or testnet");
      const network = body.network === "testnet" ? "testnet" : "mainnet";
      if (
        h
          .d1()
          .footprint.some(
            (i) => i.tenantId === t.tenant_id && i.subject === subject && i.network === network,
          )
      )
        throw h.problem(409, "conflict", "this contract is already registered");
      const item = {
        tenantId: t.tenant_id,
        item_id: randomUUID(),
        kind: "contract" as const,
        subject,
        network: network as "mainnet" | "testnet",
        label: typeof body.label === "string" ? body.label : null,
        status: "claimed" as const,
        verification_method: null,
        verified_at: null,
        rejected_reason: null,
        last_checked_at: null,
        conflict_since: null,
        created_at: iso(Date.now()),
      };
      h.d1().footprint.push(item);
      if (t.footprint_none_declared) t.footprint_none_declared = false;
      refreshStatus(t);
      h.audit(req, "footprint.item_added", { type: "tenant", id: t.tenant_id });
      return { status: 201, body: footprintView(item) };
    },
    removeFootprintItem: ({ req, p }) => {
      const t = h.tenantOf(req, p.tenantId as string);
      const list = h.d1().footprint;
      const i = list.findIndex((x) => x.item_id === p.itemId && x.tenantId === t.tenant_id);
      if (i < 0) throw h.notFound();
      list.splice(i, 1);
      refreshStatus(t);
      h.audit(req, "footprint.item_removed", { type: "tenant", id: t.tenant_id });
      return { status: 204 };
    },
    verifyFootprintItem: ({ req, p, body }) => {
      const t = h.tenantOf(req, p.tenantId as string);
      const item = h
        .d1()
        .footprint.find((x) => x.item_id === p.itemId && x.tenantId === t.tenant_id);
      if (!item) throw h.notFound();
      if (body.method !== "deployer_admin_match")
        throw h.invalid("/method", "contracts: deployer_admin_match");
      // The mock's ledger: contracts whose id ends in a letter A–M have the project's account as deployer.
      const owned = /[A-M]$/.test(item.subject ?? "");
      item.last_checked_at = iso(Date.now());
      if (owned) {
        item.status = "verified";
        item.verification_method = "deployer_admin_match";
        item.verified_at = iso(Date.now());
        item.rejected_reason = null;
      } else {
        item.status = "rejected";
        item.rejected_reason = "not_deployer_or_admin";
      }
      refreshStatus(t);
      h.audit(req, owned ? "footprint.item_verified" : "footprint.item_rejected", {
        type: "tenant",
        id: t.tenant_id,
      });
      return { status: 200, body: footprintView(item) };
    },
    updateTenant: ({ req, p, body }) => {
      const t = h.tenantOf(req, p.tenantId as string);
      if (typeof body.public_stats_enabled === "boolean")
        t.public_stats_enabled = body.public_stats_enabled;
      if (typeof body.name === "string" && body.name.trim() !== "") t.name = body.name.trim();
      if (typeof body.seal_enabled === "boolean") t.seal_enabled = body.seal_enabled;
      if (typeof body.onchain_correlation_enabled === "boolean")
        t.onchain_correlation_enabled = body.onchain_correlation_enabled;
      if (typeof body.footprint_none_declared === "boolean") {
        t.footprint_none_declared = body.footprint_none_declared;
        refreshStatus(t);
      }
      return { status: 200, body: view(t) };
    },
    // --- traction snapshots v2 (C1) ---
    listTractionSnapshots: ({ req, p }) => {
      const t = h.tenantOf(req, p.tenantId as string);
      const all = h.snapshots();
      const rows = all.filter((x) => x.tenantId === p.tenantId);
      for (const x of rows) {
        if (x.status === "pending" && --x.polls <= 0) {
          if ((x.schema_version ?? 1) >= 2) signRow(x, t, all, t.onchain_correlation_enabled);
          else x.status = "signed";
        }
      }
      return { status: 200, body: rows.map(summary) };
    },
    createTractionSnapshot: ({ req, p, body }) => {
      h.tenantOf(req, p.tenantId as string);
      const start = String(body.period_start ?? "");
      const end = String(body.period_end ?? "");
      if (!DAY_RE.test(start) || !DAY_RE.test(end) || !(start < end))
        throw h.invalid("/period_end", "must be after period_start");
      const version = body.schema_version === 1 ? 1 : body.schema_version === 3 ? 3 : 2;
      const preset = (body.preset ?? "custom") as Preset;
      if (version === 1 && body.preset !== undefined) throw h.invalid("/preset", "v2 only");
      if (preset === "pg_renewal_quarter") {
        const s = new Date(start);
        const e = new Date(end);
        const quarterStart = s.getUTCDate() === 1 && s.getUTCMonth() % 3 === 0;
        const next = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 3, 1));
        if (!quarterStart || e.getTime() !== next.getTime())
          throw h.invalid("/period_start", "pg_renewal_quarter needs exactly one calendar quarter");
      }
      const id = randomUUID();
      const verify_url = `https://portal.example.invalid/public/v1/snapshots/${id}`;
      h.snapshots().unshift({
        tenantId: p.tenantId as string,
        polls: 2,
        snapshot_id: id,
        period_start: start,
        period_end: end,
        created_at: iso(Date.now()),
        revoked_at: null,
        status: "pending",
        verify_url,
        schema_version: version,
        preset: version >= 2 ? preset : null,
        seal_proof_url: null,
      });
      return { status: 202, body: { snapshot_id: id, status: "pending", verify_url } };
    },
    getPublicSnapshot: (c) => {
      const row = h.snapshots().find((y) => y.snapshot_id === c.p.snapshotId && y.doc);
      if (!row) return h.v1PublicSnapshot(c);
      const t = h.tenants().get(row.tenantId);
      if (!t || (t.status !== "active" && t.status !== "suspended")) throw h.notFound();
      return {
        status: 200,
        body: {
          ...row.doc,
          status: row.revoked_at ? "revoked" : "valid",
          revoked_at: row.revoked_at,
        },
      };
    },
    getPublicSnapshotList: ({ p }) => {
      const t = publicTenant(p.slug as string);
      const entries = h
        .snapshots()
        .filter((r) => r.tenantId === t.tenant_id && r.seq !== undefined && r.sha256)
        .sort((a, b) => (a.seq as number) - (b.seq as number))
        .map((r) => ({
          snapshot_id: r.snapshot_id,
          seq: r.seq as number,
          previous_sha256: r.previous_sha256 ?? null,
          schema_version: (r.schema_version ?? 2) as 1 | 2 | 3,
          preset: r.preset ?? null,
          period: { start: r.period_start, end: r.period_end },
          signed_at: r.signed_at as string,
          sha256: r.sha256 as string,
          status: r.revoked_at ? ("revoked" as const) : ("valid" as const),
          revoked_at: r.revoked_at ?? null,
          url: `https://portal.example.invalid/public/v1/snapshots/${r.snapshot_id}`,
        }));
      return {
        status: 200,
        body: {
          schema: "scf-analytics/snapshot-list/1",
          project: { slug: t.slug },
          generated_at: iso(Date.now()),
          snapshots: entries,
        },
      };
    },
    // --- daily seal (A2) ---
    getSnapshotSealProof: ({ p }) => {
      const row = h.snapshots().find((r) => r.snapshot_id === p.snapshotId);
      const t = row ? h.tenants().get(row.tenantId) : undefined;
      const proofs = h.d1().proofs.get(p.snapshotId as string);
      if (
        !row ||
        !t ||
        !proofs ||
        t.seal_enabled !== true ||
        (t.status !== "active" && t.status !== "suspended")
      )
        throw h.notFound();
      return { status: 200, body: { proofs } };
    },
    listSealDays: ({ q }) => {
      const { start, end } = dayRange(q);
      if (Date.parse(end) - Date.parse(start) > 400 * DAY)
        throw h.invalid("/end", "at most 400 days");
      return {
        status: 200,
        body: {
          network: SEAL_NETWORK,
          days: h.d1().sealDays.filter((d) => dayIso(d.day) >= start && dayIso(d.day) < end),
          statement: STATEMENT,
        },
      };
    },
    getSealDay: ({ p }) => {
      const d = h.d1().sealDays.find((x) => x.day === p.day);
      if (!d) throw h.notFound();
      return { status: 200, body: { seal: d, statement: STATEMENT } };
    },
    // --- "verify this number": the sealed audit-anchor documents ---
    getSealedAuditAnchor: ({ p }) => {
      const d = h.d1().anchors.get(p.day as string);
      if (!d) throw h.notFound();
      return { status: 200, body: d };
    },
    // --- operator cohorts (C3) ---
    operatorCohorts: ({ req, q }) => {
      h.operator(req);
      const { start, end } = dayRange(q);
      const by = q.get("by");
      if (by !== "round" && by !== "category" && by !== "award_stage")
        throw h.invalid("/by", "round, category or award_stage");
      h.audit(req, "operator.read.op_cohorts", null, { by });
      return { status: 200, body: cohorts(by, start, end) };
    },
  };
}

const dayIso = (d: string) => `${d}T00:00:00Z`;
