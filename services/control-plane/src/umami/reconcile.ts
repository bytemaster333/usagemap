// SPDX-License-Identifier: Apache-2.0
// Job `umami_reconcile` (data-model §6.3, §8.4, §8.7; wire-formats §j.2; C-73, C-85, C-99, C-112(7)/(9), C-113).
// Runs inside the control-plane process as `scf_jobs` with `app.job = umami_reconcile`, through the engine proxy with
// the provisioner certificate. One pass:
//   1. single instance: `pg_try_advisory_xact_lock` held by the pass's own read transaction (works through PgBouncer
//      in transaction mode, data-model §6.3); a second instance skips the pass;
//   2. cross-tenant read of tenants, sites and credentials (job context, no tenant);
//   3. P1 as the provisioning admin (bootstrap B1–B5 is the separate `umami-bootstrap` one-shot);
//   4. provisioning of every pending/active/suspended tenant without credentials — restartable (below) — stored under
//      that tenant's context;
//   5. P7 for every main website the engine lacks; P7t for twins with `twin_provisioned_at` null, then that column is
//      set and NOTIFY scf_edge is sent (the snapshot carries the twin from then on);
//   6. websites in the engine that no site references (P12 vs `sites`): visit-token purge on EVERY core first, then
//      P13 + P9 (C-112(9)); a circuit breaker refuses mass deletion (an empty or partial read must never empty Umami);
//   7. key rotation (C-85) for tenants whose key is older than `rotateAfterDays`;
//   8. re-wrap: credentials of EVERY tenant (any status: pending, suspended, removed too) still encrypted under an
//      older K_umami_creds version are re-encrypted under the current one, so retiring an old key version never makes
//      a removed tenant's restoration or purge undecryptable;
//   9. site ↔ website check (plan C1 #12): orphans left in the engine, sites whose website is missing, websites
//      outside the tenant's team — published as the gauge `scf_cp_umami_site_drift{kind}` and logged, so operators
//      are alerted (ops/alerts) instead of finding out through silent rollup fallbacks.
//
// Restartability of step 4: the tenant user's password is derived, not random — HMAC-SHA-256 over a fixed label and the
// tenant id under K_umami_creds[current] — so a pass that crashed after P2 (user exists, nothing stored) logs in as that
// user on the next pass (P5 answers `user.id` and `user.teams`, verified against 3.5.0) and continues from the first
// missing piece. The password is still stored encrypted (C-85) because rotation reads it from there, and earlier key
// versions are tried when the current one does not log in. Nothing secret is logged: logs carry tenant ids, counts and
// the adapter's template-only error messages.

import { createHmac } from "node:crypto";
import {
  tenantUsername,
  UmamiError,
  type UmamiProvisioner,
  type UmamiReader,
  type VisitTokenPurge,
} from "@usagemap/umami-adapter";
import pg from "pg";
import type { UmamiCredsKeys } from "../config.ts";
import type { Database, Tx, TxContext } from "../db/database.ts";
import { cpMetrics } from "../obs/metrics.ts";
import { decryptCredential, encryptCredential } from "./credentials.ts";

export const JOB = "umami_reconcile";
/** Placeholder domain of a website whose site has no readable declared host (§j.2 P7). */
export const NO_DOMAIN = "invalid.example";

export interface ReconcileLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ReconcileOptions {
  /** `scf_jobs` (through PgBouncer); needs at least two connections (the lock transaction + one write). */
  jobsDb: Database;
  provisioner: UmamiProvisioner;
  /** Visit-token purge on every core (`visitTokenPurgeOnEveryCore`). */
  purge: VisitTokenPurge;
  /** Reads with a freshly minted key during rotation (reader certificate). */
  reader?: UmamiReader | undefined;
  credsKeys: UmamiCredsKeys;
  admin: { username: string; password: string };
  log: ReconcileLogger;
  /** Rotate a tenant's key when it is older than this (C-85); 0 = never. Default 90. */
  rotateAfterDays?: number;
  /** At most this many orphan websites are deleted per pass (circuit breaker). Default 50. */
  maxOrphanDeletes?: number;
  /** Test hook, called after each completed engine step of a tenant (may throw to simulate a crash). */
  step?: (name: string, tenantId: string) => void;
}

