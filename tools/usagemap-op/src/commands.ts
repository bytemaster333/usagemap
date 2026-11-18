// SPDX-License-Identifier: Apache-2.0
// Commands of the operator CLI. Each returns an exit code and writes through `io`, so tests run them in-process
// against a mock server. Nothing here ever contacts a project: invite links are printed for the operator to share.

import { ApiError, type OpClient, UUID_RE } from "./client.ts";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export type CoverageStatus = "not_enrolled" | "enrolled" | "verified" | "measuring";
export const STATUSES: CoverageStatus[] = ["not_enrolled", "enrolled", "verified", "measuring"];

export interface RegistrySummary {
  registry_project_id: string;
  name: string;
  website: string | null;
  domain: string | null;
  categories?: string[];
  award_round?: number | null;
  award_stage?: string | null;
  sources?: string[];
}
export interface CoverageItem {
  project: RegistrySummary;
  status: CoverageStatus;
  tenants_enrolled: number;
  tenants_verified: number;
  tenants_measuring: number;
  invite_url: string;
}
export interface Coverage {
  measuring_days: number;
  totals: Record<"projects" | CoverageStatus, number>;
  items: CoverageItem[];
}
/** `/op/v1/registry/projects` row (one per source row; not merged by domain like the coverage list). */
export interface RegistryRow {
  registry_project_id: string;
  source: string;
  name: string;
  websites?: string[];
  scf_awarded: boolean | null;
  award_round?: number | null;
  linked_project_ids?: string[];
}
export interface OpProject {
  project_id: string;
  slug: string;
  name: string;
  status: string;
  verification_level: string;
  scf_awarded?: boolean | null;
  registry_project_ids?: string[];
  site_count: number;
  service_count: number;
}

