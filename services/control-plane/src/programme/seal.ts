// SPDX-License-Identifier: Apache-2.0
// Public reads of the traction-snapshot series and the daily seal (wire-formats §i.3.3, §m.2; C-136, C-137):
//   - getPublicSnapshotList: every snapshot a project signed from C-136 on, in series order with each entry's
//     previous hash, so a reader checks the list is gap-free (scf.public_snapshot_list, owner scf_definer);
//   - getSnapshotSealProof: the inclusion proof(s) of one snapshot, final leaves only (scf.public_seal_proof);
//   - listSealDays / getSealDay: the seal days of the configured network (global table, no tenant data).
// Every seal response names the network and, on testnet, says that the seal is a demonstration; none says or implies
// that the numbers are genuine (the fixed `statement`). Anonymous context throughout: no tenant table is read directly.

import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { DAY, isoZ } from "./figures.ts";
import {
  explorerUrl,
  networkSettings,
  SEAL_STATEMENT,
  type SealNetworkConfig,
  type SealNetworkName,
  sealNetworkView,
} from "./seal-network.ts";

const MAX_SEAL_DAYS = 400;
const ANON = { tenantId: null, actorKind: "anonymous" as const, actorId: null };

export interface SealDeps {
  portalOrigin: string;
  seal: SealNetworkConfig;
  now?: () => number;
}

interface SealDayRow extends Record<string, unknown> {
  day: string;
  network: SealNetworkName;
  segment: number;
  prev_root: string;
  root: string;
  audit_anchor_sha256: string;
  leaf_count: number;
  head_path: string[] | null;
  status: string;
  source_account: string | null;
  tx_hash: string | null;
  ledger: string | null;
  confirmed_at: Date | null;
}

const SEAL_DAY_COLS = `day::text AS day, network, segment, encode(prev_root, 'hex') AS prev_root,
  encode(root, 'hex') AS root, encode(audit_anchor_sha256, 'hex') AS audit_anchor_sha256, leaf_count,
  ARRAY(SELECT encode(x.h, 'hex') FROM unnest(head_path) WITH ORDINALITY AS x(h, o) ORDER BY x.o) AS head_path,
  status, source_account, encode(tx_hash, 'hex') AS tx_hash, ledger::text AS ledger, confirmed_at`;

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function sealDayView(cfg: SealNetworkConfig, r: SealDayRow): Record<string, unknown> {
  return {
    day: r.day,
    network: sealNetworkView(networkSettings(cfg, r.network)),
    segment: Number(r.segment),
    prev_root: r.prev_root,
    root: r.root,
    audit_anchor_sha256: r.audit_anchor_sha256,
    leaf_count: Number(r.leaf_count),
    head_path: r.head_path ?? [],
    status: r.status,
    source_account: r.source_account,
    tx_hash: r.tx_hash,
    ledger: r.ledger === null ? null : Number(r.ledger),
    confirmed_at: iso(r.confirmed_at),
  };
}

/** One entry of `scf.public_seal_proof` (jsonb) as a `SealProof`. */
export function sealProofView(
  cfg: SealNetworkConfig,
  p: Record<string, unknown>,
): Record<string, unknown> {
  const net = networkSettings(cfg, p.network as SealNetworkName);
  const txHash = (p.tx_hash as string | null) ?? null;
  return {
    schema: "scf-analytics/seal-proof/1",
    network: sealNetworkView(net),
    snapshot_id: p.snapshot_id,
    snapshot_sha256: p.snapshot_sha256,
    day: p.day,
    segment: Number(p.segment),
    leaf_index: Number(p.leaf_index),
    leaf_count: Number(p.leaf_count),
    salt: p.salt,
    leaf_hash: p.leaf_hash,
    audit_path: (p.audit_path as string[] | null) ?? [],
    head_path: (p.head_path as string[] | null) ?? [],
    root: p.root,
    prev_root: p.prev_root,
    audit_anchor_sha256: p.audit_anchor_sha256,
    status: p.status,
    source_account: (p.source_account as string | null) ?? null,
    tx_hash: txHash,
    ledger: p.ledger === null || p.ledger === undefined ? null : Number(p.ledger),
    confirmed_at: iso(p.confirmed_at),
    explorer_url: explorerUrl(net, txHash),
    statement: SEAL_STATEMENT,
  };
}

