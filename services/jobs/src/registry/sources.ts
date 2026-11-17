// SPDX-License-Identifier: Apache-2.0
// Registry sources for job `registry_sync` (data-model §8.5; references/stellar-ecosystem-registries-2026-11-12.md).
// Response shapes were checked against the live APIs on 2026-11-13:
//   Stellarlight ("Stellar Scout") GET /api/projects/search?scfAwarded=true&limit=100&offset=N
//     → {meta:{counts:{returned,total}}, projects:[{id, name, slug, scfAwarded, scfAwardedRounds, scfRoundAwards[
//        {round, awardName, amountUSD, awardType}], scfSourceUrl, scfAsOf, scfBasis, scfConfidence{score}, links{website,
//        github}, onchain{contracts[{address,label}]}|null, …}]}   (OpenAPI v1.9.x; limit capped at 100)
//   PG Atlas GET /projects?project_type=scf-project&limit=200&offset=N → {items:[{canonical_id, display_name,
//        git_owner_url, updated_at, …}], total} and GET /projects/{canonical_id} → {…, metadata:{website, scf_submissions[
//        {round,title}], total_awarded_usd, …}}   (OpenAPI 0.7.x)
// SCF cohort vocabularies (wire-formats §i.4, C-136): `scf_categories` from the source's category label (PG Atlas
// `category`, e.g. "Financial Protocols"; Stellarlight `category`/`categories` when present), `award_stage` from the
// tranche label (PG Atlas `metadata.scf_tranche_completion`, e.g. "Pre-Launch #3 - Mainnet"; Stellarlight
// `scfTrancheCompletion` when present), `award_round` = the highest numbered round of an AWARD (Stellarlight
// `scfRoundAwards`; PG Atlas lists submissions, not awards, so it never states a round). A label outside the closed
// lists, or a value the source does not state, stays empty/null — never inferred from a name or description.
// Only public project data is read; nothing about our tenants is sent (requests carry no tenant data, C-10).
// Each source returns normalised rows; `raw` keeps only the stable, provenance-relevant fields so that the content hash
// changes when the registry's statement about a project changes — not when a ranking score or an age counter moves.

import { createHash } from "node:crypto";
import {
  BudgetExhaustedError,
  PoliteClient,
  type PoliteOptions,
  RateLimitedError,
  SourceError,
} from "./polite.ts";

export { SourceError };

export type SourceName = "stellarlight" | "pg_atlas";

export interface RegistryRow {
  source: SourceName;
  sourceId: string;
  canonicalDaoip5Id: string | null;
  name: string;
  slug: string | null;
  websites: string[];
  /** Normalised website hosts (lower case, no `www.`); see `normaliseHost`. */
  registrableDomains: string[];
  githubOrgs: string[];
  contractIds: string[];
  scfAwarded: boolean | null;
  scfAwards: Array<{
    round: number | string;
    award_type: string | null;
    amount_usd: number | null;
    status: string;
  }>;
  sourceUrl: string | null;
  sourceBasis: string | null;
  sourceConfidence: number | null;
  sourceAsOf: string | null;
  /** §i.4 slugs, sorted, unique. */
  scfCategories: ScfCategory[];
  awardRound: number | null;
  awardStage: AwardStage | null;
  raw: Record<string, unknown>;
}

export type ScfCategory =
  | "end_user_application"
  | "financial_protocols"
  | "applications"
  | "developer_tooling"
  | "infrastructure_services";
export type AwardStage = "t0_prelaunch" | "t1_mvp" | "t2_testnet" | "t3_mainnet";

const CATEGORY_LABELS: Record<string, ScfCategory> = {
  "end-user application": "end_user_application",
  "financial protocols": "financial_protocols",
  applications: "applications",
  "developer tooling": "developer_tooling",
  "infrastructure & services": "infrastructure_services",
};

/** §i.4: an SCF category label (or its slug) → slug; anything else → null. */
export function categorySlug(label: unknown): ScfCategory | null {
  if (typeof label !== "string" || label.length > 100) return null;
  const l = label.trim().replace(/\s+/g, " ").toLowerCase();
  const bySlug = Object.values(CATEGORY_LABELS).find((v) => v === l);
  return CATEGORY_LABELS[l] ?? bySlug ?? null;
}

