// SPDX-License-Identifier: Apache-2.0
// Traction snapshot schema v2 (wire-formats §i.3.2–§i.3.4; C-136 plan C1, decisions D4, D10; C-137): weekly series,
// coverage, a rule-based confidence (methodology `scf-methodology/1.0.0`), on-chain counts of verified contracts, the
// number of OPEN anomaly flags (never which), the seal reference, the project's series position and a deterministic
// pasteable text. Built by job `public_metrics` (the signer, F16) under the tenant's context; exact values (C-95), no
// trust score (C-47), no breakdowns. "Verified" in it always means our measurement class or a contract whose ownership
// we checked — never an endorsement (wording rule C4).

import type { Tx } from "../db/database.ts";
import { DAY, isoZ, projectInfo, tenantApi, tenantWeb } from "./figures.ts";
import type { SealNetworkName } from "./seal-network.ts";

export const SNAPSHOT_SCHEMA_V2 = "scf-analytics/traction-snapshot/2";
export const METHODOLOGY_VERSION = "scf-methodology/1.0.0";

export type Preset =
  | "build_tranche"
  | "growth_hack_before"
  | "growth_hack_during"
  | "pg_renewal_quarter"
  | "custom";

export const PRESET_LABELS: Record<Preset, string> = {
  build_tranche: "SCF Build tranche",
  growth_hack_before: "before Growth Hack campaign",
  growth_hack_during: "during Growth Hack campaign",
  pg_renewal_quarter: "Public Goods renewal quarter",
  custom: "custom period",
};

export type ConfidenceReason =
  | "few_events"
  | "partial_coverage"
  | "days_not_final"
  | "high_suspect_share"
  | "open_anomaly_flags"
  | "domain_unverified"
  | "no_verified_contracts";

const REASON_ORDER: ConfidenceReason[] = [
  "few_events",
  "partial_coverage",
  "days_not_final",
  "high_suspect_share",
  "open_anomaly_flags",
  "domain_unverified",
  "no_verified_contracts",
];

/** Monday 00:00 UTC of the ISO week of `day`. */
export function isoWeekStart(day: number): number {
  const dow = new Date(day).getUTCDay(); // 0 = Sunday
  return day - ((dow + 6) % 7) * DAY;
}

/** ISO weeks intersecting [start, end), each with the number of its days inside the period (§i.3.2 `weekly`). */
export function isoWeeks(start: number, end: number): Array<{ start: number; days: number }> {
  const out: Array<{ start: number; days: number }> = [];
  for (let d = start; d < end; d += DAY) {
    const w = isoWeekStart(d);
    const last = out[out.length - 1];
    if (last && last.start === w) last.days++;
    else out.push({ start: w, days: 1 });
  }
  return out;
}

export interface ConfidenceInput {
  days: number;
  rawPageviews: number;
  verifiedPageviews: number;
  webDaysWithEvents: number;
  webDaysFinal: number;
  minCount: number;
  hasApiData: boolean;
  hasOnchainData: boolean;
  openFlags: number;
  level: number;
  onchainEnabled: boolean;
  verifiedContracts: number;
}

/** The confidence rule of methodology 1.0.0 (wire-formats §i.3.2). */
export function confidence(c: ConfidenceInput): {
  level: "high" | "medium" | "low" | "insufficient";
  reasons: ConfidenceReason[];
} {
  if (c.rawPageviews < c.minCount && !c.hasApiData && !c.hasOnchainData)
    return { level: "insufficient", reasons: [] };
  const r = new Set<ConfidenceReason>();
  if (c.rawPageviews < 10 * c.days) r.add("few_events");
  if (c.webDaysWithEvents < 0.8 * c.days) r.add("partial_coverage");
  if (c.webDaysFinal < c.days) r.add("days_not_final");
  const suspect = c.rawPageviews > 0 ? (c.rawPageviews - c.verifiedPageviews) / c.rawPageviews : 0;
  if (suspect > 0.3) r.add("high_suspect_share");
  if (c.openFlags > 0) r.add("open_anomaly_flags");
  if (c.level === 0) r.add("domain_unverified");
  if (c.onchainEnabled && c.verifiedContracts === 0) r.add("no_verified_contracts");
  const reasons = REASON_ORDER.filter((x) => r.has(x));
  return {
    level: reasons.length === 0 ? "high" : reasons.length === 1 ? "medium" : "low",
    reasons,
  };
}

