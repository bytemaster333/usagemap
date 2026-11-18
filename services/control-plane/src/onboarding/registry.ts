// SPDX-License-Identifier: Apache-2.0
// "Find your project" (onboarding of SCF-awarded projects): pure helpers over the public registry
// rows that job `registry_sync` keeps in `scf.registry_projects` (data-model §8.5; Stellarlight and PG Atlas, C-136
// vocabularies). Everything here works on public registry fields only; nothing about tenants is read or returned.
//
// One project is often listed by both sources. Rows are merged into one entry when they state the same website domain
// (or, without a domain, the same name), Stellarlight first: it states award rounds and contracts, PG Atlas states
// categories and the award stage more often. The entry's id is the first row's id; prefill reads the whole group.

export type ScfCategory =
  | "end_user_application"
  | "financial_protocols"
  | "applications"
  | "developer_tooling"
  | "infrastructure_services";
export type AwardStage = "t0_prelaunch" | "t1_mvp" | "t2_testnet" | "t3_mainnet";
export type KitFramework =
  | "nextjs"
  | "nuxt"
  | "sveltekit"
  | "astro"
  | "react_spa"
  | "html"
  | "nocode"
  | "other";

export const KIT_FRAMEWORKS: readonly KitFramework[] = [
  "nextjs",
  "nuxt",
  "sveltekit",
  "astro",
  "react_spa",
  "html",
  "nocode",
  "other",
];

/** The registry columns the onboarding reads (snake_case as selected). */
export type RegistryRow = {
  registry_project_id: string;
  source: string;
  name: string;
  slug: string | null;
  websites: string[] | null;
  registrable_domains: string[] | null;
  github_orgs: string[] | null;
  contract_ids: string[] | null;
  scf_categories: string[] | null;
  award_round: number | null;
  award_stage: string | null;
  source_url: string | null;
};

export const REGISTRY_COLUMNS = `registry_project_id::text AS registry_project_id, source, name, slug, websites,
  registrable_domains, github_orgs, contract_ids, scf_categories, award_round, award_stage, source_url`;

/**
 * Rows a sign-up may pick: SCF-awarded by the source's own statement and still listed — the public sources and rows an
 * SCF operator entered (`operator`, data-model §8.5). `scf_site` rows are not used.
 */
export const PICKABLE = `scf_awarded IS TRUE AND missing_since IS NULL AND source IN ('stellarlight', 'pg_atlas', 'operator')`;

export type PickSource = "stellarlight" | "pg_atlas" | "operator";

export interface ProjectSummary {
  registry_project_id: string;
  name: string;
  website: string | null;
  domain: string | null;
  categories: ScfCategory[];
  award_round: number | null;
  award_stage: AwardStage | null;
  sources: PickSource[];
}

export interface ProjectGroup {
  summary: ProjectSummary;
  rows: RegistryRow[];
}

const CATEGORIES = new Set<string>([
  "end_user_application",
  "financial_protocols",
  "applications",
  "developer_tooling",
  "infrastructure_services",
]);
const STAGES = new Set<string>(["t0_prelaunch", "t1_mvp", "t2_testnet", "t3_mainnet"]);
const STAGE_ORDER: AwardStage[] = ["t0_prelaunch", "t1_mvp", "t2_testnet", "t3_mainnet"];

/** Escapes `%`, `_` and `\` for an ILIKE pattern (ILIKE's default escape character is `\`). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Normalises the search text: trimmed, inner whitespace collapsed, at most 80 characters. */
export function normaliseQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").slice(0, 80);
}

const sourceRank = (s: string) => (s === "stellarlight" ? 0 : s === "pg_atlas" ? 1 : 2);

function groupKey(r: RegistryRow): string {
  const d = (r.registrable_domains ?? [])[0];
  return d ? `d:${d}` : `n:${r.name.trim().toLowerCase()}`;
}

/** Merges registry rows into one entry per project (see the header), in the order of first appearance. */
export function groupRows(rows: readonly RegistryRow[]): ProjectGroup[] {
  const groups = new Map<string, RegistryRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].map((g) => {
    const sorted = [...g].sort(
      (a, b) =>
        sourceRank(a.source) - sourceRank(b.source) ||
        (a.registry_project_id < b.registry_project_id ? -1 : 1),
    );
    return { summary: summarise(sorted), rows: sorted };
  });
}