/** Category labels of a source field (a string or an array of strings) → sorted unique slugs. */
export function categorySlugs(v: unknown): ScfCategory[] {
  const xs = Array.isArray(v) ? v : [v];
  return [...new Set(xs.map(categorySlug).filter((x): x is ScfCategory => x !== null))].sort();
}

const STAGES: Record<string, AwardStage> = {
  "0:awarded": "t0_prelaunch",
  "1:mvp": "t1_mvp",
  "2:testnet": "t2_testnet",
  "3:mainnet": "t3_mainnet",
};

/** §i.4: a tranche label ("Pre-Launch #2 - Testnet", "#3 Mainnet") or a slug → award stage; anything else → null. */
export function awardStage(label: unknown): AwardStage | null {
  if (typeof label !== "string" || label.length > 100) return null;
  const l = label.trim().toLowerCase();
  if ((Object.values(STAGES) as string[]).includes(l)) return l as AwardStage;
  const m = /^(?:pre-?launch\s*)?#\s*([0-3])\s*[-–:]?\s*(awarded|mvp|testnet|mainnet)$/.exec(l);
  return m ? (STAGES[`${m[1]}:${m[2]}`] ?? null) : null;
}

/** The highest numbered round among awarded rounds (1…999), or null. */
export function latestAwardRound(rounds: unknown[]): number | null {
  const ns = rounds
    .map((r) =>
      typeof r === "number"
        ? r
        : typeof r === "string"
          ? Number(/^(?:scf\s*#?\s*)?(\d{1,3})$/i.exec(r.trim())?.[1])
          : NaN,
    )
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 999);
  return ns.length > 0 ? Math.max(...ns) : null;
}

export interface RegistrySource {
  readonly name: SourceName;
  fetchAll(signal: AbortSignal, previous: Map<string, PreviousRow>): Promise<RegistryRow[]>;
  /** What the last fetchAll did: requests made, projects whose detail was left for the next run. */
  readonly lastRun?: FetchStats;
}

export interface FetchStats {
  requests: number;
  /** Changed or new projects whose detail was not fetched this run (rate limit, budget, or an error answer for that
   * project): a known project keeps its stored row (and its old `updated_at`, so the next run asks again); a new one
   * is picked up by the next run. */
  deferred: number;
  /** The source rate-limited the run (429 / 503 that outlasted the retries, or a Retry-After beyond one run). */
  rateLimited: boolean;
}

/** What the database already holds for a source row (lets a source skip unchanged detail fetches). */
export interface PreviousRow {
  raw: Record<string, unknown>;
}

const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Host of an http(s) URL, lower case, without a leading `www.`; null for anything else. */
export function normaliseHost(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = u.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  return HOST_RE.test(h) ? h : null;
}

/** GitHub organisation or user from a github.com URL (informational only, C-20). */
export function githubOrg(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /^https?:\/\/(www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:[/?#]|$)/.exec(
    url.trim(),
  );
  return m?.[2] ? m[2].toLowerCase() : null;
}

/** RFC 8785-style canonical JSON (sorted keys) for hashing. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

const str = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const uniq = <T>(xs: (T | null)[]): T[] => [...new Set(xs.filter((x): x is T => x !== null))];

/** Upper bound of one registry answer. */
export const MAX_REGISTRY_BODY = 16 * 1024 * 1024;

/**
 * Reads a response body up to `max` bytes: refuses a larger Content-Length at once and stops reading (cancelling the
 * stream) as soon as a body without one exceeds the bound, so a huge or endless answer never sits in memory.
 */
export async function readBodyCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("registry answer too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new SourceError("registry answer too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function getJson(client: PoliteClient, url: string, signal: AbortSignal): Promise<unknown> {
  const res = await client.get(url, signal);
  const text = await readBodyCapped(res, MAX_REGISTRY_BODY);
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("registry answer is not JSON");
  }
}

// ---------------------------------------------------------------------------------------------- Stellarlight

export class StellarlightSource implements RegistrySource {
  readonly name = "stellarlight" as const;
  readonly #base: string;
  readonly #pageSize: number;
  readonly #polite: PoliteOptions;
  lastRun?: FetchStats;

  /** `polite`: pacing of this source's requests (polite.ts); defaults to 250 ms between pages. */
  constructor(
    baseUrl: string,
    opts: { pageSize?: number; timeoutMs?: number; polite?: PoliteOptions } = {},
  ) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#pageSize = opts.pageSize ?? 100;
    this.#polite = { minIntervalMs: 250, timeoutMs: opts.timeoutMs ?? 30_000, ...opts.polite };
  }

  async fetchAll(signal: AbortSignal): Promise<RegistryRow[]> {
    const client = new PoliteClient(this.#polite);
    this.lastRun = { requests: 0, deferred: 0, rateLimited: false };
    try {
      return await this.#fetchAll(client, signal);
    } finally {
      this.lastRun = { ...this.lastRun, requests: client.requests };
    }
  }

  async #fetchAll(client: PoliteClient, signal: AbortSignal): Promise<RegistryRow[]> {
    const rows: RegistryRow[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; ) {
      const body = (await getJson(
        client,
        `${this.#base}/api/projects/search?scfAwarded=true&limit=${this.#pageSize}&offset=${offset}`,
        signal,
      )) as {
        meta?: { counts?: { returned?: unknown; total?: unknown }; partial?: unknown };
        projects?: unknown;
      };
      if (!Array.isArray(body.projects)) throw new SourceError("stellarlight: no projects array");
      if (body.meta?.partial === true) throw new SourceError("stellarlight: partial answer");
      const t = num(body.meta?.counts?.total);
      if (t === null) throw new SourceError("stellarlight: no total");
      total = t;
      for (const p of body.projects) {
        const r = stellarlightRow(p);
        if (r) rows.push(r);
      }
      if (body.projects.length === 0) break;
      offset += body.projects.length;
      if (offset > 100_000) throw new SourceError("stellarlight: too many rows");
    }
    return rows;
  }
}

export function stellarlightRow(p: unknown): RegistryRow | null {
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  const id = str(o.id) ?? str(o.slug);
  const name = str(o.name);
  if (!id || !name) return null;
  const links = (o.links ?? {}) as Record<string, unknown>;
  const onchain = (o.onchain ?? {}) as { contracts?: unknown };
  const contracts = Array.isArray(onchain.contracts)
    ? uniq(
        onchain.contracts.map((c) => {
          const a = (c as { address?: unknown })?.address;
          return typeof a === "string" && CONTRACT_RE.test(a) ? a : null;
        }),
      )
    : [];
  const website = str(links.website, 2048);
  const awards = Array.isArray(o.scfRoundAwards)
    ? o.scfRoundAwards.flatMap((a) => {
        const x = a as Record<string, unknown>;
        const round = num(x.round) ?? str(x.round, 40);
        if (round === null) return [];
        return [
          {
            round,
            award_type: str(x.awardType, 100),
            amount_usd: num(x.amountUSD),
            status: "Awarded",
          },
        ];
      })
    : [];
  const conf = (o.scfConfidence ?? {}) as Record<string, unknown>;
  const score = num(conf.score);
  const categoryField = o.categories ?? o.category ?? null;
  const trancheLabel = str(o.scfTrancheCompletion, 100);
  const raw = {
    id,
    name,
    slug: str(o.slug),
    scfAwarded: typeof o.scfAwarded === "boolean" ? o.scfAwarded : null,
    scfAwardedRounds: Array.isArray(o.scfAwardedRounds)
      ? o.scfAwardedRounds.filter((r) => typeof r === "number")
      : [],
    scfRoundAwards: awards,
    scfTotalAwardedUSD: num(o.scfTotalAwardedUSD),
    scfBasis: str(o.scfBasis, 64),
    scfAsOf: str(o.scfAsOf, 32),
    scfSourceUrl: str(o.scfSourceUrl, 2048),
    website,
    github: str(links.github, 2048),
    contracts,
    status: str(o.status, 64),
    categories: categorySlugs(categoryField),
    scfTrancheCompletion: trancheLabel,
  };
  return {
    source: "stellarlight",
    sourceId: id,
    canonicalDaoip5Id: null,
    name,
    slug: raw.slug,
    websites: website ? [website] : [],
    registrableDomains: uniq([normaliseHost(website)]),
    githubOrgs: uniq([githubOrg(links.github)]),
    contractIds: contracts,
    scfAwarded: raw.scfAwarded,
    scfAwards: awards,
    sourceUrl: raw.scfSourceUrl,
    sourceBasis: raw.scfBasis,
    sourceConfidence:
      score !== null && score >= 0 && score <= 1 ? Math.round(score * 1000) / 1000 : null,
    sourceAsOf: /^\d{4}-\d{2}-\d{2}$/.test(raw.scfAsOf ?? "") ? raw.scfAsOf : null,
    scfCategories: raw.categories,
    awardRound: latestAwardRound(awards.map((a) => a.round)),
    awardStage: awardStage(trancheLabel),
    raw,
  };
}

// ---------------------------------------------------------------------------------------------- PG Atlas

export class PgAtlasSource implements RegistrySource {
  readonly name = "pg_atlas" as const;
  readonly #base: string;
  readonly #pageSize: number;
  readonly #polite: PoliteOptions;
  lastRun?: FetchStats;

  /**
   * `polite`: pacing of this source's requests (polite.ts). Defaults: one request per second, at most 400 requests per
   * run (the list plus ~395 project details ≈ 7 minutes); what is left over is fetched by the next runs.
   */
  constructor(
    baseUrl: string,
    opts: { pageSize?: number; timeoutMs?: number; polite?: PoliteOptions } = {},
  ) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#pageSize = opts.pageSize ?? 200;
    this.#polite = {
      minIntervalMs: 1000,
      maxRequests: 400,
      timeoutMs: opts.timeoutMs ?? 30_000,
      ...opts.polite,
    };
  }

  async fetchAll(signal: AbortSignal, previous: Map<string, PreviousRow>): Promise<RegistryRow[]> {
    const client = new PoliteClient(this.#polite);
    this.lastRun = { requests: 0, deferred: 0, rateLimited: false };
    try {
      return await this.#fetchAll(client, signal, previous);
    } finally {
      this.lastRun = { ...this.lastRun, requests: client.requests };
    }
  }

  async #fetchAll(
    client: PoliteClient,
    signal: AbortSignal,
    previous: Map<string, PreviousRow>,
  ): Promise<RegistryRow[]> {
    const stats = this.lastRun as FetchStats;
    const summaries: Array<Record<string, unknown>> = [];
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; ) {
      // The list must be complete: a failure here fails the source for this run (stored rows stay as they are).
      const body = (await getJson(
        client,
        `${this.#base}/projects?project_type=scf-project&limit=${this.#pageSize}&offset=${offset}`,
        signal,
      )) as { items?: unknown; total?: unknown };
      if (!Array.isArray(body.items)) throw new SourceError("pg_atlas: no items array");
      const t = num(body.total);
      if (t === null) throw new SourceError("pg_atlas: no total");
      total = t;
      for (const it of body.items)
        if (typeof it === "object" && it !== null) summaries.push(it as Record<string, unknown>);
      if (body.items.length === 0) break;
      offset += body.items.length;
      if (offset > 100_000) throw new SourceError("pg_atlas: too many rows");
    }
    const rows: RegistryRow[] = [];
    // Once the source rate-limits (or the run's budget is spent) no further detail is requested in this run.
    let stopped = false;
    for (const s of summaries) {
      const id = str(s.canonical_id);
      if (!id || !/^daoip-5:[a-z0-9_:.-]{1,180}$/i.test(id)) continue;
      // The list carries `updated_at`; the detail (website, awards) is fetched only when it changed.
      const prev = previous.get(id);
      let detail: Record<string, unknown>;
      // Rows stored before C-136 lack the tranche label: they are fetched once more.
      const prevMeta = prev?.raw.metadata as Record<string, unknown> | undefined;
      if (
        prev &&
        prev.raw.updated_at === s.updated_at &&
        typeof prevMeta === "object" &&
        prevMeta !== null &&
        "scf_tranche_completion" in prevMeta
      ) {
        detail = {
          ...prev.raw,
          display_name: s.display_name ?? prev.raw.display_name,
          category: "category" in s ? s.category : prev.raw.category,
          updated_at: s.updated_at,
        };
      } else {
        let fetched: Record<string, unknown> | null = null;
        if (!stopped) {
          try {
            fetched = (await getJson(
              client,
              `${this.#base}/projects/${encodeURIComponent(id)}`,
              signal,
            )) as Record<string, unknown>;
          } catch (err) {
            if (signal.aborted) throw err;
            if (err instanceof RateLimitedError || err instanceof BudgetExhaustedError) {
              stopped = true;
              stats.rateLimited ||= err instanceof RateLimitedError && err.status === 429;
            } else if (!(err instanceof SourceError)) {
              stopped = true; // network failure that outlasted the retries: the source is unreachable now
            }
            // A SourceError of this one project (e.g. 404, not JSON): only this project waits.
          }
        }
        if (!fetched || typeof fetched !== "object") {
          // Deferred: a known project keeps its stored statement unchanged (its old updated_at makes the next run ask
          // again; it is not marked missing); a new one is simply picked up by the next run.
          stats.deferred += 1;
          if (!prev) continue;
          detail = prev.raw;
        } else {
          detail = fetched;
        }
      }
      const r = pgAtlasRow(detail);
      if (r) rows.push(r);
    }
    return rows;
  }
}