/** Integer with `,` thousands separators (locale-independent). */
export function thousands(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  return (n < 0 ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const pct = (x: number) => (Math.round(x * 1000) / 10).toFixed(1);

/** The pasteable text (§i.3.4), deterministic from the document's other fields; lines without data are left out. */
export function snapshotText(doc: Record<string, unknown>): string {
  const d = doc as {
    project: { name: string };
    series: { seq: number };
    period: { start: string; end: string; days: number };
    preset: Preset;
    issuer: string;
    methodology: { version: string };
    web: {
      verified: { pageviews: number; visitors_sum: number };
      raw: { pageviews: number };
      visit_metrics: { suspect_pageview_share: number | null };
    };
    api: null | {
      label: string;
      requests: number;
      error_rate_5xx: number | null;
      p95_ms: number | null;
      assurance_level: string | null;
    };
    onchain: null | {
      network: string;
      verified_contracts: number;
      invocations: number;
      successful_invocations: number;
      distinct_invokers_daily_sum: number;
    };
    coverage: { web_days_with_events: number; days_in_period: number };
    confidence: { level: string; reasons: string[] };
    anomaly_flags: { open_web: number; open_api: number };
    links: { verify: string; public_list: string };
  };
  const lastDay = isoZ(Date.parse(d.period.end) - DAY).slice(0, 10);
  const lines: string[] = [
    `${d.project.name} — measured usage, ${d.period.start.slice(0, 10)} to ${lastDay} (${d.period.days} days, ${PRESET_LABELS[d.preset]})`,
    `Snapshot ${d.series.seq} of this project (all are listed at the link below)`,
  ];
  const share = d.web.visit_metrics.suspect_pageview_share;
  lines.push(
    `Web: ${thousands(d.web.verified.pageviews)} verified page views (${thousands(d.web.raw.pageviews)} raw` +
      `${share === null ? "" : `; ${pct(share)}% suspect`}); ${thousands(d.web.verified.visitors_sum)} daily visitors (sum)`,
  );
  if (d.api) {
    const parts = [`${thousands(d.api.requests)} requests`];
    if (d.api.error_rate_5xx !== null) parts.push(`5xx ${pct(d.api.error_rate_5xx)}%`);
    if (d.api.p95_ms !== null) parts.push(`p95 ${thousands(Math.round(d.api.p95_ms))} ms`);
    if (d.api.assurance_level !== null) parts.push(`assurance ${d.api.assurance_level}`);
    lines.push(`API (${d.api.label}): ${parts.join("; ")}`);
  }
  if (d.onchain) {
    const o = d.onchain;
    const ok =
      o.invocations > 0 ? `, ${pct(o.successful_invocations / o.invocations)}% successful` : "";
    lines.push(
      `On-chain (${o.network}, ${o.verified_contracts} verified contracts): ${thousands(o.invocations)} invocations${ok}, ` +
        `${thousands(o.distinct_invokers_daily_sum)} daily invokers (sum)`,
    );
  }
  const reasons = d.confidence.reasons.length ? `: ${d.confidence.reasons.join(", ")}` : "";
  lines.push(
    `Coverage: ${d.coverage.web_days_with_events}/${d.coverage.days_in_period} days with web events; confidence ${d.confidence.level}${reasons}`,
  );
  lines.push(
    `Open anomaly flags: web ${d.anomaly_flags.open_web}, API ${d.anomaly_flags.open_api}`,
  );
  lines.push(
    `Measured by ${d.issuer} (methodology ${d.methodology.version}). "Verified" means passed our bot checks, not endorsed by SCF or SDF.`,
  );
  lines.push(`Verify: ${d.links.verify}   All snapshots of this project: ${d.links.public_list}`);
  return lines.join("\n").slice(0, 4000);
}

export interface V2Request {
  tenantId: string;
  snapshotId: string;
  start: number;
  end: number;
  includeApi: boolean;
  preset: Preset;
  seq: number;
  previousSha256: string | null;
}

export interface V2Options {
  portalOrigin: string;
  /** The deployment's Stellar network (on-chain correlation counts contracts on it). */
  onchainNetwork: "public" | "testnet";
  /** The daily seal's network (C-135: testnet by default). */
  sealNetwork: SealNetworkName;
}

const dayStr = (ms: number) => isoZ(ms).slice(0, 10);

/** The v2 document (without signature), read under the tenant's context as job public_metrics. */
export async function buildTractionDocumentV2(
  tx: Tx,
  r: V2Request,
  o: V2Options,
  now: number,
): Promise<Record<string, unknown>> {
  const p = await projectInfo(tx, r.tenantId);
  const days = Math.round((r.end - r.start) / DAY);
  const startDay = dayStr(r.start);
  const endDay = dayStr(r.end);
  const web = await tenantWeb(tx, r.tenantId, r.start, r.end);
  const t = await tx.one<{ onchain: boolean; seal: boolean; min_count: number | null }>(
    `SELECT onchain_correlation_enabled AS onchain, seal_enabled AS seal,
            (SELECT (value #>> '{}')::int FROM scf.settings WHERE key = 'op_min_count') AS min_count
       FROM scf.tenants WHERE tenant_id = $1`,
    [r.tenantId],
  );
  const finals = await tx.query<{ day: string; final: boolean }>(
    `SELECT day::text AS day, bool_and(is_final) AS final FROM scf.web_daily_totals
      WHERE tenant_id = $1 AND day >= $2::date AND day < $3::date GROUP BY day`,
    [r.tenantId, startDay, endDay],
  );
  const webDaysFinal = finals.filter((f) => f.final).length;
  const webDaysWithEvents = web.days.filter((d) => d.pv_r > 0).length;
  const weeks = isoWeeks(r.start, r.end);
  const weekOf = (day: number) => weeks.findIndex((w) => w.start === isoWeekStart(day));
  const webWeekly = weeks.map((w) => ({
    start: isoZ(w.start),
    days: w.days,
    pageviews_verified: 0,
    pageviews_raw: 0,
    visitors_sum_verified: 0,
  }));
  for (const d of web.days) {
    const row = webWeekly[weekOf(d.day)];
    if (!row) continue;
    row.pageviews_verified += d.pv_v;
    row.pageviews_raw += d.pv_r;
    row.visitors_sum_verified += d.vis_v;
  }

  let api: Record<string, unknown> | null = null;
  let apiDays: number | null = null;
  let apiRequests = 0;
  if (r.includeApi) {
    const a = await tenantApi(tx, r.tenantId, r.start, r.end);
    const weekly = weeks.map((w) => ({ start: isoZ(w.start), days: w.days, requests: 0 }));
    for (const d of a.days) {
      const row = weekly[weekOf(d.day)];
      if (row) row.requests += d.requests;
    }
    apiDays = a.days.filter((d) => d.requests > 0).length;
    apiRequests = a.requests;
    api = {
      label: a.label,
      requests: a.requests,
      error_rate_5xx: a.error_rate_5xx,
      p95_ms: a.p95_ms,
      accuracy_class: a.accuracy_class,
      assurance_level: a.assurance_level,
      onchain_consistent: a.onchain_consistent,
      weekly,
    };
  }

  // On-chain: verified contracts on the platform's network, removed and conflicting ones never counted (C-137).
  const contracts = await tx.query<{ contract_ref: string }>(
    `SELECT contract_ref::text AS contract_ref FROM scf.declared_contracts
      WHERE tenant_id = $1 AND status = 'verified' AND removed_at IS NULL AND conflict_since IS NULL AND network = $2`,
    [r.tenantId, o.onchainNetwork],
  );
  let onchain: Record<string, unknown> | null = null;
  let onchainDays: number | null = null;
  let onchainInvocations = 0;
  if (t.onchain && contracts.length > 0) {
    const rows = await tx.query<{
      day: string;
      n: number;
      inv: string;
      ok: string;
      inv_d: string;
      sources: string[];
    }>(
      `SELECT x.day::text AS day, count(*)::int AS n, sum(x.invocations)::text AS inv,
              sum(x.successful_invocations)::text AS ok, sum(x.distinct_invokers)::text AS inv_d,
              array_agg(DISTINCT x.data_source) AS sources
         FROM scf.onchain_daily x
        WHERE x.tenant_id = $1 AND x.contract_ref = ANY($2::uuid[]) AND x.day >= $3::date AND x.day < $4::date
        GROUP BY x.day ORDER BY x.day`,
      [r.tenantId, contracts.map((c) => c.contract_ref), startDay, endDay],
    );
    const sources = new Set(rows.flatMap((x) => x.sources));
    const weekly = weeks.map((w) => ({
      start: isoZ(w.start),
      days: w.days,
      invocations: 0,
      successful_invocations: 0,
      distinct_invokers_daily_sum: 0,
    }));
    let inv = 0;
    let ok = 0;
    let invokers = 0;
    const daily: Array<Record<string, unknown>> = [];
    for (const x of rows) {
      const d = { inv: Number(x.inv), ok: Number(x.ok), invd: Number(x.inv_d) };
      inv += d.inv;
      ok += d.ok;
      invokers += d.invd;
      const w = weekly[weekOf(Date.parse(`${x.day}T00:00:00Z`))];
      if (w) {
        w.invocations += d.inv;
        w.successful_invocations += d.ok;
        w.distinct_invokers_daily_sum += d.invd;
      }
      // `daily` lists the days with a complete row (one for every verified contract).
      if (x.n === contracts.length)
        daily.push({
          day: x.day,
          invocations: d.inv,
          successful_invocations: d.ok,
          distinct_invokers: d.invd,
        });
    }
    onchainDays = daily.length;
    onchainInvocations = inv;
    onchain = {
      network: o.onchainNetwork === "public" ? "mainnet" : "testnet",
      // ledger files are the primary source (D3); "mixed" when the period has days of both
      data_source: sources.size > 1 ? "mixed" : sources.has("hubble") ? "hubble" : "ledger_files",
      verified_contracts: contracts.length,
      invocations: inv,
      successful_invocations: ok,
      distinct_invokers_daily_sum: invokers,
      daily,
      weekly,
    };
  }

  // D10: counts of OPEN flags only — never a code, a day or a site.
  const flags = await tx.one<{ web: number; api: number }>(
    `SELECT
       (SELECT count(*)::int FROM scf.web_trust_scores s CROSS JOIN LATERAL unnest(s.reason_codes) AS c(code)
         WHERE s.tenant_id = $1 AND s.window_days = 1 AND s.day >= $2::date AND s.day < $3::date
           AND c.code <> 'insufficient_data'
           AND NOT EXISTS (SELECT 1 FROM scf.trust_annotations a
                            WHERE a.tenant_id = s.tenant_id AND a.site_id = s.site_id
                              AND a.range_start <= (s.day::timestamp AT TIME ZONE 'UTC')
                              AND a.range_end > (s.day::timestamp AT TIME ZONE 'UTC')
                              AND (a.marks_explained OR c.code = ANY (a.explains_reason_codes)))) AS web,
       (SELECT count(*)::int FROM scf.api_service_assurance s CROSS JOIN LATERAL unnest(s.reason_codes) AS c(code)
         WHERE s.tenant_id = $1 AND s.day >= $2::date AND s.day < $3::date
           AND (c.code LIKE 'a1\\_%' OR c.code = 'a3_onchain_inconsistent')
           AND NOT EXISTS (SELECT 1 FROM scf.trust_annotations a
                            WHERE a.tenant_id = s.tenant_id AND a.service_id = s.service_id
                              AND a.range_start <= (s.day::timestamp AT TIME ZONE 'UTC')
                              AND a.range_end > (s.day::timestamp AT TIME ZONE 'UTC')
                              AND (a.marks_explained OR c.code = ANY (a.explains_reason_codes)))) AS api`,
    [r.tenantId, startDay, endDay],
  );

  const level = Number(p.verification_level.slice(1));
  const conf = confidence({
    days,
    rawPageviews: web.raw.pageviews,
    verifiedPageviews: web.verified.pageviews,
    webDaysWithEvents,
    webDaysFinal,
    minCount: t.min_count ?? 10,
    hasApiData: apiRequests > 0,
    hasOnchainData: onchainInvocations > 0,
    openFlags: flags.web + flags.api,
    level,
    onchainEnabled: t.onchain,
    verifiedContracts: contracts.length,
  });

  const portal = o.portalOrigin;
  const doc: Record<string, unknown> = {
    schema: SNAPSHOT_SCHEMA_V2,
    snapshot_id: r.snapshotId,
    issued_at: isoZ(now),
    issuer: new URL(portal).host,
    project: {
      slug: p.slug,
      name: p.name,
      verification_level: p.verification_level,
      registry_matches: p.registry_matches,
    },
    series: { seq: r.seq, previous_sha256: r.previousSha256 },
    period: { start: isoZ(r.start), end: isoZ(r.end), days },
    preset: r.preset,
    methodology: { version: METHODOLOGY_VERSION, url: `${portal}/docs/methodology/1.0.0` },
    web: {
      verified: web.verified,
      raw: web.raw,
      visit_metrics: web.visit_metrics,
      weekly: webWeekly,
    },
    api,
    onchain,
    coverage: {
      days_in_period: days,
      web_days_with_events: webDaysWithEvents,
      web_days_final: webDaysFinal,
      api_days_with_data: apiDays,
      onchain_days_complete: onchainDays,
    },
    confidence: conf,
    anomaly_flags: { open_web: flags.web, open_api: flags.api },
    seal: {
      enabled: t.seal,
      network: t.seal ? o.sealNetwork : null,
      proof_url: t.seal ? `${portal}/public/v1/snapshots/${r.snapshotId}/seal` : null,
    },
    links: {
      verify: `${portal}/verify?snapshot=${r.snapshotId}`,
      public_list: `${portal}/public/v1/projects/${p.slug}/snapshots`,
      definitions: `${portal}/docs/metric-definitions/1`,
    },
  };
  doc.text = snapshotText(doc);
  return doc;
}
