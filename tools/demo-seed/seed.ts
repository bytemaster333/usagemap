// SPDX-License-Identifier: Apache-2.0
// Seeds the synthetic DEMO projects into a running local stack (README.md). Usage:
//   node tools/demo-seed/seed.ts [--portal http://localhost:5173] [--project compose] [--phrase TEXT]
//                                [--pg-container ID] [--mode api|db] [--operator [--operator-secret S]]
//                                [--keep-live-budget] [--no-engine] [--sql-out DIR] [--dry-run]
//   node tools/demo-seed/seed.ts --reset [--portal …] [--phrase …]
// Idempotent: a re-run finds the demo projects by slug, creates what is missing and replaces every derived row of the
// demo projects; nothing outside the `demo-` slugs is written or deleted. Local stacks only (src/guard.ts): a loopback
// portal and a PostgreSQL container of a stack started with infra/compose/compose.dev.yaml; the demo operator's
// key comes from a secret (--operator-secret / SCF_DEMO_OPERATOR_SECRET, or a random one printed once), never from the
// public demo phrase.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiClient, HttpError, type TenantSummary } from "./src/api.ts";
import {
  assertLocalStack,
  containerLabels,
  isLoopbackOrigin,
  operatorSecret,
  SeedGuardError,
} from "./src/guard.ts";
import { buildPlan, DEFAULT_PHRASE, type TenantPlan } from "./src/plan.ts";
import { postgresContainer, psql } from "./src/psql.ts";
import {
  ANNOTATION_BODY,
  buildScfSql,
  DEFAULTS,
  grantOperatorSql,
  operatorKey,
  ownerKey,
  type SeedOptions,
  stagedCounts,
  viewerKey,
} from "./src/sql.ts";
import { dayString } from "./src/traffic.ts";
import { buildUmamiSql, type UmamiWebsite } from "./src/umami.ts";

const { values: args } = parseArgs({
  options: {
    portal: { type: "string", default: process.env.SCF_DEMO_PORTAL ?? "http://localhost:5173" },
    project: { type: "string", default: process.env.SCF_DEMO_PROJECT ?? "compose" },
    "pg-container": { type: "string" },
    phrase: { type: "string", default: process.env.SCF_DEMO_PHRASE ?? DEFAULT_PHRASE },
    mode: { type: "string", default: "api" },
    "keep-live-budget": { type: "boolean", default: false },
    "no-engine": { type: "boolean", default: false },
    "sql-out": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
    operator: { type: "boolean", default: false },
    "operator-secret": { type: "string", default: process.env.SCF_DEMO_OPERATOR_SECRET },
  },
});

const log = (s: string) => process.stdout.write(`${s}\n`);
const phrase = args.phrase as string;
const mode = args.mode === "db" ? "db" : "api";
const plan = buildPlan(phrase);
const opts: SeedOptions = {
  phrase,
  today: new Date(),
  mode,
  historyDays: DEFAULTS.historyDays,
  propsDays: DEFAULTS.propsDays,
  apiHourlyDays: DEFAULTS.apiHourlyDays,
  liveBudget: args["keep-live-budget"] ? null : DEFAULTS.liveBudget,
};

async function ownerClient(t: TenantPlan): Promise<ApiClient> {
  const c = new ApiClient(args.portal as string);
  await c.signIn(ownerKey(phrase, t.slug));
  return c;
}

const tenantOf = async (c: ApiClient, slug: string) =>
  (await c.call<TenantSummary[]>("GET", "/v1/me/tenants")).find((x) => x.slug === slug);

