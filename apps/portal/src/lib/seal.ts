// SPDX-License-Identifier: Apache-2.0
// Browser-side check of the daily seal (wire-formats §m.2, `scf-seal/1`; C-136, C-137): the RFC 9162 §2.1 Merkle tree
// (leaf = H(0x00 ‖ data), node = H(0x01 ‖ left ‖ right), H = SHA-256), the three leaf encodings, the inclusion-proof
// check of RFC 9162 §2.1.3.2, the day root recomputed from public data alone (chain leaf, audit leaf, `head_path`
// with every sibling on the right) and the chain walk across days and testnet-reset segments. Everything runs on
// WebCrypto; the known-answer vectors in docs/contracts/vectors/seal-v1.json are the test oracle
// (test/unit/seal.test.ts). The seal is tamper-evidence of published numbers, never proof that they are genuine.

export const SEAL_STATEMENT =
  "Tamper-evidence of a published snapshot. It does not show that the numbers are genuine.";
export const TESTNET_NOTICE =
  "Stellar testnet is reset several times a year; this seal is a demonstration, not durable evidence.";

export type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

export function ascii(s: string): Bytes {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error("seal: ASCII only");
  const out = new Uint8Array(new ArrayBuffer(s.length));
  out.set(enc.encode(s));
  return out;
}

