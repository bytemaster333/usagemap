// SPDX-License-Identifier: Apache-2.0
// Job `registry_sync` (nightly; data-model §8.5; ADR-0015; C-19, C-20; enrol.self-service-open ladder L3, operator.real-usage-ranking).
//
// Per source, one run row in `registry_sync_runs` (provenance: source, times, counts, per-round counts, status):
//   - fetch every project (sources.ts), paced and rate-limit aware (polite.ts); a failed fetch → status `failed`,
//     nothing else changes; project details the source would not give this run (429, budget) are deferred to the next
//     run, the stored rows of those projects stay as they are;
//   - a run that sees fewer than (1 − maxDropShare) of the rows the source had last time → status `suspicious`: rows
//     are upserted but nothing is marked missing (a half-broken API must not lapse evidence);
//   - upsert every row (`registry_projects`, UNIQUE (source, source_id)) with its content hash; unchanged rows only get
//     `last_seen_at`; rows not seen in a successful run get `missing_since` (kept, never deleted here).
// Then matching, per tenant in one transaction under that tenant's context (F1):
//   - a `candidate` link when a verified host equals, or is a subdomain of, a registry website host
//     (`registrable_domain`), or a VERIFIED declared contract is listed by the project (`verified_contract`) — never on
//     name or GitHub org (C-20);
//   - `confirmed` automatically when the basis includes `registrable_domain`; operator decisions (decided_by set) are
//     never changed by the sync;
//   - a confirmed link to an `scf_awarded` row of stellarlight or pg_atlas that is not missing for more than 14 days
//     creates (or revalidates) `registry_match` evidence; such evidence lapses when no qualifying row remains
//     (`verification.evidence_lapsed`); one `registry.synced` audit row per changed tenant, one on the platform chain
//     per run. Idempotent: a second run with the same data changes nothing.

import type { ScfDb, Tx } from "../db.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import {
  canonicalJson,
  type PreviousRow,
  type RegistryRow,
  type RegistrySource,
  type SourceName,
  sha256,
} from "./sources.ts";

const JOB = "registry_sync" as const;
export const LAPSE_DAYS = 14;

export interface RegistryOptions {
  sources: RegistrySource[];
  maxDropShare: number;
  dailyAt: { hour: number; minute: number };
}

export function registrySyncJob(db: ScfDb, opts: RegistryOptions): JobDef {
  return {
    name: JOB,
    triggers: [{ schedule: { kind: "daily", ...opts.dailyAt }, mode: "daily" }],
    run: async (ctx) => {
      await runRegistrySync(db, opts, ctx);
    },
  };
}

export interface SourceRunResult {
  status: "succeeded" | "failed" | "suspicious";
  seen: number;
  changed: number;
  missing: number;
}

export interface SyncResult {
  sources: Partial<Record<SourceName, SourceRunResult>>;
  tenants: Map<string, TenantMatchResult>;
}

export interface TenantMatchResult {
  linksCreated: number;
  linksConfirmed: number;
  evidenceCreated: number;
  evidenceRevalidated: number;
  evidenceLapsed: number;
}

/** Hash input: the statement about the project, without the source's own change timestamp. */
function contentHash(r: RegistryRow): Buffer {
  const { updated_at: _ignored, ...rest } = r.raw as Record<string, unknown> & {
    updated_at?: unknown;
  };
  return sha256(canonicalJson(rest));
}

export async function runRegistrySync(
  db: ScfDb,
  opts: Pick<RegistryOptions, "sources" | "maxDropShare">,
  ctx: JobContext,
): Promise<SyncResult> {
  const out: SyncResult = { sources: {}, tenants: new Map() };
  for (const src of opts.sources) {
    checkAborted(ctx.signal);
    out.sources[src.name] = await syncSource(db, src, opts.maxDropShare, ctx);
  }
  checkAborted(ctx.signal);
  out.tenants = await matchTenants(db, ctx);
  await db.tx(JOB, null, (tx) =>
    tx.audit("registry.synced", "registry", "all", {
      sources: out.sources,
      tenants_changed: [...out.tenants.values()].filter(changed).length,
    }),
  );
  const failed = Object.values(out.sources).filter((s) => s?.status === "failed").length;
  ctx.log.info("registry_sync_done", {
    job: JOB,
    sources: opts.sources.length,
    failed,
    tenants_changed: [...out.tenants.values()].filter(changed).length,
  });
  if (failed > 0)
    throw Object.assign(new Error(`${failed} registry sources failed`), {
      name: "RegistrySourceFailed",
    });
  return out;
}

