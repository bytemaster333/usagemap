// SPDX-License-Identifier: Apache-2.0
// Mock answers of the onboarding of SCF-awarded projects (searchRegistryProjects, getRegistryProjectPrefill,
// getIntegrationKit, operatorRegistryCoverage) for the portal's browser tests. The registry rows are FAKE projects
// (test/fixtures/registry.ts). It follows the contract where the portal depends on it: the public picker needs at
// least 2 characters and pages of at most 10, public fields only; the claim state is `yours` when one of the caller's
// projects declared the registry domain, `claimed` when another project verified it; the kit carries the site's key,
// the first unverified domain, the registered contracts and a checklist computed from the mock state.

import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import {
  CLAIMED_ELSEWHERE,
  FAKE_REGISTRY,
  type FakeRegistryProject,
} from "../../test/fixtures/registry.ts";
import { type Answer, MockProblem } from "./mock-extra.ts";

type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
}) => Answer;

export interface OnboardingCtx {
  /** the signed-in user and platform role (throws the mock's 401 otherwise) */
  session(req: IncomingMessage): { userId: string; role: string | null };
  tenants(): Map<string, ControlPlane.Tenant & { members: Map<string, ControlPlane.TenantRole> }>;
  sites(): Map<string, ControlPlane.Site & { tenantId: string }>;
  domains(): Map<string, ControlPlane.Domain & { siteId: string }>;
  /** contract subjects registered by the tenant */
  contracts(tenantId: string): string[];
  /** the site's script tag as getSnippet(format=html) answers it */
  scriptTag(site: ControlPlane.Site): { code: string; version: string };
  /** the portal origin of this request (invite links) */
  origin(req: IncomingMessage): string;
}

const invalid = (pointer: string, detail: string) =>
  new MockProblem(400, "validation_failed", "Validation failed", { errors: [{ pointer, detail }] });
const notFound = () => new MockProblem(404, "not_found", "Not found");

function summary(p: FakeRegistryProject): ControlPlane.RegistryProjectSummary {
  return {
    registry_project_id: p.id,
    name: p.name,
    website: p.domain ? `https://${p.domain}` : null,
    domain: p.domain,
    categories: p.categories,
    award_round: p.round,
    award_stage: p.stage,
    sources: ["stellarlight"],
  };
}

const onDomain = (host: string, domain: string | null) =>
  domain !== null && (host === domain || host.endsWith(`.${domain}`));

const FRAMEWORK_HINT: Record<string, { framework: ControlPlane.KitFramework; basis: string }> = {
  "vercel.app": { framework: "nextjs", basis: "host *.vercel.app (Vercel, usually Next.js)" },
  "webflow.io": { framework: "nocode", basis: "host *.webflow.io (Webflow)" },
};

function hint(p: FakeRegistryProject | undefined): ControlPlane.FrameworkHint {
  const d = p?.domain ?? "";
  for (const [suffix, h] of Object.entries(FRAMEWORK_HINT)) if (d.endsWith(`.${suffix}`)) return h;
  return { framework: null, basis: null };
}