function summarise(rows: readonly RegistryRow[]): ProjectSummary {
  const first = rows[0] as RegistryRow;
  const categories = new Set<ScfCategory>();
  const sources = new Set<PickSource>();
  let round: number | null = null;
  let stage: AwardStage | null = null;
  for (const r of rows) {
    for (const c of r.scf_categories ?? []) if (CATEGORIES.has(c)) categories.add(c as ScfCategory);
    if (r.source === "stellarlight" || r.source === "pg_atlas" || r.source === "operator")
      sources.add(r.source);
    if (typeof r.award_round === "number" && (round === null || r.award_round > round))
      round = r.award_round;
    if (r.award_stage && STAGES.has(r.award_stage)) {
      const s = r.award_stage as AwardStage;
      if (stage === null || STAGE_ORDER.indexOf(s) > STAGE_ORDER.indexOf(stage)) stage = s;
    }
  }
  const website = rows.flatMap((r) => r.websites ?? []).find(isHttpUrl) ?? null;
  return {
    registry_project_id: first.registry_project_id,
    name: first.name,
    website,
    domain: rows.flatMap((r) => r.registrable_domains ?? [])[0] ?? null,
    categories: [...categories].sort(),
    award_round: round,
    award_stage: stage,
    sources: [...sources].sort((a, b) => sourceRank(a) - sourceRank(b)),
  };
}

export function isHttpUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 2048) return false;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:";
  } catch {
    return false;
  }
}

