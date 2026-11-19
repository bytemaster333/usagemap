// SPDX-License-Identifier: Apache-2.0
// Builds the SQL script of the documented DB path (README.md, "What is written where"): one transaction, run as the
// database superuser like the jobs-only rows of the db test seed (db/tests/seed_test.go). Everything is keyed by the
// demo slugs (`demo-…`), staged with COPY into temporary tables and then written with joins, so the script never
// touches a non-demo row: every DELETE is bounded by the tenant ids of demo slugs.

import {
  apiDayTotal,
  apiRowsOf,
  assuranceOf,
  edgeCountersOf,
  HOURLY_SHAPE,
  onchainDayOf,
  type PropRow,
  trustOf,
  walletPropsOf,
} from "./derived.ts";
import { DEMO_SLUG_PREFIX, type TenantPlan } from "./plan.ts";
import { derive, uuidFor } from "./random.ts";
import { demoKey } from "./stellar.ts";
import {
  breakdownsOf,
  DAY_MS,
  type DayShape,
  type DayTotals,
  type DemoSession,
  daySessions,
  dayShape,
  dayString,
  totalsOf,
} from "./traffic.ts";

export interface SeedOptions {
  phrase: string;
  today: Date;
  /** `api`: projects, sites, services and contracts exist (created through the API); `db`: create them here too */
  mode: "api" | "db";
  historyDays: number;
  propsDays: number;
  apiHourlyDays: number;
  /** sets the platform setting web_live_events_budget (null: leave it) */
  liveBudget: number | null;
}

export const DEFAULTS = { historyDays: 120, propsDays: 45, apiHourlyDays: 32, liveBudget: 10_000 };

/** COPY text-format field. */
export function copyField(v: unknown): string {
  if (v === null || v === undefined) return "\\N";
  const s = Array.isArray(v) ? pgArray(v) : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function pgArray(a: unknown[]): string {
  return `{${a.map((x) => (typeof x === "number" ? String(x) : `"${String(x).replace(/(["\\])/g, "\\$1")}"`)).join(",")}}`;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

class Copy {
  readonly lines: string[] = [];
  readonly table: string;
  constructor(table: string) {
    this.table = table;
  }
  row(...v: unknown[]) {
    this.lines.push(v.map(copyField).join("\t"));
  }
  render(): string {
    return `COPY ${this.table} FROM STDIN;\n${this.lines.join("\n")}${this.lines.length ? "\n" : ""}\\.\n`;
  }
}

export interface SiteDay {
  day: string;
  daysBack: number;
  shape: DayShape;
  sessions: DemoSession[];
  totals: DayTotals;
}

/** Every rolled-up day (1 … historyDays back) of a site. Day 0 (today) is only ever in the engine (umami.ts). */
export function siteHistory(
  t: TenantPlan,
  o: Pick<SeedOptions, "phrase" | "today" | "historyDays">,
): SiteDay[] {
  const site = t.website;
  if (!site) return [];
  const out: SiteDay[] = [];
  for (let back = o.historyDays; back >= 1; back--) {
    const day = dayString(o.today, back);
    const shape = dayShape(site, o.phrase, day, back, o.historyDays);
    const sessions = daySessions(site, shape);
    out.push({ day, daysBack: back, shape, sessions, totals: totalsOf(sessions) });
  }
  return out;
}

