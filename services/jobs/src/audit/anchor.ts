// SPDX-License-Identifier: Apache-2.0
// Audit-chain anchoring and verification (C-63, ADR-0014; data-model §5; wire-formats §m).
//
// Job `audit_anchor` (daily 00:15 UTC, retried hourly) reads, for a UTC day D, the head of every chain as of D+1 00:00
// UTC (the last row before that instant; audit_log is readable under app.job = audit_anchor), builds the document of
// wire-formats §m (`generated_at` = that cut-off instant, so the document is deterministic and a rerun is
// byte-identical) and hands it to every configured publisher, then appends `audit.anchored` to the platform chain.
// Catch-up: every run anchors EVERY day a publisher is missing, from the first published day (or
// D−1 on the very first run, at most MAX_CATCH_UP_DAYS back) up to the previous day, in ascending order, so one failed
// run never leaves a gap that would stop `daily_seal` (which needs every day's document). An hourly run with nothing
// missing does nothing (no audit row).
//   FilePublisher           writes `audit-anchors/<date>.json` into a directory (a checkout of the public evidence
//                           repository; pushing it is the deployment's job) — atomic (temp file + link(2), which
//                           fails if the target exists), so a published day is never replaced, whatever error a
//                           read of it would give.
// The document's sha256 is the AUDIT LEAF of the day's seal (job `daily_seal`, seal/daily-seal.ts, wire-formats §m.2),
// which reads the file this job wrote. The per-day `manage_data` publisher (`scf-audit-<YYYYMMDD>` on the Stellar
// ledger) is superseded by the seal (C-136) and no longer written; entries already on the ledger stay verifiable
// (stellar/tx.ts: manageDataAnchorName, manageDataAnchorMatches).
// Job `audit_verify` (daily) recomputes every chain from its first row: canonical text v2 computed here, independently
// of the database's own function, `row_hash = sha256(prev_hash ‖ canonical)`, each `prev_hash` equal to the previous
// row's hash, sequence numbers without gaps, and — when a published anchor is available — the anchored (seq, row_hash)
// still present (audit_verify cannot read the live chain heads; the anchor is the external reference). A rewritten, inserted or deleted entry breaks one of these checks.

import { createHash } from "node:crypto";
import { link, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScfDb, Tx } from "../db.ts";
import { canonicalJson } from "../registry/sources.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import { addDays, utcDay } from "../schedule.ts";
import { rootFromHead, type SealNetwork } from "../seal/merkle.ts";

export const ANCHOR_SCHEMA = "scf-analytics/audit-anchor/1";
/** How far back one run fills missing anchor days (an outage of more than a year is an operator matter). */
export const MAX_CATCH_UP_DAYS = 400;
const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;
const PLATFORM = "00000000-0000-0000-0000-000000000000";

export interface ChainHead {
  chain_id: string;
  seq: number;
  row_hash: string;
}

export interface AnchorDocument {
  schema: typeof ANCHOR_SCHEMA;
  date: string;
  generated_at: string;
  chains: ChainHead[];
  sha256: string;
}

export function buildAnchor(date: string, generatedAt: Date, chains: ChainHead[]): AnchorDocument {
  const body = {
    schema: ANCHOR_SCHEMA,
    date,
    generated_at: `${generatedAt.toISOString().slice(0, 19)}Z`,
    chains: [...chains].sort((a, b) => a.chain_id.localeCompare(b.chain_id)),
  };
  return {
    ...body,
    sha256: createHash("sha256").update(canonicalJson(body)).digest("hex"),
  } as AnchorDocument;
}

/** Checks a document's own hash (anyone can do this with the published file). */
export function anchorSelfConsistent(doc: AnchorDocument): boolean {
  const { sha256, ...body } = doc;
  return createHash("sha256").update(canonicalJson(body)).digest("hex") === sha256;
}

export interface AnchorPublisher {
  readonly name: string;
  /** Publishes the document; returns "published" or "exists" (already published for that date). */
  publish(doc: AnchorDocument): Promise<"published" | "exists">;
  /** The dates already published, ascending (for the catch-up). */
  dates(): Promise<string[]>;
}