export function pgAtlasRow(p: Record<string, unknown>): RegistryRow | null {
  const id = str(p.canonical_id);
  const name = str(p.display_name);
  if (!id || !name) return null;
  const md = (p.metadata ?? {}) as Record<string, unknown>;
  const website = str(md.website, 2048);
  const awarded = num(md.total_awarded_usd);
  const subs = Array.isArray(md.scf_submissions)
    ? md.scf_submissions.flatMap((x) => {
        // Detail answers carry {round, title}; our stored raw keeps the round only (re-read when nothing changed).
        const r =
          typeof x === "string" ? str(x, 40) : str((x as Record<string, unknown>)?.round, 40);
        return r ? [r] : [];
      })
    : [];
  const trancheLabel = str(md.scf_tranche_completion, 100);
  const metadata = {
    website,
    total_awarded_usd: awarded,
    scf_submissions: subs,
    scf_tranche_completion: trancheLabel,
  };
  const category = str(p.category, 100);
  const raw = {
    canonical_id: id,
    display_name: name,
    git_owner_url: str(p.git_owner_url, 2048),
    updated_at: p.updated_at ?? null,
    category,
    metadata,
  };
  return {
    source: "pg_atlas",
    sourceId: id,
    canonicalDaoip5Id: id,
    name,
    slug: null,
    websites: website ? [website] : [],
    registrableDomains: uniq([normaliseHost(website)]),
    githubOrgs: uniq([githubOrg(p.git_owner_url)]),
    contractIds: [],
    // PG Atlas lists every submitted round, awarded or not; only the awarded total says "awarded" (research §3.3).
    scfAwarded: awarded === null ? null : awarded > 0,
    // Submission rounds are not awards: kept with status "Submitted" for provenance, never counted as awards.
    scfAwards: subs.map((round) => ({
      round,
      award_type: null,
      amount_usd: null,
      status: "Submitted",
    })),
    sourceUrl: null,
    sourceBasis: "pg_atlas_total_awarded_usd",
    sourceConfidence: null,
    sourceAsOf:
      typeof p.updated_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(p.updated_at)
        ? p.updated_at.slice(0, 10)
        : null,
    scfCategories: categorySlugs(category),
    // PG Atlas states submissions, not which round was awarded: no round (never inferred).
    awardRound: null,
    awardStage: awardStage(trancheLabel),
    raw,
  };
}