const changed = (t: TenantMatchResult) =>
  t.linksCreated + t.linksConfirmed + t.evidenceCreated + t.evidenceRevalidated + t.evidenceLapsed >
  0;

async function syncSource(
  db: ScfDb,
  src: RegistrySource,
  maxDropShare: number,
  ctx: JobContext,
): Promise<SourceRunResult> {
  const { runId, previous, activeBefore } = await db.tx(JOB, null, async (tx) => {
    const run = await tx.one<{ run_id: string }>(
      "INSERT INTO scf.registry_sync_runs (source) VALUES ($1) RETURNING run_id",
      [src.name],
    );
    const prev = await tx.query<{
      source_id: string;
      raw: Record<string, unknown>;
      missing: boolean;
    }>(
      `SELECT r.source_id, r.raw, r.missing_since IS NOT NULL AS missing
         FROM scf.registry_projects r WHERE r.source = $1`,
      [src.name],
    );
    return {
      runId: run.run_id,
      previous: new Map<string, PreviousRow>(prev.map((p) => [p.source_id, { raw: p.raw }])),
      activeBefore: prev.filter((p) => !p.missing).length,
    };
  });
  let rows: RegistryRow[];
  try {
    rows = await src.fetchAll(ctx.signal, previous);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const code = err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error";
    await db.tx(JOB, null, (tx) =>
      tx.exec(
        `UPDATE scf.registry_sync_runs SET finished_at = now(), status = 'failed', error_code = $2 WHERE run_id = $1`,
        [runId, code],
      ),
    );
    ctx.metrics.units.inc({ job: JOB, outcome: "source_failed" });
    ctx.log.error("registry_source_failed", { job: JOB, source: src.name, error_class: code });
    return { status: "failed", seen: 0, changed: 0, missing: 0 };
  }
  // De-duplicate by source id (a paginated API can repeat a row across pages when its order shifts).
  const byId = new Map(rows.map((r) => [r.sourceId, r]));
  const suspicious = activeBefore > 0 && byId.size < Math.floor(activeBefore * (1 - maxDropShare));
  const perRound: Record<string, number> = {};
  for (const r of byId.values()) {
    for (const a of r.scfAwards) {
      if (a.status !== "Awarded") continue;
      perRound[String(a.round)] = (perRound[String(a.round)] ?? 0) + 1;
    }
  }
  const res = await db.tx(JOB, null, async (tx) => {
    let changedRows = 0;
    for (const r of byId.values()) {
      const n = await tx.one<{ changed: boolean }>(
        `INSERT INTO scf.registry_projects AS p (source, source_id, canonical_daoip5_id, name, slug, websites,
            registrable_domains, github_orgs, contract_ids, scf_awarded, scf_awards, source_url, source_basis,
            source_confidence, source_as_of, fetched_at, content_sha256, raw, scf_categories, award_round, award_stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15::date, now(), $16, $17::jsonb,
                 $18::text[], $19, $20)
         ON CONFLICT (source, source_id) DO UPDATE SET
            canonical_daoip5_id = EXCLUDED.canonical_daoip5_id, name = EXCLUDED.name, slug = EXCLUDED.slug,
            websites = EXCLUDED.websites, registrable_domains = EXCLUDED.registrable_domains,
            github_orgs = EXCLUDED.github_orgs, contract_ids = EXCLUDED.contract_ids,
            scf_awarded = EXCLUDED.scf_awarded, scf_awards = EXCLUDED.scf_awards, source_url = EXCLUDED.source_url,
            source_basis = EXCLUDED.source_basis, source_confidence = EXCLUDED.source_confidence,
            source_as_of = EXCLUDED.source_as_of,
            fetched_at = CASE WHEN p.content_sha256 = EXCLUDED.content_sha256 THEN p.fetched_at ELSE now() END,
            content_sha256 = EXCLUDED.content_sha256, raw = EXCLUDED.raw,
            scf_categories = EXCLUDED.scf_categories, award_round = EXCLUDED.award_round,
            award_stage = EXCLUDED.award_stage,
            last_seen_at = now(), missing_since = NULL
         RETURNING (old.content_sha256 IS DISTINCT FROM new.content_sha256) AS changed`,
        [
          r.source,
          r.sourceId,
          r.canonicalDaoip5Id,
          r.name,
          r.slug,
          r.websites,
          r.registrableDomains,
          r.githubOrgs,
          r.contractIds,
          r.scfAwarded,
          JSON.stringify(r.scfAwards),
          r.sourceUrl,
          r.sourceBasis,
          r.sourceConfidence,
          r.sourceAsOf,
          contentHash(r),
          JSON.stringify(r.raw),
          r.scfCategories,
          r.awardRound,
          r.awardStage,
        ],
      );
      if (n.changed) changedRows += 1;
    }
    let missing = 0;
    if (!suspicious) {
      missing = await tx.exec(
        `UPDATE scf.registry_projects SET missing_since = now()
          WHERE source = $1 AND missing_since IS NULL AND NOT (source_id = ANY ($2::text[]))`,
        [src.name, [...byId.keys()]],
      );
    }
    const status = suspicious ? "suspicious" : "succeeded";
    await tx.exec(
      `UPDATE scf.registry_sync_runs SET finished_at = now(), status = $2, rows_seen = $3, rows_changed = $4,
              rows_missing = $5, per_round_counts = $6::jsonb WHERE run_id = $1`,
      [runId, status, byId.size, changedRows, missing, JSON.stringify(perRound)],
    );
    return { status, seen: byId.size, changed: changedRows, missing } as SourceRunResult;
  });
  ctx.metrics.rows.inc(
    { job: JOB, relation: "registry_projects", action: "upserted" },
    res.changed,
  );
  ctx.metrics.units.inc({ job: JOB, outcome: `source_${res.status}` });
  if (suspicious) ctx.metrics.anomalies.inc({ job: JOB, reason: "registry_source_shrank" });
  const fetch = src.lastRun;
  if (fetch?.deferred) {
    // Left for the next run (polite.ts): rate-limited, budget spent, or an error answer for single projects.
    ctx.metrics.units.inc({ job: JOB, outcome: "source_deferred" }, fetch.deferred);
  }
  if (fetch?.rateLimited) ctx.metrics.anomalies.inc({ job: JOB, reason: "registry_rate_limited" });
  ctx.log.info("registry_source_synced", {
    job: JOB,
    source: src.name,
    status: res.status,
    seen: res.seen,
    changed: res.changed,
    missing: res.missing,
    requests: fetch?.requests ?? null,
    deferred: fetch?.deferred ?? 0,
    rate_limited: fetch?.rateLimited ?? false,
  });
  return res;
}

