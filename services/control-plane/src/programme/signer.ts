// SPDX-License-Identifier: Apache-2.0
// Signing of traction snapshots (C-47, wire-formats §i.3) by job `public_metrics` in the JOBS service:
// the internet-facing control plane only inserts a pending request (tenant, period, include_api) and serves the
// signed row; it never holds the private key. This worker computes the figures itself from the request — a pending row
// carries no document the control plane could have written — signs JCS(snapshot) with Ed25519 and fills the row once
// (migration 0060: only a row whose signature is NULL can be updated, only by this job).
//
// Schema v1 (§i.3.1) or v2 (§i.3.2, C-136) as the request says. Every snapshot signed from C-136 on gets the tenant's
// next series number (C-137; the database trigger refuses any other), v2 documents also carry it with the previous
// snapshot's hash and the methodology version.
//
// Schedule: every interval (default 30 s) and on `NOTIFY scf_snapshot` (direct connection, LISTEN only).

import { createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import pg from "pg";
import type { Database, Tx, TxContext } from "../db/database.ts";
import { type CohortData, loadCohortData } from "../evidence/comparison.ts";
import { buildTractionDocumentV3, cohortWindows } from "../evidence/snapshot-v3.ts";
import { isoZ, monthStarts, projectInfo, tenantApi, tenantWeb } from "./figures.ts";
import { canonicalize } from "./jcs.ts";
import type { SealNetworkName } from "./seal-network.ts";
import { buildTractionDocumentV2, METHODOLOGY_VERSION, type Preset } from "./snapshot-v2.ts";

export const SNAPSHOT_SCHEMA = "scf-analytics/traction-snapshot/1";
export { SNAPSHOT_SCHEMA_V2 } from "./snapshot-v2.ts";

const JOB = "public_metrics";

/** Ed25519 private key of traction snapshots; lives in the jobs service only. */
export class TractionSigningKey {
  readonly kid: string;
  readonly #key: KeyObject;

  constructor(privateKeyPem: string, kid: string) {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("the traction-snapshot signing key must be Ed25519");
    this.#key = key;
    this.kid = kid;
  }

  /** base64url of the raw public key (JWKS `x`), for the control plane's SCF_SNAPSHOT_PUBLIC_KEY check. */
  publicX(): string {
    return createPublicKey(this.#key).export({ format: "jwk" }).x as string;
  }

  sign(doc: unknown): { canonical: Buffer; signature: Buffer; kid: string } {
    const canonical = Buffer.from(canonicalize(doc), "utf8");
    return { canonical, signature: sign(null, canonical, this.#key), kid: this.kid };
  }
}

export interface SnapshotRequest {
  tenantId: string;
  snapshotId: string;
  start: number;
  end: number;
  includeApi: boolean;
}

/** The snapshot document (wire-formats §i.3) from the rollups, read under the tenant's context. */
export async function buildTractionDocument(
  tx: Tx,
  r: SnapshotRequest,
  portalOrigin: string,
  now: number,
): Promise<Record<string, unknown>> {
  const p = await projectInfo(tx, r.tenantId);
  const web = await tenantWeb(tx, r.tenantId, r.start, r.end);
  const months = monthStarts(r.start, r.end);
  const monthOf = (day: number) => months.filter((m) => m <= day).pop() as number;
  const webMonthly = months.map((m) => ({
    start: isoZ(m),
    pageviews_verified: 0,
    visitors_sum_verified: 0,
  }));
  for (const d of web.days) {
    const row = webMonthly[months.indexOf(monthOf(d.day))];
    if (!row) continue;
    row.pageviews_verified += d.pv_v;
    row.visitors_sum_verified += d.vis_v;
  }
  const snapshot: Record<string, unknown> = {
    schema: SNAPSHOT_SCHEMA,
    snapshot_id: r.snapshotId,
    issued_at: isoZ(now),
    issuer: new URL(portalOrigin).host,
    project: {
      slug: p.slug,
      name: p.name,
      verification_level: p.verification_level,
      registry_matches: p.registry_matches,
    },
    period: { start: isoZ(r.start), end: isoZ(r.end) },
    web: {
      verified: web.verified,
      raw: web.raw,
      visit_metrics: web.visit_metrics,
      monthly: webMonthly,
    },
    definitions: `${portalOrigin}/docs/metric-definitions/1`,
  };
  if (r.includeApi) {
    const api = await tenantApi(tx, r.tenantId, r.start, r.end);
    const apiMonthly = months.map((m) => ({ start: isoZ(m), requests: 0 }));
    for (const d of api.days) {
      const row = apiMonthly[months.indexOf(monthOf(d.day))];
      if (row) row.requests += d.requests;
    }
    snapshot.api = {
      label: api.label,
      requests: api.requests,
      error_rate_5xx: api.error_rate_5xx,
      p95_ms: api.p95_ms,
      accuracy_class: api.accuracy_class,
      assurance_level: api.assurance_level,
      onchain_consistent: api.onchain_consistent,
      monthly: apiMonthly,
    };
  }
  return snapshot;
}

export interface SignerLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export type Outcome = "success" | "failure";

function jobCtx(tenantId: string | null): TxContext {
  return { tenantId, actorKind: "job", actorId: JOB, job: JOB };
}

export interface SignerOptions {
  portalOrigin: string;
  /** The deployment's Stellar network (v2 on-chain counts); default `public`. */
  onchainNetwork?: "public" | "testnet";
  /** The daily seal's network named in v2 documents (C-135); default `testnet`. */
  sealNetwork?: SealNetworkName;
  intervalMs: number;
  listenUrl?: string | undefined;
  log: SignerLogger;
  now?: () => number;
  onOutcome?: (o: Outcome) => void;
}

export class TractionSigner {
  readonly #db: Database;
  readonly #key: TractionSigningKey;
  readonly #opts: SignerOptions;
  #timer: NodeJS.Timeout | undefined;
  #listener: pg.Client | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(db: Database, key: TractionSigningKey, opts: SignerOptions) {
    this.#db = db;
    this.#key = key;
    this.#opts = opts;
  }

  async start(): Promise<void> {
    this.wake();
    this.#timer = setInterval(() => this.wake(), this.#opts.intervalMs);
    if (this.#opts.listenUrl) await this.#listen(this.#opts.listenUrl).catch(() => {});
  }

  async #listen(url: string): Promise<void> {
    const client = new pg.Client({
      connectionString: url,
      application_name: "scf-snapshot-signer",
    });
    client.on("error", () => {
      this.#listener = undefined;
      if (!this.#stopped) setTimeout(() => void this.#listen(url).catch(() => {}), 5000);
    });
    client.on("notification", () => this.wake());
    await client.connect();
    await client.query("LISTEN scf_snapshot");
    this.#listener = client;
  }

  /** Schedules a pass; concurrent wakes coalesce into one extra pass. */
  wake(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.runOnce();
        } while (this.#again && !this.#stopped);
      } finally {
        this.#running = undefined;
      }
    })();
  }

  /** Signs every pending snapshot; resolves to the number signed. Failures are per snapshot and retried next pass. */
  async runOnce(): Promise<number> {
    let pending: Array<{
      tenant_id: string;
      snapshot_id: string;
      period_start: Date;
      period_end: Date;
      include_api: boolean;
      schema_version: number;
      preset: Preset | null;
    }>;
    try {
      // Cross-tenant read of the work list (named job, no tenant context, data-model §6.3).
      pending = await this.#db.tx(jobCtx(null), (tx) =>
        tx.query(
          `SELECT tenant_id::text AS tenant_id, snapshot_id::text AS snapshot_id, period_start, period_end, include_api,
                  schema_version, preset
             FROM scf.traction_snapshots WHERE signature IS NULL ORDER BY created_at LIMIT 100`,
        ),
      );
    } catch (err) {
      this.#log(
        "error",
        { err: err instanceof Error ? err.name : "error" },
        "snapshot signing pass failed",
      );
      this.#opts.onOutcome?.("failure");
      return 0;
    }
    let n = 0;
    let failed = 0;
    for (const r of pending) {
      try {
        // v3 (SCF Evidence Link): the cohort position needs the other projects' figures — a cross-tenant read of
        // this job (tenant unset, C-17) in its own transaction; only the project's own position enters the document.
        const version = Number(r.schema_version);
        const preset = r.preset ?? "custom";
        let cohort: CohortData | null = null;
        if (version === 3)
          cohort = await this.#db.tx(jobCtx(null), (tx) =>
            loadCohortData(
              tx,
              r.tenant_id,
              cohortWindows(preset, r.period_start.getTime(), r.period_end.getTime()),
              this.#opts.onchainNetwork ?? "public",
            ),
          );
        const signed = await this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
          const now = (this.#opts.now ?? Date.now)();
          // C-137 series: one signer per tenant at a time; the next number and the previous snapshot's hash are fixed
          // before signing (the trigger refuses any other number, the unique constraint a concurrent duplicate).
          await tx.query(
            `SELECT pg_advisory_xact_lock(hashtextextended('scf.snapshot_series:' || $1, 0))`,
            [r.tenant_id],
          );
          const prev = await tx.maybeOne<{ seq: number; sha: string }>(
            `SELECT series_seq AS seq, encode(canonical_sha256, 'hex') AS sha FROM scf.traction_snapshots
              WHERE tenant_id = $1 AND series_seq IS NOT NULL ORDER BY series_seq DESC LIMIT 1`,
            [r.tenant_id],
          );
          const seq = (prev?.seq ?? 0) + 1;
          const request = {
            tenantId: r.tenant_id,
            snapshotId: r.snapshot_id,
            start: r.period_start.getTime(),
            end: r.period_end.getTime(),
            includeApi: r.include_api,
          };
          const v2 = version >= 2;
          const v2Request = { ...request, preset, seq, previousSha256: prev?.sha ?? null };
          const v2Options = {
            portalOrigin: this.#opts.portalOrigin,
            onchainNetwork: this.#opts.onchainNetwork ?? "public",
            sealNetwork: this.#opts.sealNetwork ?? "testnet",
          } as const;
          const doc =
            version === 3 && cohort
              ? await buildTractionDocumentV3(tx, v2Request, v2Options, now, cohort)
              : v2
                ? await buildTractionDocumentV2(tx, v2Request, v2Options, now)
                : await buildTractionDocument(tx, request, this.#opts.portalOrigin, now);
          const s = this.#key.sign(doc);
          const rows = await tx.query(
            `UPDATE scf.traction_snapshots
                SET document = $3, canonical_sha256 = sha256($4), signature = $5, kid = $6, series_seq = $7,
                    methodology_version = $8
              WHERE tenant_id = $1 AND snapshot_id = $2 AND signature IS NULL
              RETURNING snapshot_id`,
            [
              r.tenant_id,
              r.snapshot_id,
              JSON.stringify(doc),
              s.canonical,
              s.signature,
              s.kid,
              seq,
              v2 ? METHODOLOGY_VERSION : null,
            ],
          );
          return rows.length;
        });
        n += signed;
      } catch (err) {
        failed++;
        this.#log(
          "error",
          { tenant: r.tenant_id, err: err instanceof Error ? err.name : "error" },
          "traction snapshot signing failed",
        );
      }
    }
    if (n > 0) this.#log("info", { signed: n }, "traction snapshots signed");
    this.#opts.onOutcome?.(failed > 0 ? "failure" : "success");
    return n;
  }

  #log(level: "info" | "error", obj: object, msg: string): void {
    this.#opts.log[level](obj, msg);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#running;
    await this.#listener?.end().catch(() => {});
  }
}