export interface Common {
  json: boolean;
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

export function inviteUrl(portalOrigin: string, registryProjectId: string): string {
  return `${portalOrigin}/onboard?project=${encodeURIComponent(registryProjectId)}`;
}

export async function fetchCoverage(
  c: OpClient,
  o: { measuringDays?: number | undefined; status?: string | undefined; q?: string | undefined },
): Promise<Coverage> {
  return c.get<Coverage>("/v1/operator/onboarding/coverage", "session", {
    measuring_days: o.measuringDays,
    status: o.status,
    q: o.q,
  });
}

/** What the machine API alone shows: registry rows and the projects linked to them (no domain-declared enrolment). */
async function keyView(
  c: OpClient,
): Promise<{ rows: RegistryRow[]; projects: Map<string, OpProject> }> {
  const rows = await c.all<RegistryRow>("/op/v1/registry/projects", { scf_awarded: true });
  const projects = new Map<string, OpProject>();
  for (const p of await c.all<OpProject>("/op/v1/projects", { min_level: "L0" }))
    projects.set(p.project_id, p);
  return { rows, projects };
}

function needCredentials(c: OpClient, what: string): void {
  if (!c.hasKey && !c.hasSession)
    throw new ApiError(
      0,
      `${what} needs --session-file (SCF-operator portal session, full onboarding status) or --key-file (SCF-operator API key, registry links only)`,
    );
}

const APPROX_NOTE =
  "approximate: from the machine API (registry links only). A project that declared its domain but has no registry link yet shows as not linked; pass --session-file for the authoritative onboarding status.";

// ---------------------------------------------------------------------------------------------------------------- coverage

export async function coverage(
  c: OpClient,
  io: Io,
  o: Common & { measuringDays?: number | undefined; list: boolean; status?: string | undefined },
): Promise<number> {
  needCredentials(c, "coverage");
  if (c.hasSession) {
    const cov = await fetchCoverage(c, { measuringDays: o.measuringDays, status: o.status });
    if (o.json) {
      io.out(`${JSON.stringify({ source: "coverage", ...cov }, null, 2)}\n`);
      return 0;
    }
    const t = cov.totals;
    const pct = (n: number) => (t.projects ? ` (${((100 * n) / t.projects).toFixed(0)} %)` : "");
    io.out(
      `SCF-awarded registry projects: ${t.projects}  (measuring = verified with data in the last ${cov.measuring_days} days)\n`,
    );
    for (const s of STATUSES) io.out(`  ${pad(s, 13)} ${String(t[s]).padStart(5)}${pct(t[s])}\n`);
    if (o.list) printCoverageItems(io, cov.items);
    return 0;
  }
  const { rows, projects } = await keyView(c);
  const linked = rows.filter((r) => (r.linked_project_ids ?? []).length > 0);
  const levels: Record<string, number> = {};
  for (const r of linked)
    for (const id of r.linked_project_ids ?? []) {
      const lv = projects.get(id)?.verification_level ?? "unknown";
      levels[lv] = (levels[lv] ?? 0) + 1;
    }
  const res = {
    source: "op/v1 (approximate)",
    note: APPROX_NOTE,
    registry_rows: rows.length,
    linked: linked.length,
    not_linked: rows.length - linked.length,
    linked_projects_by_level: levels,
  };
  if (o.json) io.out(`${JSON.stringify(res, null, 2)}\n`);
  else {
    io.out(`SCF-awarded registry rows (per source): ${res.registry_rows}\n`);
    io.out(
      `  linked to a project  ${String(res.linked).padStart(5)}\n  not linked           ${String(res.not_linked).padStart(5)}\n`,
    );
    for (const [lv, n] of Object.entries(levels).sort())
      io.out(`  linked projects at ${lv}: ${n}\n`);
    io.out(`${APPROX_NOTE}\n`);
  }
  return 0;
}

function printCoverageItems(io: Io, items: CoverageItem[]): void {
  io.out(
    `${pad("STATUS", 13)} ${pad("PROJECT", 28)} ${pad("DOMAIN", 24)} RND  E/V/M   REGISTRY ID\n`,
  );
  for (const i of items)
    io.out(
      `${pad(i.status, 13)} ${pad(i.project.name, 28)} ${pad(i.project.domain ?? "-", 24)} ${String(i.project.award_round ?? "-").padStart(3)}  ${`${i.tenants_enrolled}/${i.tenants_verified}/${i.tenants_measuring}`.padEnd(7)} ${i.project.registry_project_id}\n`,
    );
}

// ---------------------------------------------------------------------------------------------------------------- projects

export async function projectsList(
  c: OpClient,
  io: Io,
  o: Common & {
    status?: string | undefined;
    q?: string | undefined;
    measuringDays?: number | undefined;
  },
): Promise<number> {
  needCredentials(c, "projects list");
  if (c.hasSession) {
    const cov = await fetchCoverage(c, o);
    if (o.json) io.out(`${JSON.stringify(cov.items, null, 2)}\n`);
    else {
      printCoverageItems(io, cov.items);
      io.out(`${cov.items.length} project(s); E/V/M = tenants enrolled / verified / measuring\n`);
    }
    return 0;
  }
  if (o.status)
    throw new ApiError(
      0,
      "--status needs --session-file (the machine API has no onboarding status)",
    );
  const { rows, projects } = await keyView(c);
  const q = o.q?.toLowerCase();
  const sel = rows.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      (r.websites ?? []).some((w) => w.toLowerCase().includes(q)),
  );
  const items = sel.map((r) => ({
    registry_project_id: r.registry_project_id,
    source: r.source,
    name: r.name,
    website: r.websites?.[0] ?? null,
    award_round: r.award_round ?? null,
    linked: (r.linked_project_ids ?? []).map((id) => {
      const p = projects.get(id);
      return p
        ? { project_id: id, slug: p.slug, verification_level: p.verification_level }
        : { project_id: id };
    }),
  }));
  if (o.json) io.out(`${JSON.stringify({ note: APPROX_NOTE, items }, null, 2)}\n`);
  else {
    io.out(`${pad("LINKED", 22)} ${pad("PROJECT", 28)} ${pad("SOURCE", 12)} RND  REGISTRY ID\n`);
    for (const i of items) {
      const l = i.linked.length
        ? i.linked
            .map((x) =>
              "slug" in x ? `${x.slug} ${x.verification_level}` : x.project_id.slice(0, 8),
            )
            .join(",")
        : "-";
      io.out(
        `${pad(l, 22)} ${pad(i.name, 28)} ${pad(i.source, 12)} ${String(i.award_round ?? "-").padStart(3)}  ${i.registry_project_id}\n`,
      );
    }
    io.out(`${items.length} registry row(s). ${APPROX_NOTE}\n`);
  }
  return 0;
}