/** Tenant host `h` matches registry host `r` when equal or when one is a subdomain of the other (label boundary). */
export function hostMatches(h: string, r: string): boolean {
  return h === r || h.endsWith(`.${r}`) || r.endsWith(`.${h}`);
}

interface Candidate {
  registry_project_id: string;
  basis: string[];
}

async function matchTenants(db: ScfDb, ctx: JobContext): Promise<Map<string, TenantMatchResult>> {
  // Cross-tenant read (named job, tenant unset): every tenant that has a verified host, a verified contract, a link or
  // registry evidence. Removed tenants are left alone (their data is hidden and will be purged).
  const tenants = await db.tx(JOB, null, (tx) =>
    tx.query<{ tenant_id: string }>(
      `SELECT t.tenant_id FROM scf.tenants t
        WHERE t.status <> 'removed'
          AND (EXISTS (SELECT 1 FROM scf.site_domains d WHERE d.tenant_id = t.tenant_id AND d.state = 'verified')
               OR EXISTS (SELECT 1 FROM scf.declared_contracts c WHERE c.tenant_id = t.tenant_id AND c.status = 'verified')
               OR EXISTS (SELECT 1 FROM scf.tenant_registry_links l WHERE l.tenant_id = t.tenant_id)
               OR EXISTS (SELECT 1 FROM scf.verification_evidence v
                           WHERE v.tenant_id = t.tenant_id AND v.kind = 'registry_match'))
        ORDER BY t.tenant_id`,
    ),
  );
  const out = new Map<string, TenantMatchResult>();
  for (const { tenant_id } of tenants) {
    checkAborted(ctx.signal);
    const r = await db.tx(JOB, tenant_id, (tx) => matchTenant(tx, tenant_id));
    out.set(tenant_id, r);
    if (changed(r)) {
      ctx.metrics.units.inc({ job: JOB, outcome: "tenant_matched" });
    }
  }
  return out;
}

