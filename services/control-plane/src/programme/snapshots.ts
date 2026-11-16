// SPDX-License-Identifier: Apache-2.0
// Signed traction snapshots (C-47, ADR-0032, wire-formats §i.3; data-model §8.13): a tenant `admin`/`owner` freezes the
// project's exact web (and, by default, API) figures for a period of whole UTC days, signed with the platform's
// Ed25519 snapshot key over JCS(snapshot). Anyone verifies with the published JWKS and may fetch the stored copy, which
// reports `revoked` once the tenant revokes it (the signature still verifies). No trust score, no per-route or
// per-referrer detail.

import { isWholeIsoWeeks } from "../evidence/presets.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { uuidv7 } from "../util/ids.ts";
import { DAY, isoZ } from "./figures.ts";
import type { SnapshotKeys } from "./keys.ts";
import type { Preset } from "./snapshot-v2.ts";

export { SNAPSHOT_SCHEMA } from "./signer.ts";

const MAX_DAYS = 400;

/** [start, end) is exactly one calendar quarter (starts 1 Jan/Apr/Jul/Oct 00:00 UTC; wire-formats §i.3.2). */
export function isCalendarQuarter(start: number, end: number): boolean {
  const d = new Date(start);
  if (d.getUTCDate() !== 1 || d.getUTCMonth() % 3 !== 0 || start % DAY !== 0) return false;
  return end === Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1);
}

export interface SnapshotDeps {
  /** Public keys only (JWKS); the private key is held by the jobs service. */
  keys: SnapshotKeys;
  portalOrigin: string;
  now?: () => number;
  /** How long a create waits for the jobs service's signature before answering 202 (default 10 s). */
  waitMs?: number;
  pollMs?: number;
  /** In-process wake-up of a signer (tests); production relies on NOTIFY scf_snapshot. */
  wakeSigner?: (() => void) | undefined;
}