export interface PassResult {
  ran: boolean;
  provisioned: string[];
  websitesCreated: number;
  twinsProvisioned: number;
  /** Websites of a site that exist outside the tenant's team (unreadable with the tenant's key; never moved). */
  misplaced: number;
  orphansDeleted: number;
  rotated: string[];
  /** Tenants whose credentials were re-encrypted under the current key version (step 8). */
  rewrapped: number;
  /** Site ↔ website mismatches left after the pass (step 9). */
  drift: { orphan: number; missing: number; misplaced: number };
  errors: number;
}

interface TenantRow extends Record<string, unknown> {
  tenant_id: string;
  status: string;
  umami_team_id: string | null;
  umami_user_id: string | null;
  umami_username: string | null;
  umami_api_key_id: string | null;
  password_ciphertext: Buffer | null;
  key_version: number | null;
  key_age_days: number | null;
}

interface SiteRow extends Record<string, unknown> {
  tenant_id: string;
  site_id: string;
  status: string;
  umami_website_id: string;
  umami_twin_website_id: string | null;
  twin_provisioned_at: Date | null;
  first_host: string | null;
}

const PASSWORD_LABEL = "scf/umami-tenant-password/v1";

/** The tenant user's password under one key version: base64url(HMAC-SHA-256(K, label ‖ 0 ‖ tenant id)), 43 chars. */
export function derivePassword(keys: UmamiCredsKeys, version: number, tenantId: string): string {
  const key = keys.keys.get(version);
  if (!key) throw new Error(`Umami credentials key version ${version} is not configured`);
  return createHmac("sha256", key)
    .update(`${PASSWORD_LABEL}\u0000${tenantId.toLowerCase()}`)
    .digest("base64url");
}

const jobCtx = (tenantId: string | null): TxContext => ({
  tenantId,
  actorKind: "job",
  actorId: JOB,
  job: JOB,
});

export class UmamiReconciler {
  readonly #o: ReconcileOptions;

  constructor(opts: ReconcileOptions) {
    this.#o = opts;
  }