export class FilePublisher implements AnchorPublisher {
  readonly name = "file";
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = join(dir, "audit-anchors");
  }
  async publish(doc: AnchorDocument): Promise<"published" | "exists"> {
    await mkdir(this.#dir, { recursive: true });
    const target = join(this.#dir, `${doc.date}.json`);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(doc, null, 1)}\n`, { flag: "wx" });
    try {
      // link(2) never replaces an existing name: a published day stays as it is, whatever state its file is in.
      await link(tmp, target);
      return "published";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw err;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  async dates(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => DATE_FILE_RE.test(n))
      .map((n) => n.slice(0, 10))
      .sort();
  }
  /** The latest published anchor, if any. */
  async latest(): Promise<AnchorDocument | null> {
    const last = (await this.dates()).at(-1);
    if (!last) return null;
    return JSON.parse(await readFile(join(this.#dir, `${last}.json`), "utf8")) as AnchorDocument;
  }
}

export function auditAnchorJob(
  db: ScfDb,
  publishers: AnchorPublisher[],
  dailyAt: { hour: number; minute: number },
  hourlyMinute: number = dailyAt.minute,
): JobDef {
  return {
    name: "audit_anchor",
    triggers: [
      { schedule: { kind: "daily", ...dailyAt }, mode: "daily" },
      // retry: a failed daily run is repeated until every day is published
      { schedule: { kind: "hourly", minute: hourlyMinute }, mode: "hourly" },
    ],
    run: async (ctx) => {
      await runAuditAnchorCatchUp(db, publishers, ctx);
    },
  };
}

/** The days a catch-up run anchors: every day some publisher lacks, ascending, up to the previous UTC day (pure). */
export function anchorDaysToPublish(published: string[][], today: string): string[] {
  const end = addDays(today, -1);
  const floor = addDays(today, -MAX_CATCH_UP_DAYS);
  const firsts = published.map((d) => d[0]).filter((d): d is string => d !== undefined);
  let start = firsts.length > 0 ? firsts.sort()[0] : end;
  if (start === undefined || start < floor) start = floor;
  const sets = published.map((d) => new Set(d));
  const out: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (sets.length === 0 || sets.some((s) => !s.has(day))) out.push(day);
  }
  return out;
}

/** Anchors every missing day (see the header); returns the documents built, oldest first. */
export async function runAuditAnchorCatchUp(
  db: ScfDb,
  publishers: AnchorPublisher[],
  ctx: JobContext,
): Promise<AnchorDocument[]> {
  const published = await Promise.all(publishers.map((p) => p.dates()));
  const days = anchorDaysToPublish(published, utcDay(ctx.now));
  const docs: AnchorDocument[] = [];
  for (const date of days) {
    checkAborted(ctx.signal);
    docs.push(
      await runAuditAnchor(db, publishers, ctx, {
        date,
        cutoff: new Date(`${addDays(date, 1)}T00:00:00Z`),
      }),
    );
  }
  if (days.length === 0) ctx.log.info("audit_anchor_up_to_date", { job: "audit_anchor" });
  else if (days.length > 1)
    ctx.log.warn("audit_anchor_caught_up", {
      job: "audit_anchor",
      days: days.length,
      first: days[0] ?? null,
      last: days.at(-1) ?? null,
    });
  return docs;
}

export async function runAuditAnchor(
  db: ScfDb,
  publishers: AnchorPublisher[],
  ctx: JobContext,
  /** The day to anchor and its cut-off (the catch-up passes every missing day; tests may pass an earlier instant). */
  at?: { date: string; cutoff: Date },
): Promise<AnchorDocument> {
  // The anchor of day D is the state of every chain at D+1 00:00 UTC: the last row of each chain that occurred before
  // that instant. Deterministic, so a rerun (or the second core) publishes byte-identical content.
  const date = at?.date ?? addDays(utcDay(ctx.now), -1);
  const cutoff = at?.cutoff ?? new Date(`${addDays(date, 1)}T00:00:00Z`);
  const heads = await db.tx("audit_anchor", null, (tx) =>
    tx.query<ChainHead>(
      `SELECT DISTINCT ON (a.chain_id) a.chain_id::text AS chain_id, a.seq, encode(a.row_hash, 'hex') AS row_hash
         FROM scf.audit_log a WHERE a.occurred_at < $1 ORDER BY a.chain_id, a.seq DESC`,
      [cutoff],
    ),
  );
  const doc = buildAnchor(date, cutoff, heads);
  const outcome: Record<string, string> = {};
  for (const p of publishers) {
    checkAborted(ctx.signal);
    outcome[p.name] = await p.publish(doc);
  }
  await db.tx("audit_anchor", null, (tx) =>
    tx.audit("audit.anchored", "audit_anchor", doc.date, {
      sha256: doc.sha256,
      chains: heads.length,
      publishers: outcome,
    }),
  );
  ctx.metrics.units.inc({ job: "audit_anchor", outcome: "anchored" });
  ctx.log.info("audit_anchored", {
    job: "audit_anchor",
    date: doc.date,
    chains: heads.length,
    sha256: doc.sha256,
  });
  return doc;
}

// ------------------------------------------------------------------------------------------------ verification

export interface AuditRow {
  chain_id: string;
  seq: string;
  ts: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  tenant_id: string | null;
  target_type: string | null;
  target_id: string | null;
  subject_tenant_ids: string[] | null;
  outcome: string;
  details: string;
  request_id: string | null;
  prev_hash: Buffer;
  row_hash: Buffer;
}

/** PostgreSQL's escape_json: quotes, backslash, \b \f \n \r \t, other control characters as \u00xx. */
function pgJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

const jstr = (s: string | null) => (s === null ? "null" : pgJsonString(s));

/**
 * Canonical text v2 (data-model §5, C-114), computed outside the database: 'v2:' + the JSON array PostgreSQL's
 * json_build_array prints (elements separated by ", "; a text[] as a JSON array without spaces; details as its jsonb
 * text). Equality with scf.audit_canonical() is asserted by the integration test.
 */
export function canonicalV2(r: AuditRow): string {
  const subj =
    r.subject_tenant_ids === null
      ? "null"
      : `[${r.subject_tenant_ids.map(pgJsonString).join(",")}]`;
  const items = [
    jstr(r.chain_id),
    jstr(r.seq),
    jstr(r.ts),
    jstr(r.actor_kind),
    jstr(r.actor_id),
    jstr(r.action),
    jstr(r.tenant_id),
    jstr(r.target_type),
    jstr(r.target_id),
    subj,
    jstr(r.outcome),
    r.details,
    jstr(r.request_id),
  ];
  return `v2:[${items.join(", ")}]`;
}

export function rowHash(prev: Buffer, canonical: string): Buffer {
  return createHash("sha256").update(prev).update(canonical, "utf8").digest();
}

export interface ChainProblem {
  chain_id: string;
  seq: number;
  problem:
    | "row_hash_mismatch"
    | "prev_hash_mismatch"
    | "seq_gap"
    | "anchor_mismatch"
    /** the anchor file is not the document its day's seal committed to (or that seal day does not recompute) */
    | "anchor_seal_mismatch";
}

export interface VerifyResult {
  chains: number;
  rows: number;
  problems: ChainProblem[];
  anchorChecked: boolean;
  /** the anchor the chains were checked against is the one a seal day fixed (migration 0077) */
  sealChecked?: boolean;
  /** the date of that anchor */
  anchorDate?: string | null;
}

/** One seal day as audit_verify reads it (the fields that fix the audit leaf). */
export interface SealedDayRow {
  network: SealNetwork;
  day: string;
  prev_root: Buffer;
  audit_anchor_sha256: Buffer;
  head_path: Buffer[];
  root: Buffer;
}

/** The day's seal fixes this anchor: its hash is the audit leaf and the day's root recomputes from it (pure). */
export function anchorMatchesSeal(doc: AnchorDocument, seal: SealedDayRow): boolean {
  if (doc.date !== seal.day || !/^[0-9a-f]{64}$/.test(doc.sha256)) return false;
  const sha = Buffer.from(doc.sha256, "hex");
  if (!sha.equals(seal.audit_anchor_sha256)) return false;
  try {
    return rootFromHead(seal.network, seal.day, seal.prev_root, sha, seal.head_path).equals(
      seal.root,
    );
  } catch {
    return false;
  }
}

/**
 * Chooses the anchors the live chains are checked against (pure; migration 0077):
 *   - the latest document a seal day fixed (scf.sealed_audit_anchors, stored by daily_seal only when it matched the
 *     sealed hash) — the reference the ledger holds, so a rewritten audit row is caught even when the anchor file was
 *     rewritten along with it;
 *   - the file's latest anchor, unless a seal day of its date contradicts it (`anchor_seal_mismatch`): when that day
 *     is not sealed yet it is the freshest reference.
 * A stored sealed document that its own seal no longer fixes (a superuser rewrote the row) is `anchor_seal_mismatch`
 * as well and is not used.
 */
export function chooseAnchors(
  file: AnchorDocument | null,
  fileSeals: readonly SealedDayRow[],
  latestSealed: { doc: AnchorDocument; seals: readonly SealedDayRow[] } | null,
): { anchors: AnchorDocument[]; sealed: boolean; problems: ChainProblem[] } {
  const problems: ChainProblem[] = [];
  const anchors: AnchorDocument[] = [];
  let sealed = false;
  if (latestSealed !== null) {
    const ok =
      latestSealed.seals.length > 0 &&
      anchorSelfConsistent(latestSealed.doc) &&
      latestSealed.seals.every((s) => anchorMatchesSeal(latestSealed.doc, s));
    if (ok) {
      anchors.push(latestSealed.doc);
      sealed = true;
    } else problems.push({ chain_id: PLATFORM, seq: 0, problem: "anchor_seal_mismatch" });
  }
  if (file !== null) {
    if (fileSeals.length > 0 && !fileSeals.every((s) => anchorMatchesSeal(file, s))) {
      problems.push({ chain_id: PLATFORM, seq: 0, problem: "anchor_seal_mismatch" });
    } else if (!anchors.some((a) => a.date === file.date)) {
      anchors.push(file);
      if (fileSeals.length > 0) sealed = true;
    }
  }
  return { anchors, sealed, problems };
}

export const AUDIT_SELECT = `SELECT a.chain_id::text, a.seq::text,
         to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
         a.actor_kind, a.actor_id, a.action, a.tenant_id::text, a.target_type, a.target_id,
         a.subject_tenant_ids::text[] AS subject_tenant_ids, a.outcome, a.details::text AS details, a.request_id,
         a.prev_hash, a.row_hash
    FROM scf.audit_log a`;

const BATCH = 5000;

async function verifyChain(
  tx: Tx,
  chainId: string,
  anchored: readonly ChainHead[],
  problems: ChainProblem[],
): Promise<number> {
  let prev: Buffer = Buffer.alloc(32);
  let expectSeq = 1;
  let rows = 0;
  const seen = new Set<number>();
  for (;;) {
    const batch = await tx.query<AuditRow>(
      `${AUDIT_SELECT} WHERE a.chain_id = $1::uuid AND a.seq >= $2 ORDER BY a.seq LIMIT $3`,
      [chainId, expectSeq, BATCH],
    );
    for (const r of batch) {
      const seq = Number(r.seq);
      if (seq !== expectSeq) problems.push({ chain_id: chainId, seq, problem: "seq_gap" });
      if (!r.prev_hash.equals(prev))
        problems.push({ chain_id: chainId, seq, problem: "prev_hash_mismatch" });
      const h = rowHash(r.prev_hash, canonicalV2(r));
      if (!h.equals(r.row_hash))
        problems.push({ chain_id: chainId, seq, problem: "row_hash_mismatch" });
      anchored.forEach((a, i) => {
        if (seq !== a.seq) return;
        seen.add(i);
        if (h.toString("hex") !== a.row_hash)
          problems.push({ chain_id: chainId, seq, problem: "anchor_mismatch" });
      });
      prev = h;
      expectSeq = seq + 1;
      rows += 1;
    }
    if (batch.length < BATCH) break;
  }
  anchored.forEach((a, i) => {
    if (!seen.has(i)) problems.push({ chain_id: chainId, seq: a.seq, problem: "anchor_mismatch" });
  });
  return rows;
}

export async function verifyAuditChains(
  db: ScfDb,
  anchor: AnchorDocument | readonly AnchorDocument[] | null,
  ctx: JobContext,
): Promise<VerifyResult> {
  const anchors: readonly AnchorDocument[] =
    anchor === null ? [] : Array.isArray(anchor) ? anchor : [anchor as AnchorDocument];
  // One transaction; chains are append-only, so rows appended meanwhile are simply verified too.
  const res = await db.tx("audit_verify", null, async (tx) => {
    const chains = await tx.query<{ chain_id: string }>(
      "SELECT DISTINCT a.chain_id::text AS chain_id FROM scf.audit_log a ORDER BY 1",
    );
    // Heads are readable only by audit_anchor; audit_verify compares against the anchors instead.
    const problems: ChainProblem[] = [];
    let rows = 0;
    const anchored = new Map<string, ChainHead[]>();
    for (const a of anchors)
      for (const c of a.chains) anchored.set(c.chain_id, [...(anchored.get(c.chain_id) ?? []), c]);
    for (const { chain_id } of chains) {
      checkAborted(ctx.signal);
      rows += await verifyChain(tx, chain_id, anchored.get(chain_id) ?? [], problems);
      anchored.delete(chain_id);
    }
    // An anchored chain that has disappeared entirely.
    for (const heads of anchored.values())
      for (const c of heads)
        problems.push({ chain_id: c.chain_id, seq: c.seq, problem: "anchor_mismatch" });
    return { chains: chains.length, rows, problems, anchorChecked: anchors.length > 0 };
  });
  return res;
}

export function auditVerifyJob(
  db: ScfDb,
  anchors: FilePublisher | null,
  dailyAt: { hour: number; minute: number },
): JobDef {
  return {
    name: "audit_verify",
    triggers: [{ schedule: { kind: "daily", ...dailyAt }, mode: "daily" }],
    run: async (ctx) => {
      await runAuditVerify(db, anchors, ctx);
    },
  };
}

export async function runAuditVerify(
  db: ScfDb,
  anchors: FilePublisher | null,
  ctx: JobContext,
): Promise<VerifyResult> {
  const file = anchors ? await anchors.latest() : null;
  if (file && !anchorSelfConsistent(file)) {
    throw Object.assign(new Error("published anchor fails its own hash"), {
      name: "AnchorCorrupt",
    });
  }
  // The seal (migration 0077): the seal days of the file's day, and the latest document a seal day fixed.
  const seals = await db.tx("audit_verify", null, async (tx) => {
    const cols = `d.network, d.day::text AS day, d.prev_root, d.audit_anchor_sha256, d.head_path, d.root`;
    const fileSeals = file
      ? await tx.query<SealedDayRow>(`SELECT ${cols} FROM scf.seal_days d WHERE d.day = $1::date`, [
          file.date,
        ])
      : [];
    const [last] = await tx.query<{ day: string; document: AnchorDocument }>(
      `SELECT a.day::text AS day, a.document FROM scf.sealed_audit_anchors a ORDER BY a.day DESC LIMIT 1`,
    );
    const lastSeals = last
      ? await tx.query<SealedDayRow>(`SELECT ${cols} FROM scf.seal_days d WHERE d.day = $1::date`, [
          last.day,
        ])
      : [];
    return { fileSeals, latest: last ? { doc: last.document, seals: lastSeals } : null };
  });
  const choice = chooseAnchors(file, seals.fileSeals, seals.latest);
  const checked = await verifyAuditChains(db, choice.anchors, ctx);
  const anchorDate =
    choice.anchors
      .map((a) => a.date)
      .sort()
      .at(-1) ?? null;
  const r: VerifyResult = {
    ...checked,
    problems: [...choice.problems, ...checked.problems],
    sealChecked: choice.sealed,
    anchorDate,
  };
  ctx.metrics.audit.broken.set({}, r.problems.length);
  ctx.metrics.audit.rows.set({}, r.rows);
  await db.tx("audit_verify", null, (tx) =>
    tx.audit("audit.verified", "audit_log", "all", {
      chains: r.chains,
      rows: r.rows,
      problems: r.problems.length,
      first_problems: r.problems.slice(0, 20),
      anchor_date: anchorDate,
      anchor_sealed: choice.sealed,
    }),
  );
  ctx.log.info("audit_verified", {
    job: "audit_verify",
    chains: r.chains,
    rows: r.rows,
    problems: r.problems.length,
    anchor_date: anchorDate,
    anchor_sealed: choice.sealed,
  });
  if (r.problems.length > 0) {
    throw Object.assign(new Error("audit chain verification failed"), { name: "AuditChainBroken" });
  }
  return r;
}

export { PLATFORM as PLATFORM_CHAIN };