async function matchTenant(tx: Tx, tenantId: string): Promise<TenantMatchResult> {
  const res: TenantMatchResult = {
    linksCreated: 0,
    linksConfirmed: 0,
    evidenceCreated: 0,
    evidenceRevalidated: 0,
    evidenceLapsed: 0,
  };
  const hosts = (
    await tx.query<{ host: string }>(
      "SELECT DISTINCT lower(d.host) AS host FROM scf.site_domains d WHERE d.tenant_id = $1 AND d.state = 'verified'",
      [tenantId],
    )
  ).map((h) => h.host.replace(/^www\./, ""));
  const contracts = (
    await tx.query<{ contract_id: string }>(
      `SELECT DISTINCT c.contract_id FROM scf.declared_contracts c
        WHERE c.tenant_id = $1 AND c.status = 'verified' AND c.removed_at IS NULL`,
      [tenantId],
    )
  ).map((c) => c.contract_id);

  const candidates = new Map<string, Set<string>>();
  const add = (id: string, basis: string) => {
    const s = candidates.get(id) ?? new Set<string>();
    s.add(basis);
    candidates.set(id, s);
  };
  if (hosts.length > 0) {
    // Index lookup on the registry's hosts and their parents; the exact rule is hostMatches().
    const parents = [...new Set(hosts.flatMap(parentsOf))];
    const rows = await tx.query<{ registry_project_id: string; registrable_domains: string[] }>(
      `SELECT r.registry_project_id, r.registrable_domains FROM scf.registry_projects r
        WHERE r.registrable_domains && $1::text[]
           OR EXISTS (SELECT 1 FROM unnest(r.registrable_domains) d, unnest($2::text[]) h WHERE d LIKE '%.' || h)`,
      [parents, hosts],
    );
    for (const r of rows) {
      if (r.registrable_domains.some((d) => hosts.some((h) => hostMatches(h, d)))) {
        add(r.registry_project_id, "registrable_domain");
      }
    }
  }
  if (contracts.length > 0) {
    const rows = await tx.query<{ registry_project_id: string }>(
      "SELECT r.registry_project_id FROM scf.registry_projects r WHERE r.contract_ids && $1::text[]",
      [contracts],
    );
    for (const r of rows) add(r.registry_project_id, "verified_contract");
  }
  const cand: Candidate[] = [...candidates].map(([id, b]) => ({
    registry_project_id: id,
    basis: [...b].sort(),
  }));

  for (const c of cand) {
    const auto = c.basis.includes("registrable_domain");
    const r = await tx.query<{ inserted: boolean; confirmed_now: boolean }>(
      `INSERT INTO scf.tenant_registry_links AS l (tenant_id, registry_project_id, match_basis, status)
       VALUES ($1, $2, $3::text[], CASE WHEN $4 THEN 'confirmed' ELSE 'candidate' END)
       ON CONFLICT (tenant_id, registry_project_id) DO UPDATE
         SET match_basis = ARRAY(SELECT DISTINCT b FROM unnest(l.match_basis || EXCLUDED.match_basis) b ORDER BY b),
             status = CASE WHEN l.decided_by IS NULL AND l.status = 'candidate' AND $4 THEN 'confirmed' ELSE l.status END
         WHERE l.decided_by IS NULL
           AND (NOT (l.match_basis @> EXCLUDED.match_basis) OR (l.status = 'candidate' AND $4))
       RETURNING (old.status IS NULL) AS inserted,
                 (old.status = 'candidate' AND new.status = 'confirmed') AS confirmed_now`,
      [tenantId, c.registry_project_id, c.basis, auto],
    );
    const row = r[0];
    if (row?.inserted) res.linksCreated += 1;
    else if (row?.confirmed_now) res.linksConfirmed += 1;
  }

  // registry_match evidence: confirmed links to awarded rows of the two machine sources, not missing > 14 days.
  const qualifying = await tx.query<{
    registry_project_id: string;
    source: string;
    source_as_of: string | null;
    basis: string[];
  }>(
    `SELECT r.registry_project_id::text, r.source, to_char(r.source_as_of, 'YYYY-MM-DD') AS source_as_of,
            l.match_basis AS basis
       FROM scf.tenant_registry_links l JOIN scf.registry_projects r USING (registry_project_id)
      WHERE l.tenant_id = $1 AND l.status = 'confirmed' AND r.scf_awarded
        AND r.source IN ('stellarlight', 'pg_atlas')
        AND (r.missing_since IS NULL OR r.missing_since > now() - make_interval(days => $2))`,
    [tenantId, LAPSE_DAYS],
  );
  for (const q of qualifying) {
    const r = await tx.query<{ inserted: boolean; revalidated: boolean }>(
      `INSERT INTO scf.verification_evidence AS v (tenant_id, kind, subject, details, status, verified_at, last_checked_at)
       VALUES ($1, 'registry_match', $2, $3::jsonb, 'valid', now(), now())
       ON CONFLICT (tenant_id, kind, subject) DO UPDATE
         SET status = 'valid', lapsed_at = NULL, last_checked_at = now(), details = EXCLUDED.details,
             verified_at = CASE WHEN v.status = 'valid' THEN v.verified_at ELSE now() END
         WHERE v.status IN ('valid', 'lapsed')
       RETURNING (old.status IS NULL) AS inserted, (old.status = 'lapsed') AS revalidated`,
      [
        tenantId,
        q.registry_project_id,
        JSON.stringify({ source: q.source, source_as_of: q.source_as_of, basis: q.basis }),
      ],
    );
    if (r[0]?.inserted) res.evidenceCreated += 1;
    if (r[0]?.revalidated) res.evidenceRevalidated += 1;
  }
  const lapsed = await tx.query<{ subject: string }>(
    `UPDATE scf.verification_evidence v SET status = 'lapsed', lapsed_at = now(), last_checked_at = now()
      WHERE v.tenant_id = $1 AND v.kind = 'registry_match' AND v.status = 'valid'
        AND NOT (v.subject = ANY ($2::text[]))
      RETURNING v.subject`,
    [tenantId, qualifying.map((q) => q.registry_project_id)],
  );
  res.evidenceLapsed = lapsed.length;
  for (const l of lapsed) {
    await tx.audit("verification.evidence_lapsed", "verification_evidence", l.subject, {
      kind: "registry_match",
      reason: "registry_row_missing_or_not_awarded",
    });
  }
  if (changed(res)) {
    await tx.audit("registry.synced", "tenant", tenantId, {
      links_created: res.linksCreated,
      links_confirmed: res.linksConfirmed,
      evidence_created: res.evidenceCreated,
      evidence_revalidated: res.evidenceRevalidated,
      evidence_lapsed: res.evidenceLapsed,
    });
  }
  return res;
}

/** A host and its parent domains with at least two labels: app.x.example.org → [app.x.example.org, x.example.org, example.org]. */
function parentsOf(h: string): string[] {
  const labels = h.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}
