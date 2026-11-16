// SPDX-License-Identifier: Apache-2.0
// The signed edge snapshot (wire-formats §e; C-05, C-06, C-62, C-90). This module is the `edge_snapshot` job: it runs
// in the JOBS service, which alone holds the snapshot-signing key (the internet-facing control
// plane only serves the stored envelopes), and it connects as `scf_jobs` with `app.job = edge_snapshot` (data-model
// §6.3). It rebuilds every 10 s and on `NOTIFY scf_edge`, issues a new sequence when the content changed — or, when a
// maximum age is configured, once a quarter of the current snapshot's validity has elapsed, so the payload's
// `expires_at` (F12, §e.4) is never near for a connected node — and keeps the last 100 envelopes.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import type { Database, Tx } from "../db/database.ts";
import type { TrackerRegistry } from "../tracker.ts";

export const SNAPSHOT_FORMAT = "scf-edge-snapshot/1";

export interface Envelope {
  format: typeof SNAPSHOT_FORMAT;
  alg: "Ed25519";
  kid: string;
  payload: string;
  sig: string;
}

export interface SnapshotPayload {
  sequence: number;
  issued_at: string;
  /** Hard end of validity (F12): a node must not keep using this payload after it (wire-formats §e.4). */
  expires_at?: string;
  settings: Record<string, unknown>;
  tenants: Array<{ tenant_id: string; status: "pending" | "active" | "suspended"; level: number }>;
  sites: Array<Record<string, unknown>>;
  ingest_tokens: Array<Record<string, unknown>>;
  tracker_versions: Array<{ version: string; status: "active" | "withdrawn" }>;
}

export class SnapshotSigner {
  readonly kid: string;
  readonly #key: KeyObject;
  readonly publicKey: KeyObject;

