// SPDX-License-Identifier: Apache-2.0
// Shared helpers of the scripts that exercise a DEPLOYED host from the operator's workstation (live-load.ts,
// live-drill.ts): superuser psql over SSH (settings and the DEMO site's own rows only), the gateway's spool series from
// the host's Prometheus, the Cloudflare DNS API (DEMO verification TXT), the DEMO site + API service, the temporary
// raise of the platform protections, and the erasure of the DEMO data through the tenant erasure API.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { ApiClient } from "../../../tools/demo-seed/src/api.ts";
import type { demoKey } from "../../../tools/demo-seed/src/stellar.ts";

const run = promisify(execFile);
export const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** psql as the superuser on the host, database `db` (scf: settings and DEMO objects; umami: the DEMO site's events). */
export async function sqlIn(ssh: string, q: string, db = "scf"): Promise<string> {
  const child = execFile("ssh", [
    ssh,
    `P=$(sudo cat /etc/scf/stack/secrets/pg_superuser_password); sudo docker exec -i -e PGPASSWORD="$P" scf-postgres-1 psql -X -At -v ON_ERROR_STOP=1 -h /var/run/postgresql -U postgres -d ${db}`,
  ]);
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stdin?.end(q);
  await new Promise<void>((res, rej) =>
    child.on("close", (c) => (c === 0 ? res() : rej(new Error(`psql exit ${c}`)))),
  );
  return out.trim();
}

/** Prometheus instant query on the host; rendered back into exposition lines (`series`/`sumSeries`). Lag ≤ 15 s. */
export async function promText(ssh: string, selector: string): Promise<string> {
  const q = encodeURIComponent(selector);
  const { stdout } = await run(
    "ssh",
    [
      ssh,
      `sudo docker exec scf-prometheus-1 wget -qO- 'http://127.0.0.1:9090/api/v1/query?query=${q}'`,
    ],
    { maxBuffer: 16 << 20 },
  );
  const d = JSON.parse(stdout) as {
    data: { result: { metric: Record<string, string>; value: [number, string] }[] };
  };
  return d.data.result
    .map(({ metric, value }) => {
      const { __name__: name, ...labels } = metric;
      return `${name}{${Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",")}} ${value[1]}`;
    })
    .join("\n");
}

/** The gateway's spool series (the Compose network name is not resolvable from a shell in the Prometheus container). */
export const gatewayMetrics = (ssh: string) =>
  promText(ssh, '{__name__=~"scf_gateway_spool_events|scf_gateway_spool_queued",job="gateway"}');

export async function hostLoad(ssh: string): Promise<string> {
  const { stdout } = await run("ssh", [
    ssh,
    "cat /proc/loadavg; sudo docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | sort -k2 -rn | head -5 | tr '\\n' ';'",
  ]);
  return stdout.trim().replace(/\n/g, " | ");
}

export const series = (text: string, name: string, label: string) => {
  const line = text.split("\n").find((l) => l.startsWith(`${name}{`) && l.includes(label));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : Number.NaN;
};

export function cloudflare(tokenFile: string, zone: string) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return (await res.json()) as { success: boolean; result: { id: string; content: string }[] };
  };
}
export type Cf = ReturnType<typeof cloudflare>;

/** The platform protections a DEMO run raises (and restores). */
export const PROTECTION_KEYS = [
  "web_requests_per_min_subnet",
  "web_requests_per_min_site",
  "l0_web_requests_per_min_site",
  "l0_events_per_day",
  "pow_max_multiplier",
  "otlp_requests_per_s",
  "otlp_burst",
  "otlp_bytes_per_s",
  "l0_routes_per_day",
];