  /** One pass; returns ran=false when another instance holds the lock. */
  async pass(): Promise<PassResult> {
    const result: PassResult = {
      ran: false,
      provisioned: [],
      websitesCreated: 0,
      twinsProvisioned: 0,
      misplaced: 0,
      orphansDeleted: 0,
      rotated: [],
      rewrapped: 0,
      drift: { orphan: 0, missing: 0, misplaced: 0 },
      errors: 0,
    };
    await this.#o.jobsDb.tx(jobCtx(null), async (lockTx) => {
      const lock = await lockTx.one<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('scf.job.umami_reconcile')) AS ok`,
      );
      if (!lock.ok) return;
      result.ran = true;
      await this.#run(lockTx, result);
    });
    return result;
  }

  async #run(read: Tx, r: PassResult): Promise<void> {
    const o = this.#o;
    const tenants = await read.query<TenantRow>(
      `SELECT t.tenant_id, t.status::text AS status, c.umami_team_id, c.umami_user_id, c.umami_username,
              c.umami_api_key_id, c.password_ciphertext, c.key_version,
              extract(epoch FROM now() - COALESCE(c.rotated_at, c.provisioned_at)) / 86400 AS key_age_days
         FROM scf.tenants t LEFT JOIN scf.umami_credentials c ON c.tenant_id = t.tenant_id
        WHERE t.purged_at IS NULL
        ORDER BY t.created_at, t.tenant_id`,
    );
    // The first declared host names the website in the engine (§j.2 P7). site_domains is not readable by this job
    // in data-model §8.4 (reported contract gap); without a row the placeholder is used.
    const sites = await read.query<SiteRow>(
      `SELECT s.tenant_id, s.site_id, s.status, s.umami_website_id, s.umami_twin_website_id, s.twin_provisioned_at,
              (SELECT d.host FROM scf.site_domains d WHERE d.tenant_id = s.tenant_id AND d.site_id = s.site_id
                ORDER BY d.created_at, d.domain_id LIMIT 1) AS first_host
         FROM scf.sites s ORDER BY s.created_at, s.site_id`,
    );

    const token = await o.provisioner.login(o.admin.username, o.admin.password);
    if (!token)
      throw new UmamiError("provisioning admin cannot log in (P1)", "POST", "/api/auth/login");

    // 4. tenants without credentials
    const teamOf = new Map<string, string>();
    for (const t of tenants) {
      if (t.umami_team_id) {
        teamOf.set(t.tenant_id, t.umami_team_id);
        continue;
      }
      if (!["pending", "active", "suspended"].includes(t.status)) continue;
      try {
        const team = await this.#provisionTenant(token, t.tenant_id);
        teamOf.set(t.tenant_id, team);
        r.provisioned.push(t.tenant_id);
      } catch (err) {
        r.errors++;
        o.log.error(
          { tenant_id: t.tenant_id, err: errInfo(err) },
          "umami tenant provisioning failed",
        );
      }
    }

    // 5. websites
    const listed = await o.provisioner.listWebsites(token);
    const engine = new Set(listed.map((w) => w.id));
    const teamOfWebsite = new Map(listed.map((w) => [w.id, w.teamId]));
    const statusOf = new Map(tenants.map((t) => [t.tenant_id, t.status]));
    let twinsChanged = false;
    for (const s of sites) {
      const team = teamOf.get(s.tenant_id);
      const tStatus = statusOf.get(s.tenant_id);
      // Removed tenants keep what exists (restoration) but get nothing new; purging sites get nothing new.
      if (!team || tStatus === "removed" || tStatus === undefined || s.status === "purging")
        continue;
      const domain = s.first_host ?? NO_DOMAIN;
      // A website that exists but belongs to another owner (created before the tenant had a team, restored, or made
      // out of band) is never moved automatically — the provisioner has no transfer right — but it makes every live
      // read of the site answer 401 and fall back to the rollups, so it is reported (2026-11-13 journey failure).
      for (const id of [
        s.umami_website_id,
        s.twin_provisioned_at ? s.umami_twin_website_id : null,
      ]) {
        if (id && engine.has(id) && teamOfWebsite.get(id) !== team) {
          r.misplaced++;
          o.log.error(
            {
              tenant_id: s.tenant_id,
              site_id: s.site_id,
              website: id === s.umami_website_id ? "main" : "twin",
            },
            "umami website outside the tenant team",
          );
        }
      }
      try {
        if (!engine.has(s.umami_website_id)) {
          await o.provisioner.createWebsite(token, {
            id: s.umami_website_id,
            name: s.site_id,
            domain,
            teamId: team,
          });
          engine.add(s.umami_website_id);
          r.websitesCreated++;
          o.step?.("P7", s.tenant_id);
        }
        if (s.umami_twin_website_id && !s.twin_provisioned_at) {
          if (!engine.has(s.umami_twin_website_id)) {
            await o.provisioner.createWebsite(token, {
              id: s.umami_twin_website_id,
              name: `${s.site_id}/twin`,
              domain,
              teamId: team,
            });
            engine.add(s.umami_twin_website_id);
            r.websitesCreated++;
          }
          await o.jobsDb.tx(jobCtx(s.tenant_id), (tx) =>
            tx.query(
              `UPDATE scf.sites SET twin_provisioned_at = now()
                WHERE tenant_id = $1 AND site_id = $2 AND umami_twin_website_id = $3 AND twin_provisioned_at IS NULL`,
              [s.tenant_id, s.site_id, s.umami_twin_website_id],
            ),
          );
          r.twinsProvisioned++;
          twinsChanged = true;
        }
      } catch (err) {
        r.errors++;
        o.log.error(
          { tenant_id: s.tenant_id, site_id: s.site_id, err: errInfo(err) },
          "umami website provisioning failed",
        );
      }
    }
    if (twinsChanged) await o.jobsDb.tx(jobCtx(null), (tx) => tx.notify("scf_edge"));

    // 6. orphans: in the engine, referenced by no site (of any tenant, any status)
    const referenced = new Set<string>();
    for (const s of sites) {
      referenced.add(s.umami_website_id);
      if (s.umami_twin_website_id) referenced.add(s.umami_twin_website_id);
    }
    const orphans = [...engine].filter((id) => !referenced.has(id));
    const max = o.maxOrphanDeletes ?? 50;
    let orphansLeft = orphans.length;
    if (orphans.length > 0 && (sites.length === 0 || orphans.length > max)) {
      r.errors++;
      o.log.error(
        { orphans: orphans.length, sites: sites.length, max },
        "umami orphan deletion refused by the circuit breaker",
      );
    } else {
      for (const id of orphans) {
        try {
          // Token purge on every core resolves first, or the website stays (C-112(9)).
          await o.provisioner.deleteWebsite(token, id, o.purge);
          r.orphansDeleted++;
          orphansLeft--;
        } catch (err) {
          r.errors++;
          o.log.error({ err: errInfo(err) }, "umami orphan website deletion failed");
        }
      }
    }

    // 7. key rotation
    const days = o.rotateAfterDays ?? 90;
    if (days > 0) {
      for (const t of tenants) {
        if (t.status !== "active" || !t.umami_team_id || Number(t.key_age_days) < days) continue;
        try {
          await this.rotate(t.tenant_id);
          r.rotated.push(t.tenant_id);
        } catch (err) {
          r.errors++;
          o.log.error({ tenant_id: t.tenant_id, err: errInfo(err) }, "umami key rotation failed");
        }
      }
    }
    // 8. re-wrap credentials under the current key version, whatever the tenant's status
    await this.#rewrap(read, r);

    // 9. site ↔ website check. Missing: a site of a tenant that has an engine identity whose main website (or its
    // provisioned twin) the engine does not hold after this pass — for an active tenant a failed P7, for a removed
    // one data that restoration would not find. Sites being purged are excluded.
    let missing = 0;
    for (const s of sites) {
      if (!teamOf.has(s.tenant_id) || !statusOf.has(s.tenant_id) || s.status === "purging")
        continue;
      const twinGone =
        s.umami_twin_website_id !== null &&
        s.twin_provisioned_at !== null &&
        !engine.has(s.umami_twin_website_id);
      if (!engine.has(s.umami_website_id) || twinGone) missing++;
    }
    r.drift = { orphan: orphansLeft, missing, misplaced: r.misplaced };
    cpMetrics.umamiSiteDrift(r.drift);
    if (missing + orphansLeft + r.misplaced > 0)
      o.log.warn({ ...r.drift }, "umami sites and engine websites do not match");

    if (
      r.provisioned.length +
        r.websitesCreated +
        r.misplaced +
        r.orphansDeleted +
        r.rotated.length +
        r.rewrapped >
      0
    ) {
      o.log.info(
        {
          provisioned: r.provisioned.length,
          websites_created: r.websitesCreated,
          twins: r.twinsProvisioned,
          misplaced: r.misplaced,
          orphans_deleted: r.orphansDeleted,
          rotated: r.rotated.length,
          rewrapped: r.rewrapped,
        },
        "umami reconcile pass",
      );
    }
  }

  /**
   * Step 8: every stored credential row whose key_version is not the current one is decrypted under its version and
   * re-encrypted under the current one (both fields; same key_version), whatever the tenant's status. The update is
   * conditional on the version read, so a concurrent rotation wins. A row whose version is no longer configured
   * cannot be re-wrapped: counted as an error and logged with the tenant id only.
   */
  async #rewrap(read: Tx, r: PassResult): Promise<void> {
    const o = this.#o;
    const keys = o.credsKeys;
    const rows = await read.query<{
      tenant_id: string;
      key_version: number;
      api_key_ciphertext: Buffer;
      password_ciphertext: Buffer;
    }>(
      `SELECT c.tenant_id, c.key_version, c.api_key_ciphertext, c.password_ciphertext
         FROM scf.umami_credentials c JOIN scf.tenants t ON t.tenant_id = c.tenant_id
        WHERE t.purged_at IS NULL AND c.key_version <> $1
        ORDER BY c.tenant_id`,
      [keys.current],
    );
    for (const row of rows) {
      try {
        const v = Number(row.key_version);
        const apiKey = decryptCredential(keys, v, row.tenant_id, "api_key", row.api_key_ciphertext);
        const password = decryptCredential(
          keys,
          v,
          row.tenant_id,
          "password",
          row.password_ciphertext,
        );
        const k = encryptCredential(keys, row.tenant_id, "api_key", apiKey);
        const p = encryptCredential(keys, row.tenant_id, "password", password);
        const n = await o.jobsDb.tx(jobCtx(row.tenant_id), (tx) =>
          tx.query(
            `UPDATE scf.umami_credentials
                SET api_key_ciphertext = $3, password_ciphertext = $4, key_version = $5
              WHERE tenant_id = $1 AND key_version = $2
              RETURNING tenant_id`,
            [row.tenant_id, v, k.ciphertext, p.ciphertext, k.keyVersion],
          ),
        );
        if (n.length > 0) r.rewrapped++;
      } catch (err) {
        r.errors++;
        o.log.error(
          { tenant_id: row.tenant_id, err: errInfo(err) },
          "umami credentials re-wrap failed",
        );
      }
    }
  }

  /** P2–P6 (restartable) and the stored credentials; returns the team id. */
  async #provisionTenant(adminToken: string, tenantId: string): Promise<string> {
    const o = this.#o;
    const keys = o.credsKeys;
    // A crash under an earlier key version left a user with that version's password: try older versions first.
    let password = derivePassword(keys, keys.current, tenantId);
    for (const v of [...keys.keys.keys()].filter((v) => v !== keys.current)) {
      const pw = derivePassword(keys, v, tenantId);
      if (await o.provisioner.login(tenantUsername(tenantId), pw)) {
        password = pw;
        break;
      }
    }
    const id = await o.provisioner.ensureTenantIdentity(adminToken, tenantId, password, (s) =>
      o.step?.(s, tenantId),
    );
    const key = encryptCredential(keys, tenantId, "api_key", id.apiKey);
    const pw = encryptCredential(keys, tenantId, "password", id.password);
    await o.jobsDb.tx(jobCtx(tenantId), (tx) =>
      tx.query(
        `INSERT INTO scf.umami_credentials (tenant_id, umami_team_id, umami_user_id, umami_username, umami_api_key_id,
                                            api_key_ciphertext, password_ciphertext, key_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id) DO NOTHING`,
        [
          tenantId,
          id.teamId,
          id.userId,
          id.username,
          id.apiKeyId,
          key.ciphertext,
          pw.ciphertext,
          key.keyVersion,
        ],
      ),
    );
    o.step?.("stored", tenantId);
    return id.teamId;
  }

  /**
   * Key rotation (C-85, §j.2): P5 → P6 → store the new key and its id → verify a read with the new key (on one of the
   * tenant's main websites, when it has one) → P10 (old key) → audit `umami.key_rotated`. The new key is stored before
   * the old one is deleted, so live reads never see a deleted key; a failure after storing leaves an extra live key in
   * the engine that the next rotation does not remove (reported).
   */
  async rotate(tenantId: string): Promise<void> {
    const o = this.#o;
    const keys = o.credsKeys;
    const cur = await o.jobsDb.tx(jobCtx(tenantId), (tx) =>
      tx.maybeOne<{
        umami_username: string;
        umami_api_key_id: string;
        password_ciphertext: Buffer;
        key_version: number;
        website: string | null;
      }>(
        `SELECT c.umami_username, c.umami_api_key_id, c.password_ciphertext, c.key_version,
                (SELECT s.umami_website_id::text FROM scf.sites s WHERE s.tenant_id = c.tenant_id
                  ORDER BY s.created_at LIMIT 1) AS website
           FROM scf.umami_credentials c WHERE c.tenant_id = $1`,
        [tenantId],
      ),
    );
    if (!cur) throw new Error("tenant has no Umami credentials");
    const password = decryptCredential(
      keys,
      Number(cur.key_version),
      tenantId,
      "password",
      cur.password_ciphertext,
    );
    const now = Date.now();
    await o.provisioner.rotateApiKey(
      cur.umami_username,
      password,
      cur.umami_api_key_id,
      async (fresh) => {
        const key = encryptCredential(keys, tenantId, "api_key", fresh.key);
        // The password is re-encrypted under the current key version too: both ciphertexts share key_version.
        const pw = encryptCredential(keys, tenantId, "password", password);
        await o.jobsDb.tx(jobCtx(tenantId), (tx) =>
          tx.query(
            `UPDATE scf.umami_credentials
              SET umami_api_key_id = $2, api_key_ciphertext = $3, password_ciphertext = $4, key_version = $5,
                  rotated_at = now()
            WHERE tenant_id = $1`,
            [tenantId, fresh.id, key.ciphertext, pw.ciphertext, key.keyVersion],
          ),
        );
        if (o.reader && cur.website) {
          await o.reader.stats(fresh.key, cur.website, { start: now - 3_600_000, end: now }, "raw");
        }
      },
    );
    await o.jobsDb.tx(jobCtx(tenantId), (tx) =>
      tx.audit({ action: "umami.key_rotated", targetType: "tenant", targetId: tenantId }),
    );
  }
}

function errInfo(err: unknown): { name: string; message: string } {
  // Adapter errors carry method, path template and status only (never bodies, tokens or URLs with ids/queries).
  if (err instanceof Error) return { name: err.name, message: err.message.slice(0, 200) };
  return { name: "unknown", message: "non-error thrown" };
}

/** Schedules passes: every `intervalMs` and on `NOTIFY scf_umami` (LISTEN on a direct, non-pooled connection). */
export class UmamiReconcileLoop {
  readonly #r: UmamiReconciler;
  readonly #intervalMs: number;
  readonly #listenUrl: string | undefined;
  readonly #log: ReconcileLogger;
  #timer: NodeJS.Timeout | undefined;
  #listener: pg.Client | undefined;
  #running = false;
  #again = false;
  #stopped = false;
  #failures = 0;
  #notBefore = 0;
  readonly #onOutcome: ((o: "success" | "failure") => void) | undefined;

  constructor(
    reconciler: UmamiReconciler,
    opts: {
      intervalMs: number;
      listenUrl: string | undefined;
      log: ReconcileLogger;
      onOutcome?: (o: "success" | "failure") => void;
    },
  ) {
    this.#onOutcome = opts.onOutcome;
    this.#r = reconciler;
    this.#intervalMs = opts.intervalMs;
    this.#listenUrl = opts.listenUrl;
    this.#log = opts.log;
  }

  async start(): Promise<void> {
    void this.trigger();
    // A short tick drives the retry backoff; the interval itself decides when a regular pass is due.
    let last = Date.now();
    this.#timer = setInterval(() => {
      if (
        Date.now() - last >= this.#intervalMs ||
        (this.#failures > 0 && Date.now() >= this.#notBefore)
      ) {
        last = Date.now();
        void this.trigger();
      }
    }, 1000);
    if (this.#listenUrl) await this.#listen(this.#listenUrl).catch(() => {});
  }

  async #listen(url: string): Promise<void> {
    const client = new pg.Client({
      connectionString: url,
      application_name: "scf-umami-reconcile-listen",
    });
    client.on("error", () => {
      this.#listener = undefined;
      if (!this.#stopped) setTimeout(() => void this.#listen(url).catch(() => {}), 5000);
    });
    client.on("notification", () => void this.trigger());
    await client.connect();
    await client.query("LISTEN scf_umami");
    this.#listener = client;
  }

  /** Runs one pass; concurrent triggers coalesce into one extra pass. Failures back off up to 5 minutes. */
  async trigger(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    try {
      do {
        this.#again = false;
        const res = await this.#r.pass();
        this.#failures = res.errors > 0 ? this.#failures + 1 : 0;
        if (res.ran) this.#onOutcome?.(res.errors > 0 || res.misplaced > 0 ? "failure" : "success");
      } while (this.#again && !this.#stopped);
    } catch (err) {
      this.#failures++;
      this.#onOutcome?.("failure");
      this.#log.error({ err: errInfo(err) }, "umami reconcile pass failed");
    } finally {
      if (this.#failures > 0)
        this.#notBefore = Date.now() + Math.min(300_000, 2_000 * 2 ** Math.min(this.#failures, 8));
      this.#running = false;
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#listener?.end().catch(() => {});
  }
}
