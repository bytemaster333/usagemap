// SPDX-License-Identifier: Apache-2.0
// Data-inventory tests (ADR-0026 merge-blocking gate 5; docs/privacy/data-inventory.md; privacy.gdpr-no-consent, privacy.minimal-erasure-scope, api.attribute-allowlist).
// Canary values are sent through the public front doors — a real browser page with a canary title, query string,
// referrer path and identifiers in the path; scripted clients with a canary User-Agent and canary custom-event
// properties; (when the OTLP front door is wired) the API suite's canary spans — and then every persistent store
// and log stream of the running stack is searched:
//   - PostgreSQL `scf` and `umami` (pg_dump --inserts, data and schema),
//   - the gateway's state volume (spool segments, snapshot) — captured while the engine is stopped, so the spool
//     really holds the canary records when it is read,
//   - the Collector's persistent queue volume (if the stack has one),
//   - the container logs of every service of the project, including one-shot jobs.
// Zero tolerance for canaries; generic shapes (client IP addresses, raw User-Agents, seeds, JWTs, bearer tokens,
// query strings, surrogates) only pass with a reasoned allow-list entry, and every allowed hit is listed in the
// evidence file.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { context, launch, serveSite, sitePage, startIngestProxy } from "../lib/browser.ts";
import { asCanaries, loadCanaries, newCanaries, recordCanaries } from "../lib/canaries.ts";
import { Compose } from "../lib/compose.ts";
import { loadEnv } from "../lib/env.ts";
import { createFixture, eventually, gatewayTarget, waitForGateway } from "../lib/fixture.ts";
import { requires } from "../lib/gate.ts";
import { browserHeaders, GatewayClient } from "../lib/gateway-client.ts";
import { insecureGet } from "../lib/http.ts";
import {
  type AllowRule,
  baseAllowList,
  mask,
  type ScanInput,
  STELLAR_ACCOUNT_QUERIES,
  type StellarAccountSets,
  scan,
  stellarAccountAllowList,
} from "../lib/privacy-scan.ts";
import { Recorder } from "../lib/recorder.ts";
import { randomStrKey } from "../lib/stellar.ts";

const run = promisify(execFile);
const env = loadEnv();
const compose = new Compose(env);
const rec = new Recorder(
  env,
  "data-inventory",
  "scan",
  "Data-inventory scan of every store and log of a running stack",
  "Canary values were sent through the public front doors; afterwards both PostgreSQL databases (full pg_dump), the gateway's spool and state volume, the Collector queue volume (when present) and the logs of every container of the project were searched for the canaries and for generic personal-data shapes.",
);

afterAll(() => {
  const out = rec.write();
  if (out) console.log(`evidence: ${out.md}`);
});

async function metric(name: string): Promise<number> {
  const r = await insecureGet(`${env.gatewayMetricsUrl}/metrics`);
  const line = r.body.split("\n").find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(" ")[1]) : Number.NaN;
}

/** IP addresses of the project's own containers (server listen addresses that appear in startup logs). */
async function serviceAddresses(): Promise<string[]> {
  const { stdout } = await run("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${env.project}`,
  ]);
  const ids = stdout.split("\n").filter(Boolean);
  if (ids.length === 0) return [];
  const { stdout: ips } = await run("docker", [
    "inspect",
    "-f",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
    ...ids,
  ]);
  return [...new Set(ips.split(/\s+/).filter(Boolean))];
}