export async function readSettings(
  ssh: string,
  keys = PROTECTION_KEYS,
): Promise<Record<string, string>> {
  const rows = await sqlIn(
    ssh,
    `SELECT key || '=' || value::text FROM scf.settings WHERE key IN (${keys.map((k) => `'${k}'`).join(",")});`,
  );
  return Object.fromEntries(
    rows
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

export function writeSettings(ssh: string, v: Record<string, string>): Promise<string> {
  for (const [k, x] of Object.entries(v))
    if (!/^[a-z0-9_]+$/.test(k) || !/^[0-9]+(\.[0-9]+)?$/.test(x))
      throw new Error(`refusing setting ${k}=${x}`);
  return sqlIn(
    ssh,
    `BEGIN; ${Object.entries(v)
      .map(([k, x]) => `UPDATE scf.settings SET value = '${x}'::jsonb WHERE key = '${k}';`)
      .join(" ")} COMMIT; NOTIFY scf_edge;`,
  );
}

export interface Demo {
  site: { site_id: string; site_key: string; name: string };
  service: { service_id: string; service_name: string };
  /** `service` first, then the `extraServices`. */
  services: { service_id: string; service_name: string }[];
  token: { token: string; token_id: string };
  host: string;
}

/** A DEMO-labelled site (domain `host`, verified by DNS TXT) and API service with a fresh ingest token, in the
 *  operator's tenant `T` (`/v1/tenants/<id>`). Reuses an existing site/service of the same label. */
export async function ensureDemo(
  api: ApiClient,
  T: string,
  cf: Cf,
  o: {
    host: string;
    siteName: string;
    serviceName: string;
    serviceDisplay: string;
    tokenLabel: string;
    /** More DEMO services (same display name + " · <name>") the one ingest token may send for. */
    extraServices?: string[];
  },
): Promise<Demo> {
  type Site = Demo["site"];
  let site = (await api.call<Site[]>("GET", `${T}/sites`)).find((s) => s.name === o.siteName);
  site ??= await api.call<Site>("POST", `${T}/sites`, {
    name: o.siteName,
    tracker_profile: "standard",
    visitor_id: "on",
  });
  const S = `${T}/sites/${site.site_id}`;
  type Domain = { domain_id: string; host: string; state?: string };
  let dom = (await api.call<Domain[]>("GET", `${S}/domains`)).find((d) => d.host === o.host);
  dom ??= await api.call<Domain>("POST", `${S}/domains`, {
    host: o.host,
    include_subdomains: false,
  });
  if (dom.state !== "verified") {
    const v = await api.call<{ verification_id: string; token: string }>(
      "POST",
      `${S}/domains/${dom.domain_id}/verifications`,
      { method: "dns_txt" },
    );
    const name = `_scf-verify.${o.host}`;
    for (const r of (await cf("GET", `/dns_records?type=TXT&name=${name}`)).result)
      await cf("DELETE", `/dns_records/${r.id}`);
    await cf("POST", "/dns_records", {
      type: "TXT",
      name,
      content: `scf-verify=${v.token}`,
      ttl: 60,
      comment: "DEMO test (temporary)",
    });
    for (let i = 0; i < 20; i++) {
      await sleep(15_000);
      const c = await api
        .call<{ status: string }>(
          "POST",
          `${S}/domains/${dom.domain_id}/verifications/${v.verification_id}/check`,
        )
        .catch(() => ({ status: "error" }));
      if (c.status === "verified") break;
    }
  }
  type Svc = Demo["service"];
  const existing = await api.call<Svc[]>("GET", `${T}/services`);
  const services: Svc[] = [];
  for (const name of [o.serviceName, ...(o.extraServices ?? [])])
    services.push(
      existing.find((s) => s.service_name === name) ??
        (await api.call<Svc>("POST", `${T}/services`, {
          service_name: name,
          display_name: name === o.serviceName ? o.serviceDisplay : `${o.serviceDisplay} · ${name}`,
        })),
    );
  // A run that was killed leaves its token active (a tenant has at most 5): revoke earlier ones of the same label.
  type Tok = { token_id: string; label: string; revoked_at?: string | null };
  for (const t of await api.call<Tok[]>("GET", `${T}/ingest-tokens`))
    if (t.label === o.tokenLabel && !t.revoked_at)
      await api.call("DELETE", `${T}/ingest-tokens/${t.token_id}`).catch(() => undefined);
  const token = await api.call<Demo["token"]>("POST", `${T}/ingest-tokens`, {
    label: o.tokenLabel,
    allowed_service_names: services.map((s) => s.service_name),
  });
  return { site, service: services[0] as Svc, services, token, host: o.host };
}

/** Removes the DEMO verification TXT and revokes the DEMO ingest token. */
export async function cleanupDemo(
  api: ApiClient,
  T: string,
  cf: Cf,
  d: Pick<Demo, "host"> & { tokenId?: string },
) {
  if (d.tokenId) await api.call("DELETE", `${T}/ingest-tokens/${d.tokenId}`).catch(() => undefined);
  for (const r of (await cf("GET", `/dns_records?type=TXT&name=_scf-verify.${d.host}`)).result)
    await cf("DELETE", `/dns_records/${r.id}`);
}

/** Erases today's data of the DEMO site and service (scope site / service, whole UTC day): request, wait for the
 *  count preview, confirm, wait for completion. A failed request (e.g. a deadlock with the writer, live-load LD1) is
 *  retried up to `attempts` times. */
export async function eraseDemo(
  api: ApiClient,
  key: ReturnType<typeof demoKey>,
  T: string,
  siteId: string,
  serviceId: string | string[],
  attempts = 1,
) {
  await api.signIn(key); // recent authentication (x-requires-recent-auth)
  const day = new Date().toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const out: unknown[] = [];
  for (const sel of [
    { scope: "site", site_id: siteId },
    ...(Array.isArray(serviceId) ? serviceId : [serviceId]).map((id) => ({
      scope: "service",
      service_id: id,
    })),
  ]) {
    type Req = { request_id: string; status: string } & Record<string, unknown>;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let req = await api.call<Req>("POST", `${T}/erasure-requests`, {
        ...sel,
        criteria: { start: `${day}T00:00:00Z`, end: `${next}T00:00:00Z` },
      });
      for (let i = 0; i < 60 && req.status === "previewing"; i++) {
        await sleep(5000);
        req = await api.call<Req>("GET", `${T}/erasure-requests/${req.request_id}`);
      }
      const preview = { ...req };
      await api.call("POST", `${T}/erasure-requests/${req.request_id}/confirm`, {});
      for (let i = 0; i < 120 && !["completed", "failed"].includes(req.status); i++) {
        await sleep(5000);
        req = await api.call<Req>("GET", `${T}/erasure-requests/${req.request_id}`);
      }
      out.push({ ...sel, attempt, preview, final: req });
      log(`erasure ${sel.scope} (attempt ${attempt}): ${req.status}`);
      if (req.status === "completed") break;
      await sleep(10_000);
    }
  }
  return out;
}