  constructor(privateKeyPem: string, kid: string) {
    this.#key = createPrivateKey(privateKeyPem);
    if (this.#key.asymmetricKeyType !== "ed25519")
      throw new Error("the edge snapshot key must be Ed25519");
    this.publicKey = createPublicKey(this.#key);
    this.kid = kid;
  }

  /** Signs the exact payload bytes; the envelope carries them base64url-encoded (§e.2). */
  envelope(payload: SnapshotPayload): { bytes: Buffer; envelope: Envelope; payloadSha256: Buffer } {
    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const envelope: Envelope = {
      format: SNAPSHOT_FORMAT,
      alg: "Ed25519",
      kid: this.kid,
      payload: payloadBytes.toString("base64url"),
      sig: sign(null, payloadBytes, this.#key).toString("base64url"),
    };
    return {
      bytes: Buffer.from(JSON.stringify(envelope), "utf8"),
      envelope,
      payloadSha256: createHash("sha256").update(payloadBytes).digest(),
    };
  }
}

/** Verification as a gateway does it (§e.2), used by tests and by the builder's self-check. */
export function verifyEnvelope(
  envelopeJson: string | Buffer,
  keys: Record<string, KeyObject>,
  currentSequence = 0,
): SnapshotPayload {
  const env = JSON.parse(envelopeJson.toString()) as Envelope;
  const key = keys[env.kid];
  if (!key) throw new Error("unknown kid");
  const payloadBytes = Buffer.from(env.payload, "base64url");
  if (!verify(null, payloadBytes, key, Buffer.from(env.sig, "base64url")))
    throw new Error("bad signature");
  if (env.format !== SNAPSHOT_FORMAT) throw new Error("bad format");
  const payload = JSON.parse(payloadBytes.toString("utf8")) as SnapshotPayload;
  if (payload.sequence <= currentSequence) throw new Error("rollback or replay");
  return payload;
}

const SETTING_KEYS = [
  "pow_cost",
  "pow_max",
  "pow_max_multiplier",
  "web_events_per_token",
  "multiplicity_thresholds",
  "multiplicity_event_thresholds",
  "web_requests_per_min_subnet",
  "otlp_requests_per_s",
  "otlp_burst",
  "otlp_bytes_per_s",
  "multiplicity_mode",
] as const;

/** `enforce` | `shadow` (wire-formats §b.4, C-124); anything else is carried as `enforce`, the gateway's default. */
const multiplicityMode = (v: unknown): "enforce" | "shadow" =>
  v === "shadow" ? "shadow" : "enforce";

const byKey =
  <T extends Record<string, unknown>>(k: keyof T) =>
  (a: T, b: T) =>
    String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0;

/** Reads the current content under the `edge_snapshot` job context. Ordering is deterministic. */
export async function readSnapshotContent(
  tx: Tx,
  opts: { pathnormRulesVersion: string; tracker: TrackerRegistry },
): Promise<Omit<SnapshotPayload, "sequence" | "issued_at">> {
  const settingsRows = await tx.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM scf.settings WHERE key = ANY($1::text[]) OR key IN
       ('web_requests_per_min_site','l0_web_requests_per_min_site','l0_events_per_day','l1_events_per_day',
        'dev_events_per_min_site','edge_counter_features','read_only_mode')`,
    [SETTING_KEYS],
  );
  const st = Object.fromEntries(settingsRows.map((r) => [r.key, r.value])) as Record<
    string,
    unknown
  >;
  const settings: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    if (st[k] === undefined) throw new Error(`setting ${k} missing`);
    settings[k] = st[k];
  }
  settings.pathnorm_rules_version = opts.pathnormRulesVersion;
  settings.multiplicity_mode = multiplicityMode(st.multiplicity_mode);
  // C-136 / C-137 (§a.8, §d.3): optional; a gateway treats an absent value as 120 and [] respectively.
  const devPerMin = Number(st.dev_events_per_min_site);
  if (Number.isInteger(devPerMin) && devPerMin >= 1) settings.dev_events_per_min_site = devPerMin;
  settings.counter_features = Array.isArray(st.edge_counter_features)
    ? [
        ...new Set(
          st.edge_counter_features.filter(
            (f) => f === "props" || f === "dev" || f === "app" || f === "rpc",
          ),
        ),
      ].sort()
    : [];

  // ops.end-of-window-read-only: read-only mode with ingest paused publishes every tenant as `suspended`, the existing way to stop ingest
  // and keep data (C-08): the gateway answers 202 and counts `tenant_suspended`, OTLP answers 403 (wire-formats §e).
  const ro = st.read_only_mode as { enabled?: unknown; ingest?: unknown } | undefined;
  const ingestPaused = ro?.enabled === true && ro.ingest === "pause";
  const tenants = (
    await tx.query<{
      tenant_id: string;
      status: "pending" | "active" | "suspended";
      level: number;
    }>(
      `SELECT tenant_id, status::text AS status, scf.verification_level(tenant_id)::int AS level
         FROM scf.tenants WHERE status IN ('pending', 'active', 'suspended') AND purged_at IS NULL`,
    )
  )
    .sort(byKey("tenant_id"))
    .map((t) => (ingestPaused ? { ...t, status: "suspended" as const } : t));
  const level = new Map(tenants.map((t) => [t.tenant_id, t.level]));

  const verifiedToday = new Map(
    (
      await tx.query<{ tenant_id: string; n: string }>(
        `SELECT tenant_id, sum(count)::text AS n FROM scf.web_edge_counters
          WHERE day = (now() AT TIME ZONE 'UTC')::date AND counter = 'verdict' AND label = 'verified'
          GROUP BY tenant_id`,
      )
    ).map((r) => [r.tenant_id, Number(r.n)]),
  );

  const siteRows = await tx.query<{
    site_id: string;
    tenant_id: string;
    site_key: string;
    umami_website_id: string;
    umami_twin_website_id: string | null;
    twin_provisioned_at: Date | null;
    tracker_profile: "standard" | "strict";
    visitor_id: "on" | "off" | "off_in";
    visitor_id_off_countries: string[];
    exclude_countries: string[];
    path_folding: "full" | "relaxed";
    multiplicity_mode: "enforce" | "shadow" | null;
    dev_origins: string[];
    debug_until: Date | null;
  }>(
    `SELECT s.site_id, s.tenant_id, s.site_key, s.umami_website_id, s.umami_twin_website_id, s.twin_provisioned_at,
            s.tracker_profile::text AS tracker_profile, s.visitor_id, s.visitor_id_off_countries::text[] AS visitor_id_off_countries,
            s.exclude_countries::text[] AS exclude_countries, s.path_folding, s.multiplicity_mode, s.dev_origins,
            CASE WHEN s.debug_until > now() THEN s.debug_until END AS debug_until
       FROM scf.sites s JOIN scf.tenants t ON t.tenant_id = s.tenant_id
      WHERE s.status = 'active' AND t.status IN ('pending', 'active', 'suspended') AND t.purged_at IS NULL`,
  );
  const domainRows = await tx.query<{
    site_id: string;
    host: string;
    include_subdomains: boolean;
    state: string;
  }>(
    `SELECT d.site_id, d.host, d.include_subdomains, d.state FROM scf.site_domains d
       JOIN scf.sites s ON s.tenant_id = d.tenant_id AND s.site_id = d.site_id
      WHERE s.status = 'active'`,
  );
  const domains = new Map<
    string,
    Array<{ host: string; include_subdomains: boolean; verified: boolean }>
  >();
  for (const d of domainRows.sort(byKey("host"))) {
    const list = domains.get(d.site_id) ?? [];
    list.push({
      host: d.host,
      include_subdomains: d.include_subdomains,
      verified: d.state === "verified",
    });
    domains.set(d.site_id, list);
  }
  const num = (k: string) => Number(st[k]);
  const sites = siteRows.sort(byKey("site_id")).map((s) => {
    const l0 = (level.get(s.tenant_id) ?? 0) === 0;
    const quota = l0 ? num("l0_events_per_day") : num("l1_events_per_day");
    return {
      site_id: s.site_id,
      tenant_id: s.tenant_id,
      site_key: s.site_key,
      umami_website_id: s.umami_website_id,
      // C-73: the twin id is carried only once umami_reconcile has created the website.
      umami_twin_website_id: s.twin_provisioned_at ? s.umami_twin_website_id : null,
      status: (verifiedToday.get(s.tenant_id) ?? 0) >= quota ? "over_quota" : "active",
      profile: s.tracker_profile,
      visitor_id: s.visitor_id,
      visitor_id_off_countries: [...s.visitor_id_off_countries].sort(),
      exclude_countries: [...s.exclude_countries].sort(),
      path_folding: s.path_folding,
      rate_limit_per_min: l0
        ? num("l0_web_requests_per_min_site")
        : num("web_requests_per_min_site"),
      daily_quota: quota,
      domains: domains.get(s.site_id) ?? [],
      // C-124: the site's override; null = the platform setting
      multiplicity_mode: s.multiplicity_mode,
      // C-136 (§a.8): optional, emitted only when set (absent = no dev origin, debug mode off)
      ...(s.dev_origins.length > 0 ? { dev_origins: [...s.dev_origins].sort() } : {}),
      ...(s.debug_until ? { debug_until: s.debug_until.toISOString() } : {}),
    };
  });

  const ingest_tokens = (
    await tx.query<{
      token_id: string;
      tenant_id: string;
      secret_hash: Buffer;
      pepper_version: number;
      allowed_service_names: string[] | null;
      expires_at: Date | null;
    }>(
      `SELECT i.token_id, i.tenant_id, i.secret_hash, i.pepper_version, i.allowed_service_names, i.expires_at
         FROM scf.ingest_tokens i JOIN scf.tenants t ON t.tenant_id = i.tenant_id
        WHERE i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now())
          AND t.status IN ('pending', 'active', 'suspended') AND t.purged_at IS NULL`,
    )
  )
    .sort(byKey("token_id"))
    .map((r) => ({
      token_id: r.token_id,
      tenant_id: r.tenant_id,
      hash: r.secret_hash.toString("base64url"),
      pepper_version: r.pepper_version,
      allowed_service_names: r.allowed_service_names ? [...r.allowed_service_names].sort() : null,
      expires_at: r.expires_at?.toISOString() ?? null,
    }));

  const tracker_versions = opts.tracker
    .versions()
    .map((v) => ({ version: v.version, status: v.status }))
    .sort(byKey("version"));

  return { settings, tenants, sites, ingest_tokens, tracker_versions };
}

export interface BuildResult {
  issued: boolean;
  sequence: number;
}

export class SnapshotBuilder {
  readonly #db: Database;
  readonly #signer: SnapshotSigner;
  readonly #opts: {
    pathnormRulesVersion: string;
    tracker: TrackerRegistry;
    keep: number;
    maxAgeS: number;
  };

  constructor(
    db: Database,
    signer: SnapshotSigner,
    opts: {
      pathnormRulesVersion: string;
      tracker: TrackerRegistry;
      keep?: number;
      /** Validity of an issued snapshot in seconds (payload `expires_at`); 0 or unset = no expiry. */
      maxAgeS?: number;
    },
  ) {
    this.#db = db;
    this.#signer = signer;
    this.#opts = { ...opts, keep: opts.keep ?? 100, maxAgeS: opts.maxAgeS ?? 0 };
  }

  /** One build pass. Returns `issued: false` when another instance holds the lock or nothing changed. */
  async build(now: Date = new Date()): Promise<BuildResult> {
    return this.#db.tx(
      { tenantId: null, actorKind: "job", actorId: "edge_snapshot", job: "edge_snapshot" },
      async (tx) => {
        // One builder across both cores (C-07): transaction-level advisory lock, safe with PgBouncer.
        const lock = await tx.one<{ ok: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtext('scf.edge_snapshot')) AS ok`,
        );
        const last = await tx.maybeOne<{ seq: string; envelope: Buffer; issued_at: Date }>(
          `SELECT s.sequence::text AS seq, s.envelope, s.issued_at FROM scf.edge_snapshots s
            ORDER BY s.sequence DESC LIMIT 1`,
        );
        const lastSeq = last ? Number(last.seq) : 0;
        if (!lock.ok) return { issued: false, sequence: lastSeq };
        const content = await readSnapshotContent(tx, this.#opts);
        if (last) {
          const prev = JSON.parse(
            Buffer.from(
              (JSON.parse(last.envelope.toString()) as Envelope).payload,
              "base64url",
            ).toString(),
          ) as Partial<SnapshotPayload>;
          delete prev.sequence;
          delete prev.issued_at;
          const prevExpires = prev.expires_at;
          delete prev.expires_at;
          const maxAgeMs = this.#opts.maxAgeS * 1000;
          // Refresh before expiry: an unchanged snapshot is re-issued once a quarter of its validity has elapsed, or
          // when the expiry setting changed (switched on or off).
          const fresh =
            maxAgeMs === 0
              ? prevExpires === undefined
              : prevExpires !== undefined &&
                now.getTime() - last.issued_at.getTime() < maxAgeMs / 4;
          if (fresh && JSON.stringify(prev) === JSON.stringify(content))
            return { issued: false, sequence: lastSeq };
        }
        const sequence = lastSeq + 1;
        const payload: SnapshotPayload = {
          sequence,
          issued_at: now.toISOString(),
          ...(this.#opts.maxAgeS > 0
            ? { expires_at: new Date(now.getTime() + this.#opts.maxAgeS * 1000).toISOString() }
            : {}),
          ...content,
        };
        const { bytes, payloadSha256 } = this.#signer.envelope(payload);
        await tx.query(
          `INSERT INTO scf.edge_snapshots (sequence, issued_at, envelope, payload_sha256) VALUES ($1, $2, $3, $4)`,
          [sequence, now, bytes, payloadSha256],
        );
        await tx.query(`DELETE FROM scf.edge_snapshots WHERE sequence <= $1`, [
          sequence - this.#opts.keep,
        ]);
        return { issued: true, sequence };
      },
    );
  }
}