describe("data inventory", () => {
  const c = newCanaries();

  it("sends canaries through the web front door (browser and scripted)", async (ctx) => {
    const d = rec.start(ctx, ["privacy.gdpr-no-consent", "privacy.minimal-erasure-scope"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose", "docker"]);
    const f = await createFixture(env, compose, `wsl-inv-${Date.now().toString(36)}`, [
      { key: "privacy", host: "priv.wsl.test", anonymousReports: false },
    ]);
    const s = f.sites.privacy;
    if (!s) throw new Error("fixture");
    await waitForGateway(env, compose, [s]);
    recordCanaries(env.workDir, "inventory/web", asCanaries(c));

    // 1. real browser: title, query string, fragment, referrer path, identifiers in the path
    const gw = new URL(env.gatewayUrl);
    const proxy = await startIngestProxy(env.ingestHosts, gw.hostname, Number(gw.port));
    const m = JSON.parse((await insecureGet(`${env.gatewayUrl}/lib/manifest.json`)).body) as {
      versions: { version: string; files: { path: string; integrity: string }[] }[];
    };
    const v = m.versions[0];
    const file = v?.files.find((x) => x.path === "standard.js");
    if (!v || !file) throw new Error("manifest");
    const b = await launch("chromium", proxy.url);
    try {
      const page = await (await context(b, { userAgent: c.userAgent })).newPage();
      await serveSite(page, s.origin, () =>
        sitePage({
          tracker: {
            version: v.version,
            integrity: file.integrity,
            src: `https://${env.ingestHosts[0]}/lib/${v.version}/standard.js`,
          },
          siteKey: s.site_key,
          title: c.pageTitle,
        }),
      );
      const accepted = page.waitForResponse((r) => r.url().endsWith("/v1/e") && r.status() === 202);
      await page.goto(
        `${s.origin}/account/${c.endUserAccount}/key/${c.seed}/mail/${encodeURIComponent(c.email)}?scf_q=${c.queryValue}#frag`,
        { referer: `https://ref.example.org/${c.referrerPath}?scf_q=${c.queryValue}` },
      );
      await accepted;
      // the tracker's own guard refuses identifier-shaped custom-event values (returns false, sends nothing)
      expect(
        await page.evaluate(
          (seed) =>
            (window as unknown as { scf: { track: (n: string, p: object) => boolean } }).scf.track(
              "canary",
              { v: seed },
            ),
          c.seed,
        ),
      ).toBe(false);
    } finally {
      await b.close();
      await proxy.close();
    }

    // 2. stop the engine so the scripted records stay in the spool while it is read
    await compose.stop("umami");
    const sc = new GatewayClient(gatewayTarget(env), browserHeaders(s.origin, c.userAgent));
    const { token, c: ctr } = await sc.solved(s.site_key);
    const r = await sc.send({
      site: s.site_key,
      token,
      c: ctr,
      sg: { wd: 0, vis: "v", act: 1 },
      events: [
        { k: "pv", u: `/p/${c.seed}?scf_q=${c.queryValue}`, w: "l", l: "en" },
        {
          k: "ev",
          u: `/u/${c.endUserAccount}`,
          n: "canary_props",
          d: { seed: c.seed, jwt: c.jwt, mail: c.email, acct: c.endUserAccount, ok: "plain" },
        },
      ],
    });
    expect(r.status).toBe(202);
    await eventually(
      "spool holds the canary records",
      () => metric("scf_gateway_spool_queued"),
      (n) => n >= 1,
      30_000,
    );
    const spool = await compose.volumeFiles("gwstate");
    rec.data.spoolFiles = spool.map((x) => ({ path: x.path, bytes: x.text.length }));
    (globalThis as { __spool?: ScanInput[] }).__spool = spool.map((x) => ({
      source: `volume:gwstate${x.path.slice(1)} (engine stopped)`,
      text: x.text,
    }));
    expect(
      spool.some((x) => x.text.includes('"canary_props"') || x.text.includes("canary_props")),
    ).toBe(true);
    await compose.start("umami");
    await eventually(
      "spool drained",
      () => metric("scf_gateway_spool_queued"),
      (n) => n === 0,
      180_000,
      2000,
    );
    d.detail(`spool segments read while the engine was stopped: ${spool.length}`);
  }, 300_000);

  it("a footprint account the project cannot have proved is never stored or logged", async (ctx) => {
    // Registered Footprint (data-model §12.1, C-136/C-137): only accounts a project proves are its own may be kept.
    // The canary is declared as the project's account — exactly the "tenant pastes a user's address" case. Contracts
    // only are accepted and answers 422 for account kinds, so nothing may be stored at all;
    // the scan below allows a `G…` in `scf` only as a VERIFIED footprint subject or an account holder's own account,
    // so a claimed or rejected row with the canary — or the canary in any log line — is a finding.
    const d = rec.start(ctx, ["privacy.gdpr-no-consent", "isolation.tenant-rls"]);
    await requires(env, ctx, ["control-plane", "compose"]);
    const f = await createFixture(env, compose, `wsl-fp-${Date.now().toString(36)}`, []);
    const canaries = [
      {
        label: "footprint: undeclarable app account",
        value: randomStrKey("G"),
        kind: "app_account",
      },
      {
        label: "footprint: undeclarable issuing account",
        value: randomStrKey("G"),
        kind: "issuing_account",
      },
    ];
    recordCanaries(
      env.workDir,
      "inventory/footprint",
      canaries.map(({ label, value }) => ({ label, value })),
    );
    const statuses: number[] = [];
    for (const c of canaries) {
      const r = await f.cp.call(
        "POST",
        `/v1/tenants/${f.tenantId}/footprint`,
        { kind: c.kind, subject: c.value, network: "testnet", label: "treasury" },
        [201, 400, 404, 409, 422],
      );
      statuses.push(r.status);
    }
    rec.data.footprintCanaryStatuses = statuses;
    // Account kinds are refused (422); a route that does not exist yet (404) stores nothing either.
    for (const st of statuses) expect([404, 422], `status ${st}`).toContain(st);
    d.detail(
      `declared ${canaries.length} canary accounts as footprint items: answers ${statuses.join(", ")}`,
    );
  }, 120_000);

  it("no canary and no unexplained personal-data shape in any store or log", async (ctx) => {
    const d = rec.start(ctx, [
      "privacy.gdpr-no-consent",
      "privacy.minimal-erasure-scope",
      "api.attribute-allowlist",
      "isolation.tenant-rls",
    ]);
    await requires(env, ctx, ["compose", "docker"]);
    const inputs: ScanInput[] = [...((globalThis as { __spool?: ScanInput[] }).__spool ?? [])];
    for (const db of ["scf", "umami"] as const)
      inputs.push({ source: `pg_dump:${db}`, text: await compose.pgDump(db) });
    for (const vol of ["gwstate", "colqueue"]) {
      if (!(await compose.volumeExists(vol))) continue;
      for (const f of await compose.volumeFiles(vol))
        inputs.push({ source: `volume:${vol}${f.path.slice(1)}`, text: f.text });
    }
    const services = await compose.services(true);
    for (const svc of services)
      inputs.push({ source: `log:${svc}`, text: await compose.logs(svc) });

    const own = await serviceAddresses();
    const gateways = await compose.networkGateways();
    const allow: AllowRule[] = [
      ...baseAllowList(),
      ...own
        .filter((ip) => !gateways.includes(ip))
        .map((ip) => ({
          kind: "ipv4" as const,
          match: ip,
          source: /^log:/,
          reason: "a container's own address in its startup log (server side, not a client)",
        })),
    ];
    // G… accounts: exact values only — verified footprint subjects and the platform's own account holders, read
    // from the database now (C-137); no blanket rule.
    const sets = {} as StellarAccountSets;
    for (const k of Object.keys(STELLAR_ACCOUNT_QUERIES) as (keyof StellarAccountSets)[])
      sets[k] = (await compose.sql("scf", STELLAR_ACCOUNT_QUERIES[k])).map((r) => r[0] as string);
    allow.push(...stellarAccountAllowList(sets));
    rec.data.allowedStellarAccounts = Object.fromEntries(
      Object.entries(sets).map(([k, v]) => [k, v.length]),
    );
    // The spool record carries, by contract (wire-formats §d.2, §c.3), the surrogate address — a keyed HMAC of
    // address and User-Agent under the daily key, not reversible — and one of the gateway's fixed synthetic
    // User-Agent templates, never the raw one (the canary UA token proves the latter).
    const templates = JSON.parse(
      (
        await run("docker", [
          "exec",
          await compose.containerId("gateway"),
          "/usr/local/bin/gateway",
          "templates",
        ])
      ).stdout,
    ) as { UA: string }[];
    // the gateway keeps the client's browser major in the template (§c.3), so digits are matched as digits
    const prefixes = [
      ...new Set(
        templates
          .map((t) => /^Mozilla\/5\.0 \([^)]{3,200}\)/.exec(t.UA)?.[0])
          .filter((x): x is string => !!x)
          .map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\d+/g, "\\d+")),
      ),
    ].map((p) => new RegExp(`^${p}$`));
    rec.data.syntheticUaTemplates = templates.length;
    allow.push(
      {
        kind: "surrogate",
        match: /^2001:db8:/i,
        source: /^volume:gwstate\/spool\//,
        reason:
          "spool record field `surrogate` (wire-formats §d.2/§c.3): keyed daily HMAC; the segment is deleted once fully acknowledged or expired (§d.1)",
      },
      ...prefixes.map((p) => ({
        kind: "user_agent" as const,
        match: p,
        source: /^volume:gwstate\/spool\//,
        reason:
          "spool record field `ua`: one of the gateway's fixed synthetic templates (§c.3), not the client's",
      })),
    );
    allow.push({
      kind: "user_agent",
      match: /^Go-http-client\/\d$/,
      source: /^volume:colqueue\//,
      reason:
        "the gateway's own Go HTTP client User-Agent on its loopback hop to the Collector, written by the queue with the request metadata (C-107) — a constant, not the tenant's",
    });
    const canaries = [...asCanaries(c), ...loadCanaries(env.workDir)];
    const res = scan(inputs, canaries, allow);
    const bySource = new Map<string, number>();
    for (const i of inputs) bySource.set(i.source, i.text.length);
    rec.data.sources = Object.fromEntries(bySource);
    rec.data.allowedHits = Object.entries(
      res.allowedHits.reduce<Record<string, number>>((a, h) => {
        const k = `${h.kind} in ${h.source.replace(/^log:.*/, "logs")}: ${h.reason}`;
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {}),
    );
    rec.data.findings = res.findings;
    rec.data.canaryLabels = canaries.map((x) => `${x.label} ${mask(x.value)}`);
    rec.notes = [
      "### Sources scanned",
      "",
      "| Source | Bytes |",
      "|---|---|",
      ...[...bySource.entries()].map(([k, v]) => `| ${k} | ${v} |`),
      "",
      "### Allowed shape hits (with reason)",
      "",
      ...(rec.data.allowedHits as [string, number][]).map(([k, n]) => `- ${n} × ${k}`),
      "",
      `### Findings: ${res.findings.length}`,
      "",
      ...res.findings
        .slice(0, 50)
        .map((f) => `- \`${f.source}\` ${f.kind}/${f.label} ${f.masked}: \`${f.context}\``),
    ].join("\n");
    d.detail(
      `${inputs.length} sources, ${res.bytesScanned} bytes, ${canaries.length} canaries, ${res.findings.length} findings, ${res.allowedHits.length} allowed hits`,
    );
    expect(services.length).toBeGreaterThan(5);
    expect(
      res.findings.map((f) => `${f.source} ${f.kind}/${f.label} ${f.masked} ${f.context}`),
    ).toEqual([]);
  }, 600_000);
});