function bad(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

function b64u(b: Buffer): string {
  return b.toString("base64url");
}

interface SnapshotRow extends Record<string, unknown> {
  snapshot_id: string;
  period_start: Date;
  period_end: Date;
  created_at: Date;
  revoked_at: Date | null;
  signed: boolean;
  schema_version: number;
  preset: Preset | null;
}

export function snapshotHandlers(deps: SnapshotDeps): Record<string, Handler> {
  const clock = deps.now ?? Date.now;
  const verifyUrl = (id: string) => `${deps.portalOrigin}/public/v1/snapshots/${id}`;
  const summary = (r: SnapshotRow) => ({
    snapshot_id: r.snapshot_id,
    period_start: isoZ(r.period_start.getTime()),
    period_end: isoZ(r.period_end.getTime()),
    created_at: r.created_at.toISOString(),
    revoked_at: r.revoked_at?.toISOString() ?? null,
    status: r.signed ? "signed" : "pending",
    verify_url: verifyUrl(r.snapshot_id),
    schema_version: Number(r.schema_version),
    preset: r.preset,
  });

  const listTractionSnapshots: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) =>
      tx.query<SnapshotRow>(
        `SELECT snapshot_id::text AS snapshot_id, period_start, period_end, created_at, revoked_at,
                (signature IS NOT NULL) AS signed, schema_version, preset
           FROM scf.traction_snapshots WHERE tenant_id = $1 ORDER BY created_at DESC, snapshot_id`,
        [ctx.tenant?.id],
      ),
    );
    return { status: 200, body: rows.map(summary) };
  };

  const createTractionSnapshot: Handler = async (ctx) => {
    const b = ctx.body as {
      period_start: string;
      period_end: string;
      include_api?: boolean;
      schema_version?: 1 | 2 | 3;
      preset?: Preset;
    };
    const start = Date.parse(b.period_start);
    const end = Date.parse(b.period_end);
    const now = clock();
    const today = Math.floor(now / DAY) * DAY;
    if (!(end > start)) throw bad("/period_end", "period_end must be after period_start");
    if (end - start > MAX_DAYS * DAY)
      throw bad("/period_end", `the period is at most ${MAX_DAYS} days`);
    if (end > today) throw bad("/period_end", "period_end must not be after today 00:00 UTC");
    // C-136: v2 is the default; a preset is a v2 label (v1 creation is deprecated and takes none).
    const version = b.schema_version ?? 2;
    if (version === 1 && b.preset !== undefined)
      throw bad("/preset", "a preset is not allowed with schema_version 1");
    const preset: Preset | null = version >= 2 ? (b.preset ?? "custom") : null;
    if (preset === "pg_renewal_quarter" && !isCalendarQuarter(start, end))
      throw bad("/period_start", "pg_renewal_quarter needs exactly one calendar quarter");
    // v3 (SCF Evidence Link): a Growth Hack campaign is compared week by week with the same number of whole ISO weeks
    // before it, so its period must be whole ISO weeks (Monday 00:00 UTC to Monday 00:00 UTC).
    if (
      version === 3 &&
      (preset === "growth_hack_during" || preset === "growth_hack_before") &&
      !isWholeIsoWeeks(start, end)
    )
      throw bad(
        "/period_start",
        "a Growth Hack preset needs whole ISO weeks (Monday to Monday, UTC)",
      );
    if (version === 3 && preset === "growth_hack_during" && end - start > 200 * DAY)
      throw bad(
        "/period_end",
        "a Growth Hack campaign is at most 200 days (its baseline doubles the read)",
      );
    if (!deps.keys.configured)
      throw new ApiError("unavailable", "traction snapshots are not configured (signing key)", {
        retryAfter: 3600,
      });
    const tenantId = ctx.tenant?.id as string;
    const snapshotId = uuidv7(now);
    // F16: the control plane only records the request; job public_metrics in the jobs service computes the figures
    // itself and signs them (the signing key never reaches this process). NOTIFY scf_snapshot wakes it at commit.
    await ctx.tx(async (tx) => {
      await tx.audit({
        action: "snapshot.created",
        targetType: "traction_snapshot",
        targetId: snapshotId,
        details: {
          period_start: isoZ(start),
          period_end: isoZ(end),
          schema_version: version,
          ...(preset ? { preset } : {}),
        },
      });
      // Creating a snapshot publishes it (C-137): once signed, its id, period, preset and hash are on the project's
      // public list (getPublicSnapshotList), which the create form states before the tenant confirms.
      await tx.query(
        `INSERT INTO scf.traction_snapshots (tenant_id, snapshot_id, created_by, period_start, period_end, include_api,
                                             schema_version, preset)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          snapshotId,
          ctx.session?.userId,
          new Date(start),
          new Date(end),
          b.include_api !== false,
          version,
          preset,
        ],
      );
      await tx.query(`SELECT pg_notify('scf_snapshot', '')`);
    });
    deps.wakeSigner?.();
    // Wait (short transactions, no lock held) for the signed copy; a slow signer answers 202 with the verify URL.
    const deadline = Date.now() + (deps.waitMs ?? 10_000);
    for (;;) {
      const row = await ctx.tx((tx) =>
        tx.maybeOne<{
          document: Record<string, unknown> | null;
          signature: Buffer | null;
          kid: string | null;
        }>(
          `SELECT document, signature, kid FROM scf.traction_snapshots WHERE tenant_id = $1 AND snapshot_id = $2`,
          [tenantId, snapshotId],
        ),
      );
      if (row?.document && row.signature && row.kid) {
        return {
          status: 201,
          body: {
            snapshot: row.document,
            signature: { alg: "Ed25519", kid: row.kid, sig: b64u(row.signature) },
          },
          headers: { location: verifyUrl(snapshotId), "cache-control": "no-store" },
        };
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 200));
    }
    return {
      status: 202,
      body: { snapshot_id: snapshotId, status: "pending", verify_url: verifyUrl(snapshotId) },
      headers: {
        location: verifyUrl(snapshotId),
        "retry-after": "10",
        "cache-control": "no-store",
      },
    };
  };

  const revokeTractionSnapshot: Handler = async (ctx) => {
    const id = ctx.params.snapshotId as string;
    const reason = (ctx.body as { reason: string }).reason;
    await ctx.tx(async (tx) => {
      const cur = await tx.maybeOne<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM scf.traction_snapshots WHERE tenant_id = $1 AND snapshot_id = $2 FOR UPDATE`,
        [ctx.tenant?.id, id],
      );
      if (!cur) throw new ApiError("not_found");
      await tx.audit({
        action: "snapshot.revoked",
        targetType: "traction_snapshot",
        targetId: id,
        details: cur.revoked_at ? { already_revoked: true } : {},
      });
      if (cur.revoked_at) return;
      await tx.query(
        `UPDATE scf.traction_snapshots SET revoked_at = now(), revoked_reason = left($3, 200)
          WHERE tenant_id = $1 AND snapshot_id = $2`,
        [ctx.tenant?.id, id, reason],
      );
    });
    return { status: 204 };
  };

  const getPublicSnapshot: Handler = async (ctx) => {
    const row = await ctx.tx(
      (tx) =>
        tx.maybeOne<{ d: Record<string, unknown> | null }>(
          `SELECT scf.public_snapshot($1::uuid) AS d`,
          [ctx.params.snapshotId],
        ),
      { tenantId: null, actorKind: "anonymous", actorId: null },
    );
    const d = row?.d;
    // A pending snapshot (not signed yet, F16) has no document: nothing to show.
    if (!d?.snapshot) throw new ApiError("not_found");
    const revoked = d.revoked_at ? new Date(String(d.revoked_at)).toISOString() : null;
    return {
      status: 200,
      body: { snapshot: d.snapshot, signature: d.signature, status: d.status, revoked_at: revoked },
      // Short: a revocation must become visible soon (§i.3 step 4).
      headers: { "cache-control": "public, max-age=60" },
    };
  };

  const getSnapshotKeys: Handler = async () => ({
    status: 200,
    body: deps.keys.jwks(),
    headers: { "cache-control": "public, max-age=3600" },
  });

  return {
    listTractionSnapshots,
    createTractionSnapshot,
    revokeTractionSnapshot,
    getPublicSnapshot,
    getSnapshotKeys,
  };
}
