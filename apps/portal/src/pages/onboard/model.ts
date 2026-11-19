// SPDX-License-Identifier: Apache-2.0
// "Find your project" onboarding: URL state and the sign-up sequence. The sign-up uses the existing operations
// (createTenant → createSite → addDomain → addFootprintItem), so their quotas, audit rows and rate limits apply; a
// step that fails after the project exists does not undo it — the integration kit's checklist shows what is missing.

import type { ControlPlane } from "@usagemap/api-types";

export type KitFramework = ControlPlane.KitFramework;
export type CoverageStatus = ControlPlane.CoverageStatus;

export const FRAMEWORKS: ReadonlyArray<{ id: KitFramework; label: string }> = [
  { id: "nextjs", label: "Next.js" },
  { id: "nuxt", label: "Nuxt" },
  { id: "sveltekit", label: "SvelteKit" },
  { id: "astro", label: "Astro" },
  { id: "react_spa", label: "React single-page app" },
  { id: "html", label: "Plain HTML" },
  { id: "nocode", label: "WordPress, Webflow or Framer" },
  { id: "other", label: "Something else" },
];

export const CATEGORY_TEXT: Record<ControlPlane.ScfCategory, string> = {
  end_user_application: "End-user application",
  financial_protocols: "Financial protocols",
  applications: "Applications",
  developer_tooling: "Developer tooling",
  infrastructure_services: "Infrastructure services",
};

export const STAGE_TEXT: Record<ControlPlane.AwardStage, string> = {
  t0_prelaunch: "Pre-launch",
  t1_mvp: "MVP",
  t2_testnet: "Testnet",
  t3_mainnet: "Mainnet",
};

export const COVERAGE_TEXT: Record<CoverageStatus, string> = {
  not_enrolled: "Not enrolled",
  enrolled: "Enrolled",
  verified: "Verified",
  measuring: "Measuring",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isFramework = (v: unknown): v is KitFramework => FRAMEWORKS.some((f) => f.id === v);

export function parseOnboardSearch(s: Record<string, unknown>): { project?: string; q?: string } {
  const out: { project?: string; q?: string } = {};
  if (typeof s.project === "string" && UUID.test(s.project)) out.project = s.project.toLowerCase();
  if (typeof s.q === "string" && s.q.length <= 80) out.q = s.q;
  return out;
}

export const KIT_STEPS = ["prove", "framework", "snippet", "first"] as const;
export type KitStep = (typeof KIT_STEPS)[number];

export interface KitSearch {
  site?: string;
  framework?: KitFramework;
  /** onboarding step 2–5 (default: prove) */
  step?: KitStep;
  /** the app connects Stellar wallets: the snippet adds the wallet adapter */
  dapp?: boolean;
}

export function parseKitSearch(s: Record<string, unknown>): KitSearch {
  const out: KitSearch = {};
  if (typeof s.site === "string" && UUID.test(s.site)) out.site = s.site.toLowerCase();
  if (isFramework(s.framework)) out.framework = s.framework;
  if ((KIT_STEPS as readonly unknown[]).includes(s.step)) out.step = s.step as KitStep;
  if (s.dapp === true || s.dapp === "true" || s.dapp === 1) out.dapp = true;
  return out;
}

export function parseCoverageSearch(s: Record<string, unknown>): {
  status?: CoverageStatus;
  q?: string;
} {
  const out: { status?: CoverageStatus; q?: string } = {};
  if (typeof s.status === "string" && s.status in COVERAGE_TEXT)
    out.status = s.status as CoverageStatus;
  if (typeof s.q === "string" && s.q.length <= 100) out.q = s.q;
  return out;
}

/** The slug to try after `base` was taken (409): base-2, base-3, … trimmed to the 40-character limit. */
export function nextSlug(base: string, attempt: number): string {
  const suffix = `-${attempt + 1}`;
  return `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** A host as addDomain accepts it: lower case, no scheme, path, port or trailing dot. */
export function cleanHost(input: string): string {
  let h = input.trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "");
  h = h.split(/[/?#]/)[0] ?? "";
  h = h.replace(/:\d+$/, "").replace(/\.$/, "");
  return h;
}

export interface EnrolInput {
  name: string;
  slug: string;
  siteName: string;
  domain: string;
  contracts: string[];
}

export interface EnrolResult {
  tenantId: string;
  siteId: string | null;
  /** steps that failed after the project was created (shown on the kit page; nothing is undone) */
  warnings: string[];
}

export type EnrolStep = "project" | "website" | "domain" | "contracts";

/** The calls the sign-up needs; the page passes the typed client, tests pass fakes. */
export interface EnrolApi {
  createTenant(body: { slug: string; name: string }): Promise<{ tenant_id: string }>;
  createSite(tenantId: string, body: { name: string }): Promise<{ site_id: string }>;
  addDomain(tenantId: string, siteId: string, host: string): Promise<unknown>;
  addContract(tenantId: string, contractId: string): Promise<unknown>;
}

export function isConflict(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: number }).status === 409;
}

function message(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const p = (e as { problem?: { detail?: string; title?: string } }).problem;
    if (p?.detail) return p.detail;
    if (p?.title) return p.title;
  }
  return e instanceof Error ? e.message : "failed";
}

export async function enrol(
  api: EnrolApi,
  input: EnrolInput,
  onStep: (s: EnrolStep) => void = () => {},
): Promise<EnrolResult> {
  onStep("project");
  let tenantId = "";
  for (let attempt = 0; ; attempt++) {
    const slug = attempt === 0 ? input.slug : nextSlug(input.slug, attempt);
    try {
      tenantId = (await api.createTenant({ slug, name: input.name })).tenant_id;
      break;
    } catch (e) {
      // the slug is taken (slugs are global and unique): try the next suffix a few times
      if (!isConflict(e) || attempt >= 4) throw e;
    }
  }
  const warnings: string[] = [];
  let siteId: string | null = null;
  onStep("website");
  try {
    siteId = (await api.createSite(tenantId, { name: input.siteName || input.name })).site_id;
  } catch (e) {
    warnings.push(`Website: ${message(e)}`);
  }
  const host = cleanHost(input.domain);
  if (siteId && host) {
    onStep("domain");
    try {
      await api.addDomain(tenantId, siteId, host);
    } catch (e) {
      warnings.push(`Domain ${host}: ${message(e)}`);
    }
  }
  if (input.contracts.length > 0) {
    onStep("contracts");
    for (const c of input.contracts) {
      try {
        await api.addContract(tenantId, c);
      } catch (e) {
        if (!isConflict(e)) warnings.push(`Contract ${c.slice(0, 6)}…: ${message(e)}`);
      }
    }
  }
  return { tenantId, siteId, warnings };
}

export function progress(checklist: readonly ControlPlane.KitCheck[]): {
  done: number;
  total: number;
} {
  const required = checklist.filter((c) => !c.optional);
  return { done: required.filter((c) => c.done).length, total: required.length };
}