export function onboardingHandlers(c: OnboardingCtx): Record<string, Handler> {
  const tenantsOf = (userId: string) =>
    [...c.tenants().values()].filter((t) => t.members.has(userId) && t.status !== "removed");
  const domainsOf = (tenantId: string) =>
    [...c.domains().values()].filter((d) => c.sites().get(d.siteId)?.tenantId === tenantId);
  const project = (id: string) => {
    const p = FAKE_REGISTRY.find((x) => x.id === id);
    if (!p) throw notFound();
    return p;
  };

  return {
    searchRegistryProjects: ({ q }) => {
      const text = (q.get("q") ?? "").trim().toLowerCase();
      const limit = Number(q.get("limit") ?? 8);
      if (text.length < 2) throw invalid("/q", "at least 2 characters");
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw invalid("/limit", "1 to 10");
      const hits = FAKE_REGISTRY.filter(
        (p) => p.name.toLowerCase().includes(text) || (p.domain ?? "").includes(text),
      );
      return {
        status: 200,
        body: { items: hits.slice(0, limit).map(summary), more: hits.length > limit },
      };
    },
    getRegistryProjectPrefill: ({ req, p }) => {
      const s = c.session(req);
      const r = project(p.registryProjectId as string);
      const mine = tenantsOf(s.userId).filter((t) =>
        domainsOf(t.tenant_id).some((d) => onDomain(d.host, r.domain)),
      );
      const others = [...c.tenants().values()].some(
        (t) =>
          !t.members.has(s.userId) &&
          domainsOf(t.tenant_id).some((d) => d.state === "verified" && onDomain(d.host, r.domain)),
      );
      const state =
        mine.length > 0 ? "yours" : others || CLAIMED_ELSEWHERE.has(r.id) ? "claimed" : "open";
      const slug = r.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      return {
        status: 200,
        body: {
          project: summary(r),
          links: {
            websites: r.domain ? [`https://${r.domain}`] : [],
            github_orgs: r.githubOrgs,
            source_urls: [],
          },
          prefill: {
            tenant_name: r.name,
            slug,
            site_name: r.domain ?? r.name,
            site_domain: r.domain,
            contracts: r.contracts.map((contract_id) => ({ contract_id, status: "claimed" })),
          },
          claim: { state, your_tenant_ids: mine.map((t) => t.tenant_id) },
          framework_hint: hint(r),
          is_dapp: r.contracts.length > 0,
          verification_options: [
            {
              method: "dns_txt",
              available: true,
              detail: `Add one TXT record at _scf-verify.${r.domain ?? "your domain"}.`,
            },
            {
              method: "well_known",
              available: true,
              detail: "Serve a one-line file under /.well-known/.",
            },
            { method: "meta_tag", available: true, detail: "Add one <meta> tag to the home page." },
            {
              method: "stellar_toml_account",
              available: r.domain !== null,
              detail: "List your account in stellar.toml and sign a message.",
            },
            {
              method: "operator_approval",
              available: true,
              detail: "Automatic once the domain is verified.",
            },
          ],
        } satisfies ControlPlane.RegistryPrefill,
      };
    },
    getIntegrationKit: ({ req, p, q }) => {
      const s = c.session(req);
      const tenantId = p.tenantId as string;
      const t = c.tenants().get(tenantId);
      if (!t?.members.has(s.userId)) throw notFound();
      const fw = q.get("framework");
      const frameworks = [
        "nextjs",
        "nuxt",
        "sveltekit",
        "astro",
        "react_spa",
        "html",
        "nocode",
        "other",
      ];
      if (fw !== null && !frameworks.includes(fw)) throw invalid("/framework", "unknown framework");
      const wanted = q.get("site_id");
      const site = [...c.sites().values()].find(
        (x) => x.tenantId === tenantId && (wanted === null || x.site_id === wanted),
      );
      if (wanted !== null && !site) throw notFound();
      const domains = site
        ? [...c.domains().values()]
            .filter((d) => d.siteId === site.site_id)
            .map((d) => ({ domain_id: d.domain_id, host: d.host, state: d.state }))
        : [];
      const r = FAKE_REGISTRY.find((x) => domains.some((d) => onDomain(d.host, x.domain)));
      const detected = hint(r);
      const selected = (fw ?? detected.framework ?? "html") as ControlPlane.KitFramework;
      const registered = new Set(c.contracts(tenantId));
      const tag = site ? c.scriptTag(site) : null;
      const kitSite = site
        ? {
            site_id: site.site_id,
            name: site.name,
            site_key: site.site_key,
            tracker_profile: site.tracker_profile,
            domains,
          }
        : null;
      const code = (
        title: string,
        text: string,
        guide: string | null,
        filename: string | null = null,
      ) => ({
        title,
        filename,
        install: null,
        code: text,
        guide_path: guide,
      });
      const npm =
        site &&
        selected !== "html" &&
        selected !== "nocode" &&
        selected !== "astro" &&
        selected !== "other"
          ? `import { init } from "@usagemap/tracker";\n\ninit({ site: "${site.site_key}" }); // ${selected}`
          : null;
      return {
        status: 200,
        body: {
          tenant_id: tenantId,
          site: kitSite,
          registry_project: r ? summary(r) : null,
          framework: { selected, detected },
          tracker_version: tag?.version ?? null,
          script_tag: tag
            ? code(
                "Script tag (pinned version, Subresource Integrity)",
                tag.code,
                "docs/onboarding/web-html.md",
              )
            : null,
          framework_snippet: tag
            ? npm
              ? {
                  ...code(
                    `Starter for ${selected}`,
                    npm,
                    `docs/onboarding/web-${selected}.md`,
                    "src/analytics.ts",
                  ),
                  install: `pnpm add --save-exact @usagemap/tracker@${tag.version}`,
                }
              : code(`Starter for ${selected}`, tag.code, "docs/onboarding/web-html.md")
            : null,
          wallets: {
            recommended: (r?.contracts.length ?? 0) > 0,
            snippets: site
              ? [
                  code(
                    "Stellar Wallets Kit",
                    `import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";\nattachWalletsKit(StellarWalletsKit); // site ${site.site_key}`,
                    "docs/onboarding/wallets.md",
                  ),
                ]
              : [],
          },
          otel: {
            endpoint: null,
            service_name: "my-api",
            env: {
              OTEL_SERVICE_NAME: "my-api",
              OTEL_EXPORTER_OTLP_ENDPOINT: "https://<OTLP_ENDPOINT>",
              OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20<INGEST_TOKEN>",
            },
            notes: ["Replace <INGEST_TOKEN> with an ingest token of this project."],
          },
          test_commands: [
            ...(site
              ? [
                  code(
                    "Web: is the site key live at the edge?",
                    `curl -sS -i 'https://ingest.example.invalid/v1/c' --data '{"v":1,"s":"${site.site_key}","p":"standard","tv":"1.0.0"}'`,
                    "docs/onboarding/troubleshooting.md",
                  ),
                ]
              : []),
            code(
              "API: one data point",
              "curl -sS -i 'https://<OTLP_ENDPOINT>/v1/metrics' -H 'Authorization: Bearer <INGEST_TOKEN>'",
              "docs/onboarding/api-dual-export.md",
            ),
          ],
          contracts: (r?.contracts ?? []).map((contract_id) => ({
            contract_id,
            registered: registered.has(contract_id),
          })),
          checklist: [
            { id: "project", label: "Project created", done: true, optional: false },
            { id: "website", label: "Website added", done: site !== undefined, optional: false },
            {
              id: "domain_declared",
              label: "Production domain declared",
              done: domains.length > 0,
              optional: false,
            },
            {
              id: "domain_verified",
              label: "Domain verified",
              done: domains.some((d) => d.state === "verified"),
              optional: false,
            },
            {
              id: "snippet_live",
              label: "Snippet installed: first event received",
              done: false,
              optional: false,
            },
            { id: "stellar_account", label: "Stellar account linked", done: false, optional: true },
            {
              id: "contracts",
              label: "Contracts registered",
              done: registered.size > 0,
              optional: true,
            },
            { id: "api_service", label: "API service registered", done: false, optional: true },
            {
              id: "registry_match",
              label: "Matched to your SCF registry entry",
              done: false,
              optional: r === undefined,
            },
          ],
        } satisfies ControlPlane.IntegrationKit,
      };
    },
    operatorRegistryCoverage: ({ req, q }) => {
      const s = c.session(req);
      if (!s.role) throw new MockProblem(403, "forbidden", "SCF operators only");
      const want = q.get("status");
      const text = (q.get("q") ?? "").toLowerCase();
      const totals = { projects: 0, not_enrolled: 0, enrolled: 0, verified: 0, measuring: 0 };
      const items: ControlPlane.RegistryCoverage["items"] = [];
      for (const r of FAKE_REGISTRY) {
        const tenants = [...c.tenants().values()].filter((t) =>
          domainsOf(t.tenant_id).some((d) => onDomain(d.host, r.domain)),
        );
        const verified =
          tenants.filter((t) =>
            domainsOf(t.tenant_id).some(
              (d) => d.state === "verified" && onDomain(d.host, r.domain),
            ),
          ).length + (CLAIMED_ELSEWHERE.has(r.id) ? 1 : 0);
        const enrolled = tenants.length + (CLAIMED_ELSEWHERE.has(r.id) ? 1 : 0);
        const status = verified > 0 ? "verified" : enrolled > 0 ? "enrolled" : "not_enrolled";
        totals.projects++;
        totals[status]++;
        if (want && want !== status) continue;
        if (text && !r.name.toLowerCase().includes(text) && !(r.domain ?? "").includes(text))
          continue;
        items.push({
          project: summary(r),
          status,
          tenants_enrolled: enrolled,
          tenants_verified: verified,
          tenants_measuring: 0,
          invite_url: `${c.origin(req)}/onboard?project=${r.id}`,
        });
      }
      return { status: 200, body: { measuring_days: 7, totals, items } };
    },
  };
}