function bad(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

/** A `[start, end)` range of whole UTC days (dayStart/dayEnd), at most `max` days. */
export function dayRange(q: Record<string, unknown>, max: number): { start: number; end: number } {
  const start = Date.parse(String(q.start));
  const end = Date.parse(String(q.end));
  if (Number.isNaN(start) || start % DAY !== 0) throw bad("/start", "start must be midnight UTC");
  if (Number.isNaN(end) || end % DAY !== 0) throw bad("/end", "end must be midnight UTC");
  if (!(end > start)) throw bad("/end", "end must be after start");
  if (end - start > max * DAY) throw bad("/end", `the range is at most ${max} days`);
  return { start, end };
}

export function sealHandlers(deps: SealDeps): Record<string, Handler> {
  const cfg = deps.seal;
  const snapshotUrl = (id: string) => `${deps.portalOrigin}/public/v1/snapshots/${id}`;

  const getPublicSnapshotList: Handler = async (ctx) => {
    const slug = ctx.params.slug as string;
    const rows = await ctx.tx(
      (tx: Tx) =>
        tx.query<{
          snapshot_id: string;
          series_seq: number;
          previous_sha256: string | null;
          schema_version: number;
          preset: string | null;
          period_start: Date;
          period_end: Date;
          signed_at: Date;
          canonical_sha256: string;
          status: "valid" | "revoked";
          revoked_at: Date | null;
        }>(
          `SELECT snapshot_id::text AS snapshot_id, series_seq, previous_sha256, schema_version, preset, period_start,
                  period_end, signed_at, canonical_sha256, status, revoked_at
             FROM scf.public_snapshot_list($1)`,
          [slug],
        ),
      ANON,
    );
    // An unknown slug, a tenant that is not active/suspended and one that has issued no listed snapshot look the same
    // from outside (the definer function returns no row for each): 404, so the list is no slug-existence oracle.
    if (rows.length === 0) throw new ApiError("not_found");
    return {
      status: 200,
      body: {
        schema: "scf-analytics/snapshot-list/1",
        project: { slug },
        generated_at: isoZ(deps.now?.() ?? Date.now()),
        snapshots: rows.map((r) => ({
          snapshot_id: r.snapshot_id,
          seq: Number(r.series_seq),
          previous_sha256: r.previous_sha256,
          schema_version: Number(r.schema_version),
          preset: r.preset,
          period: { start: isoZ(r.period_start.getTime()), end: isoZ(r.period_end.getTime()) },
          signed_at: r.signed_at.toISOString(),
          sha256: r.canonical_sha256,
          status: r.status,
          revoked_at: r.revoked_at?.toISOString() ?? null,
          url: snapshotUrl(r.snapshot_id),
        })),
      },
      headers: { "cache-control": "public, max-age=300" },
    };
  };

  const getSnapshotSealProof: Handler = async (ctx) => {
    const row = await ctx.tx(
      (tx: Tx) =>
        tx.maybeOne<{ p: Array<Record<string, unknown>> | null }>(
          `SELECT scf.public_seal_proof($1::uuid) AS p`,
          [ctx.params.snapshotId],
        ),
      ANON,
    );
    const proofs = row?.p ?? [];
    if (proofs.length === 0) throw new ApiError("not_found");
    return {
      status: 200,
      body: { proofs: proofs.map((p) => sealProofView(cfg, p)) },
      headers: { "cache-control": "public, max-age=300" },
    };
  };

  const listSealDays: Handler = async (ctx) => {
    const { start, end } = dayRange(ctx.query, MAX_SEAL_DAYS);
    const rows = await ctx.tx(
      (tx: Tx) =>
        tx.query<SealDayRow>(
          `SELECT ${SEAL_DAY_COLS} FROM scf.seal_days
            WHERE network = $1 AND day >= $2::date AND day < $3::date ORDER BY day`,
          [cfg.name, isoZ(start).slice(0, 10), isoZ(end).slice(0, 10)],
        ),
      ANON,
    );
    return {
      status: 200,
      body: {
        network: sealNetworkView(cfg),
        days: rows.map((r) => sealDayView(cfg, r)),
        statement: SEAL_STATEMENT,
      },
      headers: { "cache-control": "public, max-age=300" },
    };
  };

  const getSealDay: Handler = async (ctx) => {
    const day = ctx.params.day as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)))
      throw new ApiError("not_found");
    const row = await ctx.tx(
      (tx: Tx) =>
        tx.maybeOne<SealDayRow>(
          `SELECT ${SEAL_DAY_COLS} FROM scf.seal_days WHERE network = $1 AND day = $2::date`,
          [cfg.name, day],
        ),
      ANON,
    );
    if (!row) throw new ApiError("not_found");
    return {
      status: 200,
      body: { seal: sealDayView(cfg, row), statement: SEAL_STATEMENT },
      headers: { "cache-control": "public, max-age=300" },
    };
  };

  return { getPublicSnapshotList, getSnapshotSealProof, listSealDays, getSealDay };
}