function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Search ranking: exact name, then name prefix, then the rest (stable). */
export function rankGroups(groups: ProjectGroup[], q: string): ProjectGroup[] {
  const ql = q.toLowerCase();
  const score = (g: ProjectGroup) => {
    const n = g.summary.name.toLowerCase();
    if (n === ql) return 0;
    if (n.startsWith(ql)) return 1;
    if ((g.summary.domain ?? "").startsWith(ql)) return 2;
    return 3;
  };
  return groups
    .map((g, i) => ({ g, i, s: score(g) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.g);
}

// ------------------------------------------------------------------------------------------------ framework hint

/**
 * Hosting platforms whose default hosts say which kind of site runs there. Only what a host name states for certain
 * is used — a Vercel host is very often but not always Next.js, so the basis says "usually". Detection is offline:
 * the registry's own links are read, no request is made to the project's website (C-10: nothing is sent anywhere).
 */
const HOST_HINTS: Array<{ suffix: string; framework: KitFramework; basis: string }> = [
  {
    suffix: ".vercel.app",
    framework: "nextjs",
    basis: "host *.vercel.app (Vercel, usually Next.js)",
  },
  { suffix: ".webflow.io", framework: "nocode", basis: "host *.webflow.io (Webflow)" },
  { suffix: ".framer.website", framework: "nocode", basis: "host *.framer.website (Framer)" },
  { suffix: ".framer.app", framework: "nocode", basis: "host *.framer.app (Framer)" },
  { suffix: ".framer.ai", framework: "nocode", basis: "host *.framer.ai (Framer)" },
  { suffix: ".wordpress.com", framework: "nocode", basis: "host *.wordpress.com (WordPress)" },
  { suffix: ".wixsite.com", framework: "nocode", basis: "host *.wixsite.com (Wix)" },
  {
    suffix: ".squarespace.com",
    framework: "nocode",
    basis: "host *.squarespace.com (Squarespace)",
  },
  { suffix: ".carrd.co", framework: "nocode", basis: "host *.carrd.co (Carrd)" },
  {
    suffix: ".github.io",
    framework: "html",
    basis: "host *.github.io (GitHub Pages, a static site)",
  },
];

export interface FrameworkHint {
  framework: KitFramework | null;
  basis: string | null;
}

export function frameworkHint(websites: readonly string[]): FrameworkHint {
  for (const w of websites) {
    const h = hostOf(w);
    if (!h) continue;
    for (const x of HOST_HINTS)
      if (h.endsWith(x.suffix) && h.length > x.suffix.length)
        return { framework: x.framework, basis: x.basis };
  }
  return { framework: null, basis: null };
}

// ------------------------------------------------------------------------------------------------ prefill

const DAPP_CATEGORIES = new Set<ScfCategory>([
  "end_user_application",
  "financial_protocols",
  "applications",
]);
const CONTRACT = /^C[A-Z2-7]{55}$/;

/** Latin letters that Unicode normalisation does not decompose into an ASCII base letter. */
const LATIN_EXTRA: Record<string, string> = { ø: "o", æ: "ae", ß: "ss", đ: "d", ł: "l", þ: "th" };

/** A slug suggestion that passes TenantCreate's pattern (3–40 of [a-z0-9-], no leading or trailing hyphen). */
export function slugSuggestion(registrySlug: string | null, name: string): string {
  const base = (registrySlug ?? name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[øæßđłþ]/g, (c) => LATIN_EXTRA[c] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (base.length >= 3) return base;
  return `${base || "project"}-scf`.replace(/^-+/, "").slice(0, 40);
}

export interface Prefill {
  links: { websites: string[]; github_orgs: string[]; source_urls: string[] };
  prefill: {
    tenant_name: string;
    slug: string;
    site_name: string;
    site_domain: string | null;
    contracts: Array<{ contract_id: string; status: "claimed" }>;
  };
  framework_hint: FrameworkHint;
  is_dapp: boolean;
}

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

export function buildPrefill(group: ProjectGroup): Prefill {
  const s = group.summary;
  const websites = uniq(group.rows.flatMap((r) => r.websites ?? []).filter(isHttpUrl));
  const contracts = uniq(group.rows.flatMap((r) => r.contract_ids ?? []))
    .filter((c) => CONTRACT.test(c))
    .sort();
  const name = s.name.trim().slice(0, 100) || "SCF project";
  const firstSlug = group.rows.find((r) => r.slug)?.slug ?? null;
  return {
    links: {
      websites,
      github_orgs: uniq(group.rows.flatMap((r) => r.github_orgs ?? [])).sort(),
      source_urls: uniq(group.rows.map((r) => r.source_url).filter(isHttpUrl)),
    },
    prefill: {
      tenant_name: name,
      slug: slugSuggestion(firstSlug, name),
      site_name: s.domain ?? name,
      site_domain: s.domain,
      contracts: contracts.map((contract_id) => ({ contract_id, status: "claimed" as const })),
    },
    framework_hint: frameworkHint(websites),
    is_dapp: contracts.length > 0 || s.categories.some((c) => DAPP_CATEGORIES.has(c)),
  };
}

export interface VerificationOption {
  method: "dns_txt" | "well_known" | "meta_tag" | "stellar_toml_account" | "operator_approval";
  available: boolean;
  detail: string;
}

/**
 * The ways to prove the claim, easiest first (ADR-0015 ladder). GitHub organisation membership is not offered: the
 * registry's GitHub links are informational only and never a basis for trust (C-20).
 */
export function verificationOptions(domain: string | null): VerificationOption[] {
  const d = domain ?? "your website's domain";
  const hasDomain = domain !== null;
  return [
    {
      method: "dns_txt",
      available: true,
      detail: `Add one TXT record at _scf-verify.${d}. Works for every site, including no-code builders.`,
    },
    {
      method: "well_known",
      available: true,
      detail: `Serve a one-line file at https://${d}/.well-known/scf-verify.txt.`,
    },
    {
      method: "meta_tag",
      available: true,
      detail: "Add one <meta> tag to the <head> of the home page.",
    },
    {
      method: "stellar_toml_account",
      available: hasDomain,
      detail:
        "After the domain is verified: list your Stellar account in ACCOUNTS of the domain's stellar.toml (SEP-1) " +
        "and sign a message with it (SEP-53, or SEP-10 for hardware wallets and multisig). No fee, no transaction.",
    },
    {
      method: "operator_approval",
      available: true,
      detail:
        "An SCF operator confirms the match to the registry; automatic once the domain listed by the registry is verified.",
    },
  ];
}