/** Projects, websites, services, contracts and the demo viewer's membership, through the public API. */
async function apiPhase(): Promise<Map<string, { client: ApiClient; tenantId: string }>> {
  const viewer = new ApiClient(args.portal as string);
  await viewer.signIn(viewerKey(phrase));
  const viewerOf = new Set(
    (await viewer.call<TenantSummary[]>("GET", "/v1/me/tenants")).map((x) => x.slug),
  );
  const out = new Map<string, { client: ApiClient; tenantId: string }>();
  for (const t of plan) {
    const c = await ownerClient(t);
    let tenant = await tenantOf(c, t.slug);
    if (!tenant) {
      await c.call("POST", "/v1/tenants", {
        slug: t.slug,
        name: t.name,
        description: t.description,
      });
      tenant = await tenantOf(c, t.slug);
    }
    if (!tenant) throw new Error(`project ${t.slug} was not created`);
    if (tenant.status === "removed")
      throw new Error(
        `${t.slug} was removed by --reset and waits for tenant_purge; seed a fresh stack (make down -v; make up)`,
      );
    const tid = tenant.tenant_id;
    const p = `/v1/tenants/${tid}`;
    if (t.website) {
      const sites = await c.call<{ name: string }[]>("GET", `${p}/sites`);
      if (!sites.some((s) => s.name === t.website?.name))
        await c.call("POST", `${p}/sites`, {
          name: t.website.name,
          tracker_profile: "standard",
          visitor_id: "on",
        });
    }
    if (t.api) {
      const services = await c.call<{ service_name: string }[]>("GET", `${p}/services`);
      if (!services.some((s) => s.service_name === t.api?.serviceName))
        await c.call("POST", `${p}/services`, {
          service_name: t.api.serviceName,
          display_name: t.api.displayName,
          declared_base_url: t.api.baseUrl,
          rpc_method_dimension: t.api.kind === "rpc",
        });
    }
    if (t.contracts.length > 0) {
      const have = await c.call<{ contract_id: string; network: string }[]>(
        "GET",
        `${p}/contracts`,
      );
      for (const k of t.contracts)
        if (!have.some((h) => h.contract_id === k.contractId && h.network === k.network))
          await c.call("POST", `${p}/contracts`, {
            contract_id: k.contractId,
            network: k.network,
            label: k.label,
          });
    }
    if (!viewerOf.has(t.slug)) {
      const inv = await c.call<{ code: string }>("POST", `${p}/invitations`, {
        role: "viewer",
        note: "DEMO read-only viewer",
        expires_in_hours: 1,
      });
      await viewer.call("POST", "/v1/invitations/accept", { code: inv.code });
    }
    out.set(t.slug, { client: c, tenantId: tid });
    log(`  api   ${t.slug}`);
  }
  return out;
}

/** The tenant's annotation of the launch spike and the evidence-pack requests, through the API (after the SQL phase). */
async function apiAfter(clients: Map<string, { client: ApiClient; tenantId: string }>) {
  for (const t of plan) {
    const e = clients.get(t.slug);
    if (!e) continue;
    const p = `/v1/tenants/${e.tenantId}`;
    if (t.website?.anomaly === "spike") {
      const anns = await e.client.call<{ body: string }[]>("GET", `${p}/annotations`);
      if (!anns.some((a) => a.body === ANNOTATION_BODY)) {
        const site = (
          await e.client.call<{ site_id: string; name: string }[]>("GET", `${p}/sites`)
        ).find((s) => s.name === t.website?.name);
        await e.client.call("POST", `${p}/annotations`, {
          site_id: site?.site_id,
          start: `${dayString(opts.today, 12)}T00:00:00Z`,
          end: `${dayString(opts.today, 11)}T00:00:00Z`,
          body: ANNOTATION_BODY,
          explains_reason_codes: ["step_change"],
        });
      }
    }
    if (t.snapshotPreset) {
      const existing = await e.client.call<unknown[]>("GET", `${p}/traction-snapshots`);
      if (existing.length === 0) {
        const today = opts.today;
        const period =
          t.snapshotPreset === "pg_renewal_quarter"
            ? lastQuarter(today)
            : {
                start: `${dayString(today, 84)}T00:00:00Z`,
                end: `${dayString(today, 0)}T00:00:00Z`,
              };
        const body = { period_start: period.start, period_end: period.end, include_api: true };
        try {
          await e.client.call("POST", `${p}/traction-snapshots`, {
            ...body,
            schema_version: 2,
            preset: t.snapshotPreset,
          });
        } catch (err) {
          // a control plane without snapshot v2 yet: request a v1 snapshot instead
          if (!(err instanceof HttpError && err.status === 400)) throw err;
          await e.client.call("POST", `${p}/traction-snapshots`, body);
        }
      }
    }
  }
}