export async function projectsShow(
  c: OpClient,
  io: Io,
  o: Common & { id: string; measuringDays?: number | undefined },
): Promise<number> {
  if (!UUID_RE.test(o.id))
    throw new ApiError(0, "projects show takes a registry project id (UUID)");
  needCredentials(c, "projects show");
  const res: Record<string, unknown> = { registry_project_id: o.id };
  if (c.hasSession) {
    const cov = await fetchCoverage(c, { measuringDays: o.measuringDays });
    res.coverage = cov.items.find((i) => i.project.registry_project_id === o.id) ?? null;
  }
  if (c.hasKey) {
    const { rows, projects } = await keyView(c);
    const mine = rows.filter((r) => r.registry_project_id === o.id);
    res.registry_rows = mine;
    res.linked_projects = [...new Set(mine.flatMap((r) => r.linked_project_ids ?? []))].map(
      (id) =>
        projects.get(id) ?? {
          project_id: id,
          note: "not visible to this key (pending, removed or outside its restriction)",
        },
    );
  }
  if (
    res.coverage === null ||
    (res.coverage === undefined && (res.registry_rows as unknown[]).length === 0)
  ) {
    io.err(
      `no SCF-awarded registry project ${o.id} (unknown, not SCF-awarded, or marked missing by its source)\n`,
    );
    return 1;
  }
  if (o.json) {
    io.out(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  const cov = res.coverage as CoverageItem | undefined;
  if (cov) {
    const p = cov.project;
    io.out(`${p.name}  (${o.id})\n`);
    io.out(`  website      ${p.website ?? "-"}\n  domain       ${p.domain ?? "-"}\n`);
    io.out(
      `  round/stage  ${p.award_round ?? "-"} / ${p.award_stage ?? "-"}\n  sources      ${(p.sources ?? []).join(", ")}\n`,
    );
    io.out(
      `  status       ${cov.status}  (tenants enrolled ${cov.tenants_enrolled}, verified ${cov.tenants_verified}, measuring ${cov.tenants_measuring})\n`,
    );
    io.out(`  invite link  ${cov.invite_url}\n`);
  }
  if (res.registry_rows) {
    const rows = res.registry_rows as RegistryRow[];
    if (!cov && rows[0]) io.out(`${rows[0].name}  (${o.id})\n`);
    for (const r of rows)
      io.out(`  registry     ${r.source}: ${(r.websites ?? []).join(" ") || "-"}\n`);
    const linked = res.linked_projects as Array<Partial<OpProject> & { project_id: string }>;
    if (!linked.length) io.out("  linked       none (no registry link yet)\n");
    for (const p of linked)
      io.out(
        `  linked       ${p.slug ?? p.project_id} ${p.verification_level ?? ""} ${p.status ?? ""} sites ${p.site_count ?? "?"} services ${p.service_count ?? "?"}\n`,
      );
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------- invite

export interface PublicSearch {
  items: RegistrySummary[];
  more: boolean;
}

function inviteMessage(name: string, url: string): string {
  return [
    `Hi ${name} team, UsageMap measures web and API usage of Stellar ecosystem projects`,
    "(privacy-first: no cookies, no IP addresses stored). Your project is pre-selected on this link; sign in with your",
    "Stellar wallet or GitHub, prove your domain, paste one script tag, and you are measuring in about ten minutes:",
    url,
  ].join("\n");
}

export async function invite(
  c: OpClient,
  io: Io,
  o: Common & { id?: string | undefined; search?: string | undefined; message: boolean },
): Promise<number> {
  if (o.search !== undefined) {
    // Public registry search: no credential needed (≤ 10 results, rate-limited by the platform).
    const r = await c.get<PublicSearch>("/public/v1/registry/projects", "none", {
      q: o.search,
      limit: 10,
    });
    const items = r.items.map((p) => ({
      ...p,
      invite_url: inviteUrl(c.portalOrigin, p.registry_project_id),
    }));
    if (o.json) io.out(`${JSON.stringify({ items, more: r.more }, null, 2)}\n`);
    else {
      for (const i of items)
        io.out(`${pad(i.name, 28)} ${pad(i.domain ?? "-", 24)} ${i.invite_url}\n`);
      if (!items.length) io.out(`no SCF-awarded registry project matches "${o.search}"\n`);
      if (r.more) io.out("more matches exist: narrow the search\n");
    }
    return items.length ? 0 : 1;
  }
  const id = o.id ?? "";
  if (!UUID_RE.test(id))
    throw new ApiError(0, "invite takes a registry project id (UUID), or --search TEXT");
  let url = inviteUrl(c.portalOrigin, id);
  let name: string | null = null;
  let status: string | null = null;
  let checked: "coverage" | "registry" | "unchecked" = "unchecked";
  if (c.hasSession) {
    const item = (await fetchCoverage(c, {})).items.find(
      (i) => i.project.registry_project_id === id,
    );
    if (!item) {
      io.err(`no SCF-awarded registry project ${id} in the coverage list\n`);
      return 1;
    }
    url = item.invite_url;
    name = item.project.name;
    status = item.status;
    checked = "coverage";
  } else if (c.hasKey) {
    const row = (await c.all<RegistryRow>("/op/v1/registry/projects", { scf_awarded: true })).find(
      (r) => r.registry_project_id === id,
    );
    if (!row) {
      io.err(`no SCF-awarded registry project ${id}\n`);
      return 1;
    }
    name = row.name;
    checked = "registry";
  }
  if (o.json) {
    io.out(
      `${JSON.stringify({ registry_project_id: id, name, status, invite_url: url, checked }, null, 2)}\n`,
    );
    return 0;
  }
  if (name) io.out(`${name}${status ? `  [${status}]` : ""}\n`);
  io.out(`${url}\n`);
  if (status && status !== "not_enrolled")
    io.err(
      `note: this project is already ${status}; a new sign-up from the link would open a claim dispute\n`,
    );
  if (checked === "unchecked")
    io.err(
      "note: the id was not checked against the registry (no credential given); the portal shows an error for an unknown id\n",
    );
  if (o.message) io.out(`\n${inviteMessage(name ?? "project", url)}\n`);
  io.err("nothing was sent: share the link yourself (UsageMap never contacts projects)\n");
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------- enrol-on-behalf

export const ENROL_ON_BEHALF_STEPS = `enrol-on-behalf: there is no API for it, by design.

The platform has no operation that creates a tenant for someone else: a tenant is created by its first owner
(POST /v1/tenants, any signed-in user), and trust comes only from proofs the project itself makes — its domain (DNS
TXT, /.well-known/ file or meta tag), its Stellar account (stellar.toml + signed message) and the registry match
(ADR-0015). An operator-created tenant could not be verified without the project anyway.

Closest supported path (every step audited):
  1. usagemap-op invite <registry-id>            print the invite link; send it to the project yourself
  2. the project signs in, opens the link (/onboard), checks the pre-filled form, Create project
  3. the project verifies its domain and pastes the snippet from the kit (/t/<tenant>/onboard/kit)
  4. usagemap-op projects show <registry-id>     status moves enrolled → verified → measuring

If a project asks you to do the set-up for them: sign up as a normal user with your own (non-operator) account,
create the project, invite their member (Members → invitation code scfi_…), transfer ownership to them
(POST /v1/tenants/{id}/ownership-transfer), and leave the domain proof to them. Operators' platform role grants no
tenant access (C-17), so do this from a separate account.

A dedicated operator API would need: an audited op_* function that creates a pending tenant bound to a registry
project and an ownership invitation, plus register and data-model text. Not built.
`;

export function enrolOnBehalf(io: Io): number {
  io.out(ENROL_ON_BEHALF_STEPS);
  return 3;
}

// ---------------------------------------------------------------------------------------------------------------- remove

interface OperatorTenantDetail {
  tenant: {
    tenant_id: string;
    slug: string;
    name: string;
    status: string;
    verification_level?: string;
  };
  sites?: unknown[];
  services?: unknown[];
}
interface Tenant {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
  removed_at?: string | null;
  purge_after?: string | null;
}

/** A tenant id, or a slug resolved through the machine API (active and suspended projects only). */
async function tenantId(c: OpClient, arg: string, cmd: string): Promise<string> {
  if (UUID_RE.test(arg)) return arg;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(arg))
    throw new ApiError(0, `${cmd} takes a tenant id (UUID) or slug`);
  if (!c.hasKey)
    throw new ApiError(
      0,
      "a slug is resolved with the machine API: pass --key-file, or give the tenant id",
    );
  const hit = (await c.all<OpProject>("/op/v1/projects", { q: arg, min_level: "L0" })).find(
    (p) => p.slug === arg,
  );
  if (!hit) throw new ApiError(0, `no active or suspended project with slug ${arg}`);
  return hit.project_id;
}

function stepUpHint(e: unknown): never {
  if (e instanceof ApiError && e.code === "step_up_required")
    throw new ApiError(
      e.status,
      "step-up required: sign in to the portal again (the passkey at sign-in is the step-up), copy the new session cookie into the session file (every passkey assertion rotates it), and rerun within 10 minutes",
      e.code,
    );
  throw e;
}

export async function remove(
  c: OpClient,
  io: Io,
  o: Common & { tenant: string; reason?: string | undefined; yes: boolean },
): Promise<number> {
  const id = await tenantId(c, o.tenant, "remove");
  const d = await c.get<OperatorTenantDetail>(`/v1/operator/tenants/${id}`, "session");
  const t = d.tenant;
  const desc = `${t.name} (${t.slug}, ${t.tenant_id}) status ${t.status}, ${d.sites?.length ?? 0} site(s), ${d.services?.length ?? 0} service(s)`;
  if (!o.reason) throw new ApiError(0, "remove needs --reason TEXT (recorded in the audit log)");
  if (!o.yes) {
    io.out(`would remove: ${desc}\n`);
    io.out(
      "effect: ingest stops within 60 s, data hidden, purge after 30 days (reversible by restoration until then),\n",
    );
    io.out(
      "        enrolment tombstones for its verified domains, owners' GitHub identities and Stellar accounts.\n",
    );
    io.out(
      "dry run: add --yes to remove (needs operator_admin and a portal sign-in with your passkey in the last 10 minutes)\n",
    );
    return 0;
  }
  try {
    const r = await c.request<Tenant>("POST", `/v1/operator/tenants/${id}/removal`, {
      auth: "session",
      body: { reason: o.reason },
    });
    if (o.json) io.out(`${JSON.stringify(r, null, 2)}\n`);
    else
      io.out(
        `removed: ${r.name} (${r.slug}) status ${r.status}, purge after ${r.purge_after ?? "-"}\n`,
      );
    return 0;
  } catch (e) {
    stepUpHint(e);
  }
}

// ---------------------------------------------------------------------------------------------------------------- link

interface RegistryLinkRow {
  registry_project_id: string;
  source: string;
  name: string;
  match_basis: string[];
  status?: string;
}

/**
 * Confirms or rejects a tenant's match to a registry project (the step the nightly job cannot make when the registry
 * lists no website or another domain). Confirming creates the link if no candidate exists. Dry run without --yes.
 */
export async function link(
  c: OpClient,
  io: Io,
  o: Common & {
    tenant: string;
    registryId: string;
    decision?: "confirm" | "reject" | undefined;
    yes: boolean;
  },
): Promise<number> {
  if (!UUID_RE.test(o.registryId)) throw new ApiError(0, "link takes a registry project id (UUID)");
  if (!o.decision) throw new ApiError(0, "link needs --confirm or --reject");
  const id = await tenantId(c, o.tenant, "link");
  const d = await c.get<OperatorTenantDetail & { registry_links?: RegistryLinkRow[] }>(
    `/v1/operator/tenants/${id}`,
    "session",
  );
  const t = d.tenant;
  const current = (d.registry_links ?? []).filter((l) => l.registry_project_id === o.registryId);
  const now = current.length
    ? current
        .map((l) => `${l.status ?? "?"} via ${l.match_basis.join("+") || "-"} (${l.source})`)
        .join(", ")
    : "no link yet";
  if (!o.yes) {
    io.out(
      `would ${o.decision} the registry match ${o.registryId} for ${t.name} (${t.slug}); now: ${now}\n`,
    );
    io.out(
      "check first that the tenant is this project (its verified domain, Stellar account or contracts).\n",
    );
    io.out(
      "dry run: add --yes to decide (needs a portal sign-in with your passkey in the last 10 minutes)\n",
    );
    return 0;
  }
  try {
    await c.request<unknown>("PUT", `/v1/operator/tenants/${id}/registry-links/${o.registryId}`, {
      auth: "session",
      body: { decision: o.decision },
    });
  } catch (e) {
    stepUpHint(e);
  }
  if (o.json)
    io.out(
      `${JSON.stringify({ tenant_id: id, registry_project_id: o.registryId, decision: o.decision })}\n`,
    );
  else
    io.out(
      `${o.decision === "confirm" ? "confirmed" : "rejected"}: ${t.name} (${t.slug}) ↔ ${o.registryId}\n`,
    );
  return 0;
}