export function fromHex(h: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Error("seal: not lower-case hex");
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function concat(...parts: Uint8Array[]): Bytes {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(n));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function sha256(
  data: Uint8Array<ArrayBuffer>,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<Bytes> {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

const ZERO = new Uint8Array([0]);
const ONE = new Uint8Array([1]);

export const leafHash = (data: Uint8Array): Promise<Bytes> => sha256(concat(ZERO, data));
export const nodeHash = (l: Uint8Array, r: Uint8Array): Promise<Bytes> => sha256(concat(ONE, l, r));

/** The largest power of two smaller than n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/** Merkle tree hash over leaf hashes (RFC 9162 §2.1.1). */
export async function merkleRoot(hashes: readonly Uint8Array[]): Promise<Bytes> {
  if (hashes.length === 0) return sha256(new Uint8Array(new ArrayBuffer(0)));
  if (hashes.length === 1) return concat(hashes[0] as Uint8Array);
  const k = split(hashes.length);
  return nodeHash(await merkleRoot(hashes.slice(0, k)), await merkleRoot(hashes.slice(k)));
}

/**
 * RFC 9162 §2.1.3.2: the root an inclusion proof leads to, or null when the proof's shape does not fit
 * (`index ≥ size`, too many or too few path elements).
 */
export async function rootFromInclusion(
  index: number,
  size: number,
  leaf: Uint8Array,
  auditPath: readonly Uint8Array[],
): Promise<Bytes | null> {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size)
    return null;
  let fn = index;
  let sn = size - 1;
  let r: Bytes = concat(leaf);
  for (const p of auditPath) {
    if (sn === 0) return null;
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 ? r : null;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

// --- leaf encodings (§m.2 table; strings ASCII, ‖ concatenation) ---

export function chainLeafData(network: string, day: string, prevRoot: Uint8Array): Bytes {
  return concat(ascii("scf-seal/1 chain"), ZERO, ascii(network), ZERO, ascii(day), prevRoot);
}

export function auditLeafData(day: string, anchorSha256: Uint8Array): Bytes {
  return concat(ascii("scf-seal/1 audit"), ZERO, ascii(day), anchorSha256);
}

/** A UUID in RFC 9562 byte order (the 16 bytes of its hex digits). */
export function uuidBytes(id: string): Bytes {
  const h = id.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error("seal: not a UUID");
  return fromHex(h);
}

export function snapshotLeafData(
  salt: Uint8Array,
  snapshotId: string,
  snapshotSha256: Uint8Array,
): Bytes {
  return concat(ascii("scf-seal/1 snapshot"), ZERO, salt, uuidBytes(snapshotId), snapshotSha256);
}

/** §m.2 step 5: root = fold(node(chain leaf, audit leaf), head_path), every sibling on the right. */
export async function dayRootFromPublicData(d: {
  network: string;
  day: string;
  prev_root: string;
  audit_anchor_sha256: string;
  head_path: readonly string[];
}): Promise<Bytes> {
  const chain = await leafHash(chainLeafData(d.network, d.day, fromHex(d.prev_root)));
  const audit = await leafHash(auditLeafData(d.day, fromHex(d.audit_anchor_sha256)));
  let r = await nodeHash(chain, audit);
  for (const p of d.head_path) r = await nodeHash(r, fromHex(p));
  return r;
}

/** ⌈log₂ n⌉ − 1: the length `head_path` must have for a day of n leaves. */
export function headPathLength(leafCount: number): number {
  return Math.max(0, Math.ceil(Math.log2(leafCount)) - 1);
}

// --- the snapshot's own proof (§m.2 steps 2, 3, 5) ---

export interface SealProofView {
  network: { name: "testnet" | "mainnet"; durable: boolean; notice: string | null };
  snapshot_id: string;
  snapshot_sha256: string;
  day: string;
  segment: number;
  leaf_index: number;
  leaf_count: number;
  salt: string;
  leaf_hash: string;
  audit_path: string[];
  head_path: string[];
  root: string;
  prev_root: string;
  audit_anchor_sha256: string;
  status: "built" | "submitted" | "confirmed" | "failed" | "network_reset";
}

export interface ProofCheck {
  /** the snapshot's hash equals `snapshot_sha256` */
  snapshotHash: boolean;
  /** step 2: the salted leaf hash equals `leaf_hash` */
  leaf: boolean;
  /** step 3: the inclusion path leads to `root` */
  inclusion: boolean;
  /** step 5: chain leaf, audit leaf and `head_path` lead to `root` */
  head: boolean;
  ok: boolean;
}

export async function checkSealProof(
  proof: SealProofView,
  snapshotSha256Hex: string,
): Promise<ProofCheck> {
  const malformed = { snapshotHash: false, leaf: false, inclusion: false, head: false, ok: false };
  try {
    const snapshotHash = snapshotSha256Hex === proof.snapshot_sha256;
    const leaf = await leafHash(
      snapshotLeafData(fromHex(proof.salt), proof.snapshot_id, fromHex(snapshotSha256Hex)),
    );
    const leafOk = toHex(leaf) === proof.leaf_hash;
    const root = fromHex(proof.root);
    const r = await rootFromInclusion(
      proof.leaf_index,
      proof.leaf_count,
      leaf,
      proof.audit_path.map(fromHex),
    );
    const inclusion = r !== null && equalBytes(r, root);
    const head =
      proof.head_path.length === headPathLength(proof.leaf_count) &&
      equalBytes(
        await dayRootFromPublicData({
          network: proof.network.name,
          day: proof.day,
          prev_root: proof.prev_root,
          audit_anchor_sha256: proof.audit_anchor_sha256,
          head_path: proof.head_path,
        }),
        root,
      );
    return {
      snapshotHash,
      leaf: leafOk,
      inclusion,
      head,
      ok: snapshotHash && leafOk && inclusion && head,
    };
  } catch {
    return malformed;
  }
}

// --- the chain of days (§m.2 "Verification" step 5, testnet reset steps 3–4) ---

export interface SealDayView {
  day: string;
  network: { name: "testnet" | "mainnet" };
  segment: number;
  prev_root: string;
  root: string;
  audit_anchor_sha256: string;
  leaf_count: number;
  head_path: string[];
  status: "built" | "submitted" | "confirmed" | "failed" | "network_reset";
  tx_hash: string | null;
  ledger: number | null;
  /** the sealing account of the day's transaction (absent on days never submitted) */
  source_account?: string | null;
}

export interface ChainDayCheck {
  day: string;
  segment: number;
  status: SealDayView["status"];
  /** the root recomputed from public data equals the published root */
  rootOk: boolean;
  /** `prev_root` equals the previous listed day's root (true for the first listed day) */
  linkOk: boolean;
  /** the day directly follows the previous listed day */
  contiguous: boolean;
  /** this day starts a new segment (a testnet reset happened before it) */
  segmentBreak: boolean;
}

export interface ChainCheck {
  days: ChainDayCheck[];
  ok: boolean;
  /** the first confirmed day at or after `from` whose chain back to `from` holds; null when none */
  anchoredBy: SealDayView | null;
}

const nextDay = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Walks `days` (ascending, from the sealed day on): recomputes each root, checks each `prev_root` link and contiguity,
 * marks segment breaks and finds the first confirmed day whose chain back to the first day is intact — that
 * transaction anchors every earlier day through the chain leaves (C-137).
 */
export async function checkChain(days: readonly SealDayView[]): Promise<ChainCheck> {
  const out: ChainDayCheck[] = [];
  let intact = true;
  let anchoredBy: SealDayView | null = null;
  for (let i = 0; i < days.length; i++) {
    const d = days[i] as SealDayView;
    const prev = i > 0 ? (days[i - 1] as SealDayView) : null;
    let rootOk = false;
    try {
      rootOk =
        d.head_path.length === headPathLength(d.leaf_count) &&
        toHex(
          await dayRootFromPublicData({
            network: d.network.name,
            day: d.day,
            prev_root: d.prev_root,
            audit_anchor_sha256: d.audit_anchor_sha256,
            head_path: d.head_path,
          }),
        ) === d.root;
    } catch {
      rootOk = false;
    }
    const linkOk = prev === null || prev.root === d.prev_root;
    const contiguous = prev === null || nextDay(prev.day) === d.day;
    const segmentBreak = prev !== null && d.segment !== prev.segment;
    out.push({
      day: d.day,
      segment: d.segment,
      status: d.status,
      rootOk,
      linkOk,
      contiguous,
      segmentBreak,
    });
    intact = intact && rootOk && linkOk && contiguous;
    if (intact && anchoredBy === null && d.status === "confirmed") anchoredBy = d;
  }
  return { days: out, ok: out.every((d) => d.rootOk && d.linkOk && d.contiguous), anchoredBy };
}

// --- looking the transaction up (§m.2 "Where a transaction is looked up", verification step 4) ---

/**
 * Horizon origins this page may contact (the portal's CSP `connect-src` lists exactly these, server/headers.ts). A
 * proof naming another Horizon is checked by hand with the explorer link.
 */
export const HORIZON_ORIGINS = [
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
] as const;

export type TxLookup =
  | { kind: "match"; ledger: number }
  | { kind: "mismatch"; problems: string[] }
  | { kind: "outside_history"; elderLedger: number }
  | { kind: "not_found" }
  | { kind: "not_allowed"; origin: string }
  | { kind: "unreachable"; detail: string };

/** base64 of the 32 root bytes, as Horizon shows a `MEMO_HASH`. */
export function rootToMemoBase64(rootHex: string): string {
  let s = "";
  for (const b of fromHex(rootHex)) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Step 4: ask Horizon for the transaction; a 404 for a ledger older than the endpoint's `history_elder_ledger` is
 * "outside this endpoint's history", never "not found" (C-137). The request goes only to an allow-listed Horizon,
 * only when the reader asks for it (it tells Horizon the reader's address).
 */
export async function lookupSealTransaction(
  horizon: string,
  expect: { tx_hash: string; source_account: string; root: string; ledger: number },
  fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a),
): Promise<TxLookup> {
  let origin: string;
  try {
    origin = new URL(horizon).origin;
  } catch {
    return { kind: "not_allowed", origin: horizon };
  }
  if (!(HORIZON_ORIGINS as readonly string[]).includes(origin))
    return { kind: "not_allowed", origin };
  const get = async (path: string) =>
    fetchImpl(`${origin}${path}`, {
      headers: { Accept: "application/hal+json, application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  try {
    const res = await get(`/transactions/${encodeURIComponent(expect.tx_hash)}`);
    if (res.status === 404) {
      const root = await get("/");
      if (root.ok) {
        const info = (await root.json()) as { history_elder_ledger?: unknown };
        const elder = Number(info.history_elder_ledger);
        if (Number.isInteger(elder) && expect.ledger < elder)
          return { kind: "outside_history", elderLedger: elder };
      }
      return { kind: "not_found" };
    }
    if (!res.ok) return { kind: "unreachable", detail: `Horizon answered ${res.status}` };
    const tx = (await res.json()) as {
      successful?: unknown;
      source_account?: unknown;
      memo_type?: unknown;
      memo?: unknown;
      ledger?: unknown;
    };
    const problems: string[] = [];
    if (tx.successful !== true) problems.push("the transaction did not succeed");
    if (tx.source_account !== expect.source_account)
      problems.push("its source is not the sealing account");
    if (tx.memo_type !== "hash" || tx.memo !== rootToMemoBase64(expect.root))
      problems.push("its MEMO_HASH is not the day's root");
    if (Number(tx.ledger) !== expect.ledger) problems.push("it is in a different ledger");
    return problems.length === 0
      ? { kind: "match", ledger: expect.ledger }
      : { kind: "mismatch", problems };
  } catch (e) {
    return { kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * SEP-54 object key of the ledger-file batch that holds `ledger` (`%08X` of MaxUint32 − start, partition and batch;
 * a one-ledger batch has no end). The store's `.config.json` gives `ledgersPerBatch` and `batchesPerPartition` (AWS
 * pubnet: 1 and 64000; Lightsail mainnet: 8 and 64000).
 */
export function ledgerFileKey(
  ledger: number,
  ledgersPerBatch: number,
  batchesPerPartition: number,
): string {
  if (![ledger, ledgersPerBatch, batchesPerPartition].every((n) => Number.isInteger(n) && n >= 0))
    throw new Error("ledger file: integers only");
  if (ledgersPerBatch < 1 || batchesPerPartition < 1) throw new Error("ledger file: bad config");
  const hex = (n: number) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, "0");
  const perPartition = ledgersPerBatch * batchesPerPartition;
  const pStart = Math.floor(ledger / perPartition) * perPartition;
  const pEnd = pStart + perPartition - 1;
  const bStart = Math.floor(ledger / ledgersPerBatch) * ledgersPerBatch;
  const bEnd = bStart + ledgersPerBatch - 1;
  const partition =
    perPartition === 1 ? `${hex(pStart)}--${pStart}` : `${hex(pStart)}--${pStart}-${pEnd}`;
  const batch =
    ledgersPerBatch === 1 ? `${hex(bStart)}--${bStart}` : `${hex(bStart)}--${bStart}-${bEnd}`;
  return `${partition}/${batch}.xdr.zst`;
}

// --- the whole seal history against the ledger (plan C1 #10; the same rules as services/jobs src/seal/verify.ts) ---

export type SealHistoryProblem =
  | "chain_break"
  | "root_mismatch"
  | "memo_mismatch"
  | "ledger_mismatch"
  | "confirmed_tx_missing"
  | "unknown_seal_tx"
  | "out_of_order";

/** One transaction of a sealing account, as Horizon lists it. */
export interface HistoryTx {
  hash: string;
  successful: boolean;
  source_account: string;
  /** hex of the 32 memo bytes when the memo is a MEMO_HASH, else null */
  memo_hash_hex: string | null;
  ledger: number;
}

export interface SealHistoryFinding {
  problem: SealHistoryProblem;
  day: string | null;
  tx_hash: string | null;
}

export interface SealHistoryResult {
  ok: boolean;
  accounts: number;
  transactions: number;
  daysChecked: number;
  /** confirmed days older than the endpoint's history, and network_reset days */
  notCheckable: number;
  problems: SealHistoryFinding[];
}

function base64ToHex(b64: string): string | null {
  try {
    const bin = atob(b64);
    if (bin.length !== 32) return null;
    let h = "";
    for (let i = 0; i < bin.length; i++) h += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return h;
  } catch {
    return null;
  }
}

/**
 * Compares every published day of one network with the sealing accounts' full transaction histories (pure):
 * the chain itself (each `prev_root` is the previous day's root, each root recomputes), each confirmed day's
 * transaction (listed, memo = root, same ledger — unless older than `elderLedger`), every seal transaction's memo is a
 * published root, and seal transactions follow day order on the ledger. `network_reset` days are not checkable.
 */
export async function compareSealHistory(
  days: readonly SealDayView[],
  history: ReadonlyMap<string, readonly HistoryTx[]>,
  elderLedger: number | null,
): Promise<SealHistoryResult> {
  const problems: SealHistoryFinding[] = [];
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i] as SealDayView;
    const prev = sorted[i - 1];
    if (prev && d.prev_root !== prev.root)
      problems.push({ problem: "chain_break", day: d.day, tx_hash: null });
    let ok = false;
    try {
      ok =
        toHex(
          await dayRootFromPublicData({
            network: d.network.name,
            day: d.day,
            prev_root: d.prev_root,
            audit_anchor_sha256: d.audit_anchor_sha256,
            head_path: d.head_path,
          }),
        ) === d.root;
    } catch {
      ok = false;
    }
    if (!ok) problems.push({ problem: "root_mismatch", day: d.day, tx_hash: null });
  }
  const dayByRoot = new Map(sorted.map((d) => [d.root, d]));
  const txByHash = new Map<string, HistoryTx>();
  const seals: HistoryTx[] = [];
  let transactions = 0;
  for (const [account, txs] of history)
    for (const t of txs) {
      transactions++;
      txByHash.set(t.hash, t);
      if (t.successful && t.source_account === account && t.memo_hash_hex !== null) seals.push(t);
    }
  let daysChecked = 0;
  let notCheckable = 0;
  const explained = new Set<string>();
  for (const d of sorted) {
    if (d.status !== "confirmed" || !d.tx_hash || d.ledger === null) {
      if (d.status === "network_reset") notCheckable++;
      continue;
    }
    const t = txByHash.get(d.tx_hash);
    if (!t) {
      if (elderLedger !== null && d.ledger < elderLedger) {
        notCheckable++;
        continue;
      }
      daysChecked++;
      problems.push({ problem: "confirmed_tx_missing", day: d.day, tx_hash: d.tx_hash });
      continue;
    }
    daysChecked++;
    explained.add(t.hash);
    if (t.memo_hash_hex !== d.root)
      problems.push({ problem: "memo_mismatch", day: d.day, tx_hash: t.hash });
    if (t.ledger !== d.ledger)
      problems.push({ problem: "ledger_mismatch", day: d.day, tx_hash: t.hash });
  }
  let lastDay = "";
  for (const t of [...seals].sort((a, b) => a.ledger - b.ledger)) {
    const d = dayByRoot.get(t.memo_hash_hex as string);
    if (!d) {
      if (!explained.has(t.hash))
        problems.push({ problem: "unknown_seal_tx", day: null, tx_hash: t.hash });
      continue;
    }
    if (d.day < lastDay) problems.push({ problem: "out_of_order", day: d.day, tx_hash: t.hash });
    else lastDay = d.day;
  }
  return {
    ok: problems.length === 0,
    accounts: history.size,
    transactions,
    daysChecked,
    notCheckable,
    problems,
  };
}

/** Pages Horizon may return for one account before the walk gives up (200 transactions each). */
export const MAX_HISTORY_PAGES = 1000;

/**
 * Reads every page of each sealing account's transactions (ascending, successful only) from an allow-listed Horizon,
 * following `_links.next.href` on the same origin until a page has fewer than 200 records, plus the endpoint's
 * `history_elder_ledger`. Only when the reader asks for it (Horizon sees the reader's address).
 */
export async function fetchSealHistory(
  horizon: string,
  accounts: readonly string[],
  fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a),
): Promise<{ history: Map<string, HistoryTx[]>; elderLedger: number | null }> {
  const origin = new URL(horizon).origin;
  if (!(HORIZON_ORIGINS as readonly string[]).includes(origin))
    throw new Error(`${origin} is not an allowed Horizon`);
  const get = async (url: string) => {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/hal+json, application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Horizon answered ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const rootInfo = await get(`${origin}/`);
  const elder = Number(rootInfo.history_elder_ledger);
  const history = new Map<string, HistoryTx[]>();
  for (const account of [...new Set(accounts)].sort()) {
    if (!/^G[A-Z2-7]{55}$/.test(account)) continue;
    const txs: HistoryTx[] = [];
    let url: string | null =
      `${origin}/accounts/${account}/transactions?order=asc&limit=200&include_failed=false`;
    for (let page = 0; url !== null; page++) {
      if (page >= MAX_HISTORY_PAGES)
        throw new Error("the account's history is too long to walk here");
      const body = await get(url);
      const records = ((body._embedded as { records?: unknown[] } | undefined)?.records ??
        []) as Record<string, unknown>[];
      for (const r of records)
        txs.push({
          hash: String(r.hash),
          successful: r.successful === true,
          source_account: String(r.source_account),
          memo_hash_hex:
            r.memo_type === "hash" && typeof r.memo === "string" ? base64ToHex(r.memo) : null,
          ledger: Number(r.ledger),
        });
      const next = (body._links as { next?: { href?: unknown } } | undefined)?.next?.href;
      url = null;
      if (records.length >= 200 && typeof next === "string") {
        const n = new URL(next, origin);
        if (n.origin !== origin) throw new Error("Horizon pointed the next page at another host");
        url = n.toString();
      }
    }
    history.set(account, txs);
  }
  return { history, elderLedger: Number.isInteger(elder) ? elder : null };
}

/** The earliest day the published seal history is looked for (before the platform existed). */
export const SEAL_HISTORY_FLOOR = "2025-01-01";

/**
 * Every published seal day of the network: windows of at most 400 days walked backwards from tomorrow until a window
 * is empty (the chain has no gaps of that length) or SEAL_HISTORY_FLOOR is passed. `window(start, end)` answers
 * `GET /public/v1/seals?start=…&end=…` (UTC midnights, end exclusive).
 */
export async function loadAllSealDays(
  window: (start: string, end: string) => Promise<readonly SealDayView[]>,
  now: number = Date.now(),
): Promise<SealDayView[]> {
  const DAY = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const floor = Date.parse(`${SEAL_HISTORY_FLOOR}T00:00:00Z`);
  let end = Math.floor(now / DAY) * DAY + DAY;
  const out = new Map<string, SealDayView>();
  while (end > floor) {
    const start = Math.max(floor, end - 400 * DAY);
    const days = await window(iso(start), iso(end));
    for (const d of days) out.set(d.day, d);
    if (days.length === 0) break;
    end = start;
  }
  return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