function lastQuarter(d: Date) {
  const q = Math.floor(d.getUTCMonth() / 3);
  const end = Date.UTC(d.getUTCFullYear(), q * 3, 1);
  const start = Date.UTC(d.getUTCFullYear(), q * 3 - 3, 1);
  const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`;
  return { start: iso(start), end: iso(end) };
}

async function reset() {
  if (!isLoopbackOrigin(args.portal as string))
    throw new SeedGuardError(`refusing to reset ${args.portal}: local stacks only`);
  assertLocalStack({
    portal: args.portal as string,
    labels: containerLabels(postgresContainer(args.project as string)),
  });
  for (const t of plan) {
    try {
      const c = await ownerClient(t);
      const tenant = await tenantOf(c, t.slug);
      if (!tenant || tenant.status === "removed") continue;
      await c.call("POST", `/v1/tenants/${tenant.tenant_id}/removal`, { reason: "DEMO reset" });
      log(`  removed ${t.slug}`);
    } catch (err) {
      log(`  ${t.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(
    "Demo projects removed (purged by the tenant_purge job after the grace period; `make down -v` drops a local stack).",
  );
}

async function main() {
  if (args.reset) return reset();
  const scfSql = buildScfSql(plan, opts);
  const counts = stagedCounts(scfSql);
  log(`demo seed: ${plan.length} projects, mode ${mode}; rows ${JSON.stringify(counts)}`);
  if (args["sql-out"]) {
    mkdirSync(args["sql-out"], { recursive: true });
    writeFileSync(join(args["sql-out"], "scf.sql"), scfSql);
  }
  if (args["dry-run"]) return;
  const container = args["pg-container"] ?? postgresContainer(args.project as string);
  assertLocalStack({
    portal: mode === "api" ? (args.portal as string) : null,
    labels: containerLabels(container),
  });
  // Decided before anything is written: a bad operator secret stops the run.
  const opSecret = args.operator ? operatorSecret(args["operator-secret"], phrase) : null;
  const clients = mode === "api" ? await apiPhase() : new Map();
  psql(container, "scf", scfSql);
  log("  sql   scf database written");
  if (mode === "api") {
    await apiAfter(clients);
    if (!args["no-engine"]) {
      const budget = Number(
        psql(
          container,
          "scf",
          "SELECT value #>> '{}' FROM scf.settings WHERE key = 'web_live_events_budget';",
          true,
        ),
      );
      const rows = psql(
        container,
        "scf",
        "SELECT x.slug, s.umami_website_id FROM scf.sites s JOIN scf.tenants x USING (tenant_id) WHERE x.slug LIKE 'demo-%' AND s.status = 'active';",
        true,
      );
      const websites: UmamiWebsite[] = rows
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [slug, websiteId] = l.split("\t") as [string, string];
          return { slug, websiteId };
        });
      const umamiSql = buildUmamiSql(plan, opts, websites, budget);
      if (args["sql-out"]) writeFileSync(join(args["sql-out"], "umami.sql"), umamiSql);
      psql(container, "umami", umamiSql);
      log(`  sql   umami database: live window of ${websites.length} demo websites`);
    }
  }
  if (opSecret && mode === "api") {
    const op = operatorKey(opSecret.secret);
    await new ApiClient(args.portal as string).signIn(op);
    psql(container, "scf", grantOperatorSql(op.account));
    log(`  demo operator ${op.account}: role operator; register a passkey at the first sign-in`);
    if (opSecret.generated) {
      log(`           operator secret (random, shown once): ${opSecret.secret}`);
      log("           (keep it: export SCF_DEMO_OPERATOR_SECRET=<secret> to reuse this operator)");
    }
    log(
      "           (sign with: SCF_DEMO_OPERATOR_SECRET=<secret> node tools/demo-seed/sign.ts --operator '<message>')",
    );
  }
  const rev = viewerKey(phrase);
  log("");
  log("DEMO ready. Read-only viewer (member of every demo project):");
  log(`  account  ${rev.account}`);
  log(
    `  sign in  ${args.portal}/signin → "any wallet" → paste the account, then sign the message with:`,
  );
  log("           node tools/demo-seed/sign.ts '<message>'");
}

main().catch((err) => {
  process.stderr.write(`demo seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