/** The site's live window in days (scf.web_live_window_days with no hourly rows today). */
export function liveWindowDays(history: SiteDay[], budget: number, maxDays = 90): number {
  const last = history.slice(-28);
  if (last.length === 0) return 1;
  const avg = last.reduce((a, d) => a + d.totals.events_raw, 0) / last.length;
  if (avg === 0) return maxDays;
  return Math.max(1, Math.min(maxDays, Math.floor(budget / avg)));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0
    ? 0
    : s.length % 2
      ? (s[m] as number)
      : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export function ownerKey(phrase: string, slug: string) {
  return demoKey(phrase, `owner:${slug}`);
}
export function viewerKey(phrase: string) {
  // the derivation label stays as first released, so the demo viewer keeps its account
  return demoKey(phrase, "reviewer");
}
export function operatorKey(phrase: string) {
  return demoKey(phrase, "operator-reviewer");
}

/**
 * Grants the SCF-operator role (read-only `operator`, never `operator_admin`) to the demo operator, the only
 * bootstrap path a local stack has (as apps/portal/e2e/real/api-operator.spec.ts). The user exists once it has signed
 * in; its first operator session must register a passkey (C-09, C-114).
 */
export function grantOperatorSql(account: string): string {
  return `\\set ON_ERROR_STOP on
INSERT INTO scf.platform_operators (user_id, role, note)
  SELECT user_id, 'operator', 'DEMO operator (read-only role)' FROM scf.external_identities
   WHERE provider = 'stellar' AND subject = ${lit(account)}
  ON CONFLICT (user_id) DO NOTHING;
`;
}

function siteKey(phrase: string, slug: string): string {
  const A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return [...derive(phrase, `site-key:${slug}`).subarray(0, 22)].map((b) => A[b % 62]).join("");
}

/** SQL that creates the projects themselves (mode `db`): users, identities, tenants, memberships, sites, services, contracts. */
function createSql(plan: TenantPlan[], o: SeedOptions): string {
  const rev = viewerKey(o.phrase);
  const revId = uuidFor(o.phrase, "user:reviewer");
  const parts: string[] = [
    "-- mode db: the projects are created here (no control plane, no analytics engine)",
    `DO $$ BEGIN IF (SELECT value FROM scf.settings WHERE key = 'enrollment_mode') <> '"open"'::jsonb THEN
  RAISE EXCEPTION 'demo seed (mode db) needs enrollment_mode open'; END IF; END $$;`,
    `INSERT INTO scf.users (user_id, display_name) VALUES (${lit(revId)}, 'DEMO viewer (read-only)') ON CONFLICT DO NOTHING;`,
    `INSERT INTO scf.external_identities (user_id, provider, subject) VALUES (${lit(revId)}, 'stellar', ${lit(rev.account)}) ON CONFLICT (provider, subject) DO NOTHING;`,
  ];
  for (const t of plan) {
    const owner = ownerKey(o.phrase, t.slug);
    const uid = uuidFor(o.phrase, `user:${t.slug}`);
    const tid = uuidFor(o.phrase, `tenant:${t.slug}`);
    parts.push(
      `INSERT INTO scf.users (user_id, display_name) VALUES (${lit(uid)}, ${lit(`DEMO owner ${t.slug.slice(5)}`.slice(0, 80))}) ON CONFLICT DO NOTHING;`,
      `INSERT INTO scf.external_identities (user_id, provider, subject) VALUES (${lit(uid)}, 'stellar', ${lit(owner.account)}) ON CONFLICT (provider, subject) DO NOTHING;`,
      `INSERT INTO scf.tenants (tenant_id, slug, name, description, status, created_by, created_at)
  VALUES (${lit(tid)}, ${lit(t.slug)}, ${lit(t.name)}, ${lit(t.description)}, 'active', ${lit(uid)}, now() - interval '${o.historyDays + 5} days')
  ON CONFLICT (slug) DO NOTHING;`,
      `INSERT INTO scf.memberships (tenant_id, user_id, role) SELECT tenant_id, ${lit(uid)}, 'owner' FROM scf.tenants WHERE slug = ${lit(t.slug)} ON CONFLICT DO NOTHING;`,
      `INSERT INTO scf.memberships (tenant_id, user_id, role, added_by) SELECT tenant_id, ${lit(revId)}, 'viewer', ${lit(uid)} FROM scf.tenants WHERE slug = ${lit(t.slug)} ON CONFLICT DO NOTHING;`,
    );
    if (t.website)
      parts.push(`INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by, created_at)
  SELECT x.tenant_id, ${lit(uuidFor(o.phrase, `site:${t.slug}`))}, ${lit(t.website.name)}, ${lit(siteKey(o.phrase, t.slug))},
         ${lit(uuidFor(o.phrase, `umami:${t.slug}`))}, 'on', ${lit(uid)}, now() - interval '${o.historyDays + 5} days'
    FROM scf.tenants x WHERE x.slug = ${lit(t.slug)}
     AND NOT EXISTS (SELECT 1 FROM scf.sites s WHERE s.tenant_id = x.tenant_id AND s.name = ${lit(t.website.name)});`);
    if (t.api)
      parts.push(`INSERT INTO scf.api_services (tenant_id, service_name, display_name, declared_base_url, rpc_method_dimension, created_by, registered_at)
  SELECT x.tenant_id, ${lit(t.api.serviceName)}, ${lit(t.api.displayName)}, ${lit(t.api.baseUrl)}, ${t.api.kind === "rpc"}, ${lit(uid)}, now() - interval '${o.historyDays + 5} days'
    FROM scf.tenants x WHERE x.slug = ${lit(t.slug)} ON CONFLICT (tenant_id, service_name) DO NOTHING;`);
    for (const c of t.contracts)
      parts.push(`INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, label, service_id, created_by)
  SELECT x.tenant_id, ${lit(c.contractId)}, ${lit(c.network)}, ${lit(c.label)},
         (SELECT s.service_id FROM scf.api_services s WHERE s.tenant_id = x.tenant_id LIMIT 1), ${lit(uid)}
    FROM scf.tenants x WHERE x.slug = ${lit(t.slug)} ON CONFLICT (tenant_id, contract_id, network) DO NOTHING;`);
    if (t.website?.anomaly === "spike") {
      const spikeDay = dayString(o.today, 12);
      const next = dayString(o.today, 11);
      parts.push(`INSERT INTO scf.trust_annotations (tenant_id, annotation_id, site_id, range_start, range_end, author_kind, author_user_id, body, explains_reason_codes)
  SELECT s.tenant_id, ${lit(uuidFor(o.phrase, `annotation:${t.slug}`))}, s.site_id, ${lit(`${spikeDay}T00:00:00Z`)}, ${lit(`${next}T00:00:00Z`)}, 'tenant', ${lit(uid)},
         ${lit(ANNOTATION_BODY)}, ARRAY['step_change']
    FROM scf.sites s JOIN scf.tenants x USING (tenant_id) WHERE x.slug = ${lit(t.slug)} AND s.name = ${lit(t.website.name)}
  ON CONFLICT DO NOTHING;`);
    }
  }
  return parts.join("\n");
}

export const ANNOTATION_BODY =
  "DEMO: launch announcement on social media that day; the spike is the launch campaign, not bot traffic.";

/** The whole script for the scf database. */
export function buildScfSql(plan: TenantPlan[], o: SeedOptions): string {
  for (const t of plan)
    if (!t.slug.startsWith(DEMO_SLUG_PREFIX)) throw new Error(`not a demo slug: ${t.slug}`);
  const out: string[] = [
    "-- SPDX-License-Identifier: Apache-2.0",
    "-- Generated by tools/demo-seed/seed.ts. Synthetic DEMO data only; every row belongs to a tenant whose slug starts with 'demo-'.",
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    "SET LOCAL synchronous_commit = off;",
  ];
  if (o.mode === "db") out.push(createSql(plan, o));

  // ---- staging
  const tenants = new Copy("st_tenant");
  const sites = new Copy("st_site");
  const contracts = new Copy("st_contract");
  const totals = new Copy("st_totals");
  const bd = new Copy("st_bd");
  const counters = new Copy("st_counter");
  const trust = new Copy("st_trust");
  const props = new Copy("st_props");
  const api = new Copy("st_api");
  const assurance = new Copy("st_assurance");
  const chain = new Copy("st_chain");

  for (const t of plan) {
    const owner = ownerKey(o.phrase, t.slug);
    const domain = t.website
      ? t.website.host
      : `api.${t.slug.slice(DEMO_SLUG_PREFIX.length)}.demo.invalid`;
    tenants.row(
      t.slug,
      t.level,
      t.registryLinked,
      t.round,
      t.stage,
      t.categories,
      t.publicStats,
      t.sealEnabled,
      t.onchainEnabled,
      owner.account,
      domain,
      t.name,
    );
    for (const c of t.contracts) contracts.row(t.slug, c.contractId, c.network, c.verified);

    if (t.website) {
      const site = t.website;
      sites.row(t.slug, site.name, site.host);
      const history = siteHistory(t, o);
      const pvHistory: number[] = [];
      const window28: {
        pv: number;
        pvr: number;
        dc: number;
        all: number;
        eng: number;
        fast: number;
      }[] = [];
      for (const d of history) {
        const x = d.totals;
        totals.row(
          t.slug,
          site.name,
          d.day,
          x.pageviews_verified,
          x.pageviews_raw,
          x.visitors_verified,
          x.visitors_raw,
          x.visits,
          x.bounces,
          x.total_duration_s,
          x.events_raw,
        );
        for (const r of breakdownsOf(d.sessions))
          bd.row(
            t.slug,
            site.name,
            d.day,
            r.variant,
            r.dimension,
            r.value,
            r.rank,
            r.visitors,
            r.pageviews,
            r.visits,
            r.events,
          );
        const ec = edgeCountersOf(site, x, d.shape);
        for (const c of ec.counters)
          counters.row(t.slug, site.name, d.day, c.counter, c.label, c.count);
        const prevMedian = median(pvHistory.slice(-28));
        const step =
          pvHistory.length >= 7 && prevMedian > 0 ? x.pageviews_raw / prevMedian : undefined;
        const mixJsd =
          pvHistory.length >= 7
            ? d.shape.spike
              ? 0.31
              : 0.02 + (d.daysBack % 5) * 0.008
            : undefined;
        const rejectedShare = 0.018;
        const w1 = trustOf(
          1,
          {
            ...ec.trust,
            ...(mixJsd === undefined ? {} : { mixJsd }),
            ...(step === undefined ? {} : { step }),
          },
          rejectedShare,
        );
        window28.push({
          pv: x.pageviews_verified,
          pvr: x.pageviews_raw,
          dc: ec.trust.datacenterShare * x.pageviews_raw,
          all: x.pageviews_raw,
          eng: ec.trust.engagementShare * x.pageviews_raw,
          fast: ec.trust.powFast * x.pageviews_raw,
        });
        const w = window28.slice(-28);
        const sum = (f: (a: (typeof w)[number]) => number) => w.reduce((a, b) => a + f(b), 0);
        const all = Math.max(
          1,
          sum((a) => a.all),
        );
        const w28 = trustOf(
          28,
          {
            pvVerified: sum((a) => a.pv),
            pvRaw: sum((a) => a.pvr),
            datacenterShare: sum((a) => a.dc) / all,
            engagementShare: sum((a) => a.eng) / all,
            multiplicityHigh: 0,
            powFast: sum((a) => a.fast) / all,
          },
          rejectedShare,
        );
        for (const r of [w1, w28])
          trust.row(
            t.slug,
            site.name,
            d.day,
            r.window_days,
            r.score,
            r.components,
            r.reason_codes,
            r.decision_rate,
          );
        pvHistory.push(x.pageviews_raw);
        if (d.daysBack <= o.propsDays)
          for (const p of walletPropsOf(site, d.sessions, t.product === "wallet"))
            props.row(
              t.slug,
              site.name,
              d.day,
              p.event,
              p.network,
              p.key,
              p.value,
              p.verdict,
              p.count,
            );
      }
    }

    if (t.api) {
      for (let back = o.historyDays; back >= 1; back--) {
        const day = dayString(o.today, back);
        const total = apiDayTotal(t.api, o.phrase, day, back, o.historyDays);
        for (const r of apiRowsOf(t.api, total))
          api.row(
            t.slug,
            t.api.serviceName,
            "1d",
            `${day}T00:00:00Z`,
            r.route,
            r.rpcMethod,
            r.method,
            r.status,
            r.count,
            r.sum,
            r.hist,
          );
        if (back <= o.apiHourlyDays)
          HOURLY_SHAPE.forEach((share, h) => {
            for (const r of apiRowsOf(
              t.api as NonNullable<typeof t.api>,
              Math.round(total * share),
            ))
              api.row(
                t.slug,
                t.api?.serviceName,
                "1h",
                `${day}T${String(h).padStart(2, "0")}:00:00Z`,
                r.route,
                r.rpcMethod,
                r.method,
                r.status,
                r.count,
                r.sum,
                r.hist,
              );
          });
        const a = assuranceOf(t);
        if (a)
          assurance.row(
            t.slug,
            t.api.serviceName,
            day,
            a.level,
            a.onchain_badge,
            a.checks,
            a.reason_codes,
          );
      }
    }

    for (const c of t.contracts.filter((x) => x.verified))
      for (let back = o.historyDays; back >= 1; back--) {
        const day = dayString(o.today, back);
        const v = onchainDayOf(c, o.phrase, day, back, o.historyDays);
        chain.row(t.slug, c.contractId, c.network, day, v.invocations, v.successful, v.invokers);
      }
  }

  out.push(`
CREATE TEMP TABLE st_tenant (slug text CHECK (slug LIKE 'demo-%'), level text, linked boolean, round smallint, stage text,
  categories text[], public_stats boolean, seal boolean, onchain boolean, owner_account text, domain text, name text) ON COMMIT DROP;
CREATE TEMP TABLE st_site (slug text, site_name text, host text) ON COMMIT DROP;
CREATE TEMP TABLE st_contract (slug text, contract_id text, network text, verified boolean) ON COMMIT DROP;
CREATE TEMP TABLE st_totals (slug text, site_name text, day date, pv_v bigint, pv_r bigint, vis_v bigint, vis_r bigint,
  visits bigint, bounces bigint, dur bigint, events_raw bigint) ON COMMIT DROP;
CREATE TEMP TABLE st_bd (slug text, site_name text, day date, variant scf.web_variant, dimension scf.web_dimension, value text,
  rank smallint, visitors bigint, pageviews bigint, visits bigint, events bigint) ON COMMIT DROP;
CREATE TEMP TABLE st_counter (slug text, site_name text, day date, counter text, label text, count bigint) ON COMMIT DROP;
CREATE TEMP TABLE st_trust (slug text, site_name text, day date, window_days smallint, score smallint, components jsonb,
  reason_codes text[], decision_rate numeric(5,4)) ON COMMIT DROP;
CREATE TEMP TABLE st_props (slug text, site_name text, day date, event_name text, network text, prop_key text, prop_value text,
  verdict text, count bigint) ON COMMIT DROP;
CREATE TEMP TABLE st_api (slug text, service_name text, gran text, bucket timestamptz, route text, rpc_method text,
  method smallint, status smallint, count bigint, dsum float8, hist int4[]) ON COMMIT DROP;
CREATE TEMP TABLE st_assurance (slug text, service_name text, day date, level smallint, badge text, checks jsonb,
  reason_codes text[]) ON COMMIT DROP;
CREATE TEMP TABLE st_chain (slug text, contract_id text, network text, day date, inv bigint, ok bigint, invokers bigint) ON COMMIT DROP;`);
  for (const c of [
    tenants,
    sites,
    contracts,
    totals,
    bd,
    counters,
    trust,
    props,
    api,
    assurance,
    chain,
  ])
    out.push(c.render());

  out.push(`
-- ---- resolve and check: every planned project, website, service and contract must exist
CREATE TEMP TABLE demo_t ON COMMIT DROP AS
  SELECT x.tenant_id, s.* FROM st_tenant s JOIN scf.tenants x ON x.slug = s.slug AND x.slug LIKE 'demo-%';
DO $$ BEGIN
  IF (SELECT count(*) FROM demo_t) <> (SELECT count(*) FROM st_tenant) THEN
    RAISE EXCEPTION 'demo seed: % of % demo projects exist; run the API phase first', (SELECT count(*) FROM demo_t), (SELECT count(*) FROM st_tenant);
  END IF;
  IF EXISTS (SELECT 1 FROM demo_t WHERE NOT EXISTS (SELECT 1 FROM scf.tenants x WHERE x.tenant_id = demo_t.tenant_id AND x.status = 'active')) THEN
    RAISE EXCEPTION 'demo seed: a demo project is not active (enrollment_mode approval_required? approve it in the operator console first)';
  END IF;
END $$;
CREATE TEMP TABLE demo_s ON COMMIT DROP AS
  SELECT DISTINCT ON (t.tenant_id, s.site_name) t.tenant_id, x.site_id, s.slug, s.site_name, s.host
    FROM st_site s JOIN demo_t t USING (slug) JOIN scf.sites x ON x.tenant_id = t.tenant_id AND x.name = s.site_name AND x.status = 'active'
   ORDER BY t.tenant_id, s.site_name, x.created_at;
CREATE TEMP TABLE demo_svc ON COMMIT DROP AS
  SELECT DISTINCT t.tenant_id, x.service_id, a.slug, a.service_name
    FROM (SELECT DISTINCT slug, service_name FROM st_api) a JOIN demo_t t USING (slug)
    JOIN scf.api_services x ON x.tenant_id = t.tenant_id AND x.service_name = a.service_name;
DO $$ BEGIN
  IF (SELECT count(*) FROM demo_s) <> (SELECT count(*) FROM st_site) THEN RAISE EXCEPTION 'demo seed: a demo website is missing'; END IF;
  IF (SELECT count(*) FROM demo_svc) <> (SELECT count(DISTINCT (slug, service_name)) FROM st_api) THEN RAISE EXCEPTION 'demo seed: a demo API service is missing'; END IF;
  IF (SELECT count(*) FROM st_contract c JOIN demo_t t USING (slug)
        JOIN scf.declared_contracts d ON d.tenant_id = t.tenant_id AND d.contract_id = c.contract_id AND d.network = c.network AND d.removed_at IS NULL)
     <> (SELECT count(*) FROM st_contract) THEN RAISE EXCEPTION 'demo seed: a demo contract is missing'; END IF;
END $$;

-- ---- project flags (tenant settings the owner could switch in the portal)
UPDATE scf.tenants x SET description = ${lit(plan[0]?.description ?? "")}, public_stats_enabled = t.public_stats,
       seal_enabled = t.seal, onchain_correlation_enabled = t.onchain, footprint_none_declared = false
  FROM demo_t t WHERE x.tenant_id = t.tenant_id;

-- ---- verification ladder (the outcome the verifiers would record; the demo hosts are .invalid and cannot be proven)
UPDATE scf.declared_contracts d SET status = 'declared', verified_role = NULL, verified_by_evidence = NULL, verified_at = NULL,
       verification_method = NULL, rejected_reason = NULL, conflict_since = NULL
  FROM demo_t t WHERE d.tenant_id = t.tenant_id;
DELETE FROM scf.verification_evidence v USING demo_t t WHERE v.tenant_id = t.tenant_id AND v.details ->> 'demo' = 'true';
DELETE FROM scf.tenant_registry_links l USING demo_t t WHERE l.tenant_id = t.tenant_id;
INSERT INTO scf.site_domains (tenant_id, site_id, host, state, verified_at)
  SELECT s.tenant_id, s.site_id, s.host, 'verified', now() - interval '100 days' FROM demo_s s
  ON CONFLICT (tenant_id, site_id, host) DO UPDATE SET state = 'verified', verified_at = EXCLUDED.verified_at, lapsed_at = NULL, grace_until = NULL;
INSERT INTO scf.host_claims (host, tenant_id, domain_id)
  SELECT d.host, d.tenant_id, d.domain_id FROM scf.site_domains d JOIN demo_s s ON s.tenant_id = d.tenant_id AND s.site_id = d.site_id AND s.host = d.host
  ON CONFLICT DO NOTHING;
INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, verified_at)
  SELECT t.tenant_id, 'domain', t.domain, '{"demo":"true","method":"dns_txt"}', now() - interval '100 days' FROM demo_t t
  ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET details = EXCLUDED.details, status = 'valid';
INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, verified_at)
  SELECT t.tenant_id, 'stellar_account', t.owner_account, '{"demo":"true","method":"sep53"}', now() - interval '90 days'
    FROM demo_t t WHERE t.level IN ('L2', 'L3', 'L4') OR EXISTS (SELECT 1 FROM st_contract c WHERE c.slug = t.slug AND c.verified)
  ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET details = EXCLUDED.details, status = 'valid';
-- source_url: a synthetic registry page (.invalid, never resolves), so the operator console's projects page shows a registry link (K1)
INSERT INTO scf.registry_projects (source, source_id, name, slug, websites, registrable_domains, contract_ids, scf_awarded,
    scf_awards, source_basis, source_url, source_as_of, fetched_at, content_sha256, raw, scf_categories, award_round,
    award_stage)
  SELECT 'operator', 'demo:' || t.slug, t.name, t.slug, ARRAY['https://' || t.domain], ARRAY[t.domain],
         COALESCE((SELECT array_agg(c.contract_id ORDER BY c.contract_id) FROM st_contract c WHERE c.slug = t.slug AND c.verified), '{}'),
         true, jsonb_build_array(jsonb_build_object('round', t.round, 'award_type', 'Build', 'status', 'Awarded')),
         'synthetic demo registry entry', 'https://registry.demo.invalid/projects/' || t.slug, current_date, now(),
         sha256(convert_to('demo:' || t.slug, 'UTF8')),
         jsonb_build_object('demo', true, 'note', 'synthetic demo data'), t.categories, t.round, t.stage
    FROM demo_t t WHERE t.linked
  ON CONFLICT (source, source_id) DO UPDATE SET name = EXCLUDED.name, scf_categories = EXCLUDED.scf_categories,
    award_round = EXCLUDED.award_round, award_stage = EXCLUDED.award_stage, contract_ids = EXCLUDED.contract_ids,
    scf_awards = EXCLUDED.scf_awards, source_url = EXCLUDED.source_url, last_seen_at = now(), missing_since = NULL;
-- unclaimed DEMO registry entries: what "Find your project" (/onboard) finds and the coverage view lists as not
-- enrolled (synthetic names and .example domains, never real projects)
INSERT INTO scf.registry_projects (source, source_id, name, slug, websites, registrable_domains, scf_awarded, scf_awards,
    source_basis, source_url, source_as_of, fetched_at, content_sha256, raw, scf_categories, award_round, award_stage)
  SELECT 'operator', 'demo:' || u.slug, u.name, u.slug, ARRAY['https://' || u.domain], ARRAY[u.domain], true,
         jsonb_build_array(jsonb_build_object('round', u.round, 'award_type', 'Build', 'status', 'Awarded')),
         'synthetic demo registry entry', 'https://registry.demo.invalid/projects/' || u.slug, current_date, now(),
         sha256(convert_to('demo:' || u.slug, 'UTF8')),
         jsonb_build_object('demo', true, 'note', 'synthetic demo data'), u.categories, u.round, u.stage
    FROM (VALUES ('unclaimed-wallet', 'DEMO Unclaimed Wallet', 'unclaimed-wallet.demo.example',
                  ARRAY['end_user_application'], 34, 't1_mvp'),
                 ('unclaimed-devtool', 'DEMO Unclaimed Devtool', 'unclaimed-devtool.demo.example',
                  ARRAY['developer_tooling'], 33, 't2_testnet'),
                 ('unclaimed-anchor', 'DEMO Unclaimed Anchor', 'unclaimed-anchor.demo.example',
                  ARRAY['infrastructure_services'], 32, 't3_mainnet'))
         AS u(slug, name, domain, categories, round, stage)
  ON CONFLICT (source, source_id) DO UPDATE SET source_url = EXCLUDED.source_url, last_seen_at = now(), missing_since = NULL;
INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status, decided_at)
  SELECT t.tenant_id, p.registry_project_id, ARRAY['registrable_domain'], 'confirmed', now() - interval '80 days'
    FROM demo_t t JOIN scf.registry_projects p ON p.source = 'operator' AND p.source_id = 'demo:' || t.slug WHERE t.linked;
INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, verified_at)
  SELECT t.tenant_id, 'registry_match', p.registry_project_id::text, '{"demo":"true","source":"operator","basis":["registrable_domain"]}', now() - interval '80 days'
    FROM demo_t t JOIN scf.registry_projects p ON p.source = 'operator' AND p.source_id = 'demo:' || t.slug WHERE t.linked
  ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET details = EXCLUDED.details, status = 'valid';
INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, verified_at)
  SELECT t.tenant_id, 'operator_approval', 'operator', '{"demo":"true","note":"DEMO: approved for the walkthrough"}', now() - interval '60 days'
    FROM demo_t t WHERE t.level = 'L4'
  ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET details = EXCLUDED.details, status = 'valid';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM demo_t t WHERE 'L' || scf.verification_level(t.tenant_id) <> t.level) THEN
    RAISE EXCEPTION 'demo seed: verification level differs from the plan';
  END IF;
END $$;

-- ---- contracts: verified ones as the contract-verification job would mark them (deployer of the contract)
UPDATE scf.declared_contracts d
   SET status = CASE WHEN c.verified THEN 'verified' ELSE 'declared' END,
       verified_role = CASE WHEN c.verified THEN 'deployer' END,
       verification_method = CASE WHEN c.verified THEN 'deployer_admin_match' END,
       verified_by_evidence = CASE WHEN c.verified THEN v.evidence_id END,
       verified_at = CASE WHEN c.verified THEN now() - interval '85 days' END,
       last_checked_at = now(), rejected_reason = NULL, conflict_since = NULL
  FROM st_contract c JOIN demo_t t USING (slug)
  LEFT JOIN scf.verification_evidence v ON v.tenant_id = t.tenant_id AND v.kind = 'stellar_account' AND v.subject = t.owner_account
 WHERE d.tenant_id = t.tenant_id AND d.contract_id = c.contract_id AND d.network = c.network;

-- ---- rollups: replace every derived row of the demo projects
DELETE FROM scf.web_daily_totals x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.web_daily_breakdowns x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.web_edge_counters x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.web_trust_scores x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.web_event_property_daily x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.api_metrics_1d x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.api_metrics_1h x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.api_route_day x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.api_service_day_groups x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.api_service_assurance x USING demo_t t WHERE x.tenant_id = t.tenant_id;
DELETE FROM scf.onchain_daily x USING demo_t t WHERE x.tenant_id = t.tenant_id;

INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw, pageviews_unidentified_verified,
    pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces, total_duration_s, events_raw, is_final, engine_version)
  SELECT s.tenant_id, s.site_id, x.day, x.pv_v, x.pv_r, 0, 0, x.vis_v, x.vis_r, x.visits, x.bounces, x.dur, x.events_raw, true, 'umami/3.5.0'
    FROM st_totals x JOIN demo_s s ON s.slug = x.slug AND s.site_name = x.site_name;
INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews, visits, events)
  SELECT s.tenant_id, s.site_id, x.day, x.variant, x.dimension, x.value, x.rank, x.visitors, x.pageviews, x.visits, x.events
    FROM st_bd x JOIN demo_s s ON s.slug = x.slug AND s.site_name = x.site_name;
INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count)
  SELECT s.tenant_id, s.site_id, x.day, x.counter, x.label, x.count
    FROM st_counter x JOIN demo_s s ON s.slug = x.slug AND s.site_name = x.site_name;
INSERT INTO scf.web_trust_scores (tenant_id, site_id, day, window_days, score, components, reason_codes, decision_rate, algorithm_version)
  SELECT s.tenant_id, s.site_id, x.day, x.window_days, x.score, x.components, x.reason_codes, x.decision_rate, 'trust/1.0.0'
    FROM st_trust x JOIN demo_s s ON s.slug = x.slug AND s.site_name = x.site_name;
INSERT INTO scf.web_event_property_daily (tenant_id, site_id, day, event_name, network, prop_key, prop_value, verdict, count)
  SELECT s.tenant_id, s.site_id, x.day, x.event_name, x.network, x.prop_key, x.prop_value, x.verdict, x.count
    FROM st_props x JOIN demo_s s ON s.slug = x.slug AND s.site_name = x.site_name;

-- ---- API: stream group, routes, partitions, metric rows, preferred-group bookkeeping, assurance
INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key)
  SELECT tenant_id, service_id, 'sdk_stable', 'http.server.request.duration', 'io.opentelemetry.http', '1|001|io.opentelemetry.http'
    FROM demo_svc ON CONFLICT (tenant_id, service_id, kind, metric_name, scope_name) DO NOTHING;
INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rpc_method, rules_version)
  SELECT DISTINCT v.tenant_id, v.service_id, a.route, regexp_replace(a.route, '/[^/]*$', ''), a.rpc_method, 'scf-path-rules/1.0.0'
    FROM st_api a JOIN demo_svc v ON v.slug = a.slug AND v.service_name = a.service_name
  ON CONFLICT DO NOTHING;
${partitionSql(o)}
CREATE TEMP TABLE demo_api ON COMMIT DROP AS
  SELECT v.tenant_id, v.service_id, r.route_id, g.group_id, a.*
    FROM st_api a JOIN demo_svc v ON v.slug = a.slug AND v.service_name = a.service_name
    JOIN scf.api_routes r ON r.tenant_id = v.tenant_id AND r.service_id = v.service_id AND r.route = a.route
                          AND r.rpc_method IS NOT DISTINCT FROM a.rpc_method AND r.rules_version = 'scf-path-rules/1.0.0'
    JOIN scf.api_stream_groups g ON g.tenant_id = v.tenant_id AND g.service_id = v.service_id AND g.scope_name = 'io.opentelemetry.http'
                                AND g.kind = 'sdk_stable';
INSERT INTO scf.api_metrics_1d (tenant_id, service_id, route_id, method, status_code, source, stream_group_id, bucket_start,
    request_count, duration_sum, duration_min, duration_max, hist_kind, hist)
  SELECT tenant_id, service_id, route_id, method, status, 'sdk_metric', group_id, bucket, count, dsum, NULL, NULL, 'explicit15', hist
    FROM demo_api WHERE gran = '1d';
INSERT INTO scf.api_metrics_1h (tenant_id, service_id, route_id, method, status_code, source, stream_group_id, bucket_start,
    request_count, duration_sum, duration_min, duration_max, hist_kind, hist)
  SELECT tenant_id, service_id, route_id, method, status, 'sdk_metric', group_id, bucket, count, dsum, NULL, NULL, 'explicit15', hist
    FROM demo_api WHERE gran = '1h';
INSERT INTO scf.api_route_day (tenant_id, day, service_id, route_id)
  SELECT DISTINCT tenant_id, (bucket AT TIME ZONE 'UTC')::date, service_id, route_id FROM demo_api WHERE gran = '1d';
INSERT INTO scf.api_service_day_groups (tenant_id, service_id, day, stream_group_id)
  SELECT DISTINCT tenant_id, service_id, (bucket AT TIME ZONE 'UTC')::date, group_id FROM demo_api WHERE gran = '1d';
INSERT INTO scf.api_service_assurance (tenant_id, service_id, day, level, onchain_badge, checks, reason_codes)
  SELECT v.tenant_id, v.service_id, x.day, x.level, x.badge, x.checks, x.reason_codes
    FROM st_assurance x JOIN demo_svc v ON v.slug = x.slug AND v.service_name = x.service_name;

-- ---- on-chain daily counts of the verified demo contracts (synthetic contract ids that exist on no network)
INSERT INTO scf.onchain_daily (tenant_id, contract_ref, day, invocations, successful_invocations, distinct_invokers, data_source)
  SELECT t.tenant_id, d.contract_ref, x.day, x.inv, x.ok, x.invokers, 'ledger_files'
    FROM st_chain x JOIN demo_t t USING (slug)
    JOIN scf.declared_contracts d ON d.tenant_id = t.tenant_id AND d.contract_id = x.contract_id AND d.network = x.network;
`);
  if (o.liveBudget !== null)
    out.push(`-- live window budget (C-109): the demo sites' recent days are answered by the engine; a small budget keeps that window short
UPDATE scf.settings SET value = to_jsonb(${o.liveBudget}) WHERE key = 'web_live_events_budget';`);
  out.push("COMMIT;");
  return `${out.join("\n")}\n`;
}

/**
 * Partitions the API rows need (monthly api_metrics_1h, yearly api_metrics_1d): ensure_partitions() only creates the
 * current and future ones, so older ones are created here the same way — as scf_migrator, the owner, with
 * scf_admin.secure_partition() for RLS and grants — exactly what scf.ensure_partitions() does for its own months.
 */
export function partitionSql(
  o: Pick<SeedOptions, "today" | "historyDays" | "apiHourlyDays">,
): string {
  const parts = new Map<string, [string, string, string]>();
  for (let back = o.historyDays; back >= 1; back--) {
    const d = dayString(o.today, back);
    const y = d.slice(0, 4);
    parts.set(`api_metrics_1d_${y}`, ["api_metrics_1d", `${y}-01-01`, `${Number(y) + 1}-01-01`]);
    if (back <= o.apiHourlyDays) {
      const m = Number(d.slice(5, 7));
      const next =
        m === 12 ? `${Number(y) + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
      parts.set(`api_metrics_1h_${y}${d.slice(5, 7)}`, [
        "api_metrics_1h",
        `${d.slice(0, 7)}-01`,
        next,
      ]);
    }
  }
  const values = [...parts].map(
    ([name, [tbl, from, to]]) => `(${lit(name)}, ${lit(tbl)}, ${lit(from)}, ${lit(to)})`,
  );
  return `SET LOCAL ROLE scf_migrator;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ${values.join(", ")}) AS v (name, tbl, f, t) LOOP
    IF to_regclass(format('scf_part.%I', r.name)) IS NULL THEN
      EXECUTE format('CREATE TABLE scf_part.%I PARTITION OF scf.%I FOR VALUES FROM (%L) TO (%L) WITH (fillfactor = 80)',
                     r.name, r.tbl, r.f || ' 00:00:00+00', r.t || ' 00:00:00+00');
      PERFORM scf_admin.secure_partition(format('scf_part.%I', r.name)::regclass, format('scf.%I', r.tbl)::regclass);
    END IF;
  END LOOP;
END $$;
RESET ROLE;`;
}

/** Counts per staged table, for the summary line and the tests. */
export function stagedCounts(sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /^COPY (st_[a-z]+) FROM STDIN;\n([\s\S]*?)\\\.$/gm;
  for (let m = re.exec(sql); m; m = re.exec(sql))
    out[m[1] as string] = (m[2] as string).split("\n").filter(Boolean).length;
  return out;
}

export type { PropRow };
export { DAY_MS };
