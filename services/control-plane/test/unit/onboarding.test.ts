// SPDX-License-Identifier: Apache-2.0
// Onboarding of SCF-awarded projects: registry grouping, search ranking, pre-fill, framework hints, the integration kit
// (the script tag is byte for byte getSnippet's), test commands and the picker's rate limit. Fixture rows are fake.

import { describe, expect, it } from "vitest";
import type { OperationSpec } from "../../src/http/openapi.ts";
import {
  limitsFor,
  REGISTRY_SEARCH_PER_MIN,
  type RequestContext,
} from "../../src/http/pipeline.ts";
import { lifecycleHandlers } from "../../src/lifecycle/handlers.ts";
import {
  checklist,
  frameworkSnippet,
  type KitSite,
  otelEnv,
  scriptTag,
  TOKEN_PLACEHOLDER,
  testCommands,
  trackerPin,
  walletSnippets,
} from "../../src/onboarding/kit.ts";
import {
  buildPrefill,
  frameworkHint,
  groupRows,
  KIT_FRAMEWORKS,
  likePattern,
  normaliseQuery,
  type RegistryRow,
  rankGroups,
  slugSuggestion,
  verificationOptions,
} from "../../src/onboarding/registry.ts";
import { loadTrackerRegistry } from "../../src/tracker.ts";

const tracker = loadTrackerRegistry(
  new URL("../support/fixtures/tracker", import.meta.url).pathname,
  new URL("../support/fixtures/tracker/releases.json", import.meta.url).pathname,
);

const C1 = `C${"A".repeat(55)}`;
const C2 = `C${"B".repeat(55)}`;

function row(p: Partial<RegistryRow> & { registry_project_id: string; name: string }): RegistryRow {
  return {
    source: "stellarlight",
    slug: null,
    websites: [],
    registrable_domains: [],
    github_orgs: [],
    contract_ids: [],
    scf_categories: [],
    award_round: null,
    award_stage: null,
    source_url: null,
    ...p,
  };
}

// Fake projects (clearly not real SCF projects).
const lumen = row({
  registry_project_id: "00000000-0000-7000-8000-000000000001",
  name: "Fakelumen Pay",
  slug: "fakelumen-pay",
  websites: ["https://fakelumen.example"],
  registrable_domains: ["fakelumen.example"],
  github_orgs: ["fakelumen"],
  contract_ids: [C2, C1, "not-a-contract"],
  scf_categories: ["financial_protocols"],
  award_round: 31,
  award_stage: null,
  source_url: "https://registry.example/fakelumen",
});
const lumenAtlas = row({
  registry_project_id: "00000000-0000-7000-8000-000000000002",
  source: "pg_atlas",
  name: "FakeLumen",
  websites: ["https://fakelumen.example/"],
  registrable_domains: ["fakelumen.example"],
  github_orgs: ["fakelumen", "fakelumen-labs"],
  scf_categories: ["applications", "not_a_category"],
  award_stage: "t2_testnet",
});
const tooling = row({
  registry_project_id: "00000000-0000-7000-8000-000000000003",
  name: "Demo Devtool",
  websites: ["https://demo-devtool.vercel.app"],
  registrable_domains: ["demo-devtool.vercel.app"],
  scf_categories: ["developer_tooling"],
  award_round: 29,
});

describe("registry grouping and search", () => {
  it("merges the rows of one project across sources, Stellarlight first", () => {
    const groups = groupRows([lumenAtlas, tooling, lumen]);
    expect(groups).toHaveLength(2);
    const g = groups[0];
    expect(g?.summary).toEqual({
      registry_project_id: lumen.registry_project_id,
      name: "Fakelumen Pay",
      website: "https://fakelumen.example",
      domain: "fakelumen.example",
      categories: ["applications", "financial_protocols"],
      award_round: 31,
      award_stage: "t2_testnet",
      sources: ["stellarlight", "pg_atlas"],
    });
    expect(g?.rows.map((r) => r.source)).toEqual(["stellarlight", "pg_atlas"]);
  });

  it("rows without a domain merge by name only", () => {
    const a = row({
      registry_project_id: "00000000-0000-7000-8000-00000000000a",
      name: "Nodomain",
    });
    const b = row({
      registry_project_id: "00000000-0000-7000-8000-00000000000b",
      name: " nodomain ",
      source: "pg_atlas",
    });
    expect(groupRows([a, b])).toHaveLength(1);
  });

  it("ranks exact name, then name prefix, then domain prefix", () => {
    const g = groupRows([tooling, lumen]);
    expect(rankGroups(g, "demo devtool")[0]?.summary.name).toBe("Demo Devtool");
    expect(rankGroups(g, "fake")[0]?.summary.name).toBe("Fakelumen Pay");
  });

  it("escapes LIKE wildcards and normalises the query", () => {
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
    expect(normaliseQuery("  a   b \n c ")).toBe("a b c");
    expect(normaliseQuery("x".repeat(200))).toHaveLength(80);
  });
});

describe("pre-fill", () => {
  it("pre-fills name, slug, domain and the registry's contracts as claimed", () => {
    const [g] = groupRows([lumen, lumenAtlas]);
    const p = buildPrefill(g as NonNullable<typeof g>);
    expect(p.prefill).toEqual({
      tenant_name: "Fakelumen Pay",
      slug: "fakelumen-pay",
      site_name: "fakelumen.example",
      site_domain: "fakelumen.example",
      contracts: [
        { contract_id: C1, status: "claimed" },
        { contract_id: C2, status: "claimed" },
      ],
    });
    expect(p.links.github_orgs).toEqual(["fakelumen", "fakelumen-labs"]);
    expect(p.links.source_urls).toEqual(["https://registry.example/fakelumen"]);
    expect(p.is_dapp).toBe(true);
    expect(p.framework_hint).toEqual({ framework: null, basis: null });
  });

  it("a tooling project without contracts is not a dApp; a Vercel host hints Next.js", () => {
    const [g] = groupRows([tooling]);
    const p = buildPrefill(g as NonNullable<typeof g>);
    expect(p.is_dapp).toBe(false);
    expect(p.framework_hint.framework).toBe("nextjs");
    expect(p.framework_hint.basis).toContain("vercel.app");
  });

  it("slug suggestions always pass the TenantCreate pattern", () => {
    const re = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
    for (const [slug, name] of [
      [null, "Ünïcødé  Wallet!!"],
      [null, "X"],
      [null, "-"],
      [null, "a".repeat(120)],
      ["Some_Slug--", "ignored"],
      [null, "ab-"],
    ] as const) {
      expect(slugSuggestion(slug, name)).toMatch(re);
    }
    expect(slugSuggestion(null, "Ünïcødé Wallet")).toBe("unicode-wallet");
  });

  it("framework hints come from host names only", () => {
    expect(frameworkHint(["https://x.webflow.io"]).framework).toBe("nocode");
    expect(frameworkHint(["https://x.framer.website/path"]).framework).toBe("nocode");
    expect(frameworkHint(["https://org.github.io/"]).framework).toBe("html");
    expect(frameworkHint(["https://vercel.app"]).framework).toBeNull();
    expect(frameworkHint(["not a url", "https://plain.example"]).framework).toBeNull();
  });

  it("verification options: domain proofs first, never GitHub (C-20)", () => {
    const o = verificationOptions("fakelumen.example");
    expect(o.map((x) => x.method)).toEqual([
      "dns_txt",
      "well_known",
      "meta_tag",
      "stellar_toml_account",
      "operator_approval",
    ]);
    expect(o[0]?.detail).toContain("_scf-verify.fakelumen.example");
    expect(
      verificationOptions(null).find((x) => x.method === "stellar_toml_account")?.available,
    ).toBe(false);
  });
});

const SITE: KitSite = {
  site_id: "00000000-0000-7000-8000-0000000000aa",
  name: "fakelumen.example",
  site_key: "AbCdEfGhIjKlMnOpQrStUv",
  tracker_profile: "standard",
  domains: [
    {
      domain_id: "00000000-0000-7000-8000-0000000000bb",
      host: "fakelumen.example",
      state: "unverified",
    },
  ],
};

describe("integration kit", () => {
  const pin = trackerPin(tracker.versions(), tracker.hosts, "standard");

  it("the script tag is exactly getSnippet's html tag", async () => {
    expect(pin).not.toBeNull();
    const h = lifecycleHandlers({ tracker, noticeTextUrl: undefined });
    const ctx = {
      params: { tenantId: "t", siteId: SITE.site_id },
      query: { format: "html" },
      tx: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ maybeOne: async () => ({ site_key: SITE.site_key, tracker_profile: "standard" }) }),
    } as unknown as RequestContext;
    const res = await (h.getSnippet as NonNullable<typeof h.getSnippet>)(ctx);
    expect((res.body as { code: string }).code).toBe(
      scriptTag(pin as NonNullable<typeof pin>, SITE.site_key),
    );
  });

  it("every framework gets a starter with the site key and a guide", () => {
    for (const f of KIT_FRAMEWORKS) {
      const s = frameworkSnippet(f, SITE, pin as NonNullable<typeof pin>);
      expect(s.code, f).toContain(SITE.site_key);
      expect(s.guide_path, f).toMatch(/^docs\/onboarding\/.+\.md$/);
    }
    const tag = scriptTag(pin as NonNullable<typeof pin>, SITE.site_key);
    expect(frameworkSnippet("html", SITE, pin as NonNullable<typeof pin>).code).toBe(tag);
    expect(frameworkSnippet("nocode", SITE, pin as NonNullable<typeof pin>).code).toBe(tag);
    expect(frameworkSnippet("astro", SITE, pin as NonNullable<typeof pin>).code).toContain(
      "is:inline",
    );
    expect(frameworkSnippet("nuxt", SITE, pin as NonNullable<typeof pin>).filename).toBe(
      "app/plugins/scf-analytics.client.ts",
    );
    const strict = frameworkSnippet(
      "nextjs",
      { ...SITE, tracker_profile: "strict" },
      pin as NonNullable<typeof pin>,
    );
    expect(strict.code).toContain("@usagemap/tracker/strict");
  });

  it("wallet adapters are pinned to a version that has them (1.1.0+)", () => {
    const w = walletSnippets(SITE, pin as NonNullable<typeof pin>);
    expect(w).toHaveLength(3);
    for (const s of w) expect(s.install).toBe("pnpm add --save-exact @usagemap/tracker@1.1.0");
    expect(w[0]?.code).toContain("attachWalletsKit(StellarWalletsKit)");
    expect(w[0]?.code).toContain(SITE.site_key);
  });

  it("OpenTelemetry variables keep the token a placeholder", () => {
    const o = otelEnv(undefined, "fake-api");
    expect(o.endpoint).toBeNull();
    expect(o.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer%20${TOKEN_PLACEHOLDER}`);
    expect(o.env.OTEL_SERVICE_NAME).toBe("fake-api");
    expect(o.env.OTEL_LOGS_EXPORTER).toBe("none");
    const set = otelEnv("https://otlp.example/", "fake-api");
    expect(set.endpoint).toBe("https://otlp.example");
    expect(set.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://otlp.example");
  });

  it("test commands: the web challenge with the site key and the OTLP call with a valid JSON body", () => {
    const [web, otlp] = testCommands({
      site: SITE,
      pin,
      ingestOrigin: "https://ingest-a.example-analytics.org",
      otlpEndpoint: "https://otlp.example",
      serviceName: "fake-api",
    });
    expect(web?.code).toContain("https://ingest-a.example-analytics.org/v1/c");
    expect(web?.code).toContain("Origin: https://fakelumen.example");
    const body = /--data '(.*)'$/.exec(web?.code ?? "")?.[1] as string;
    expect(JSON.parse(body)).toEqual({ v: 1, s: SITE.site_key, p: "standard", tv: "1.0.0" });
    expect(otlp?.code).toContain("https://otlp.example/v1/metrics");
    expect(otlp?.code).toContain("Bearer $SCF_OTLP_TOKEN");
    // the shared marked test (integrations/test-commands.ts): a cumulative first point, never counted as traffic;
    // what the here-document sends once $T, $S and $$ are expanded
    const raw = /<<EOF\n([\s\S]*)\nEOF$/.exec(otlp?.code ?? "")?.[1] ?? "";
    const data = raw.replace(/\$T|\$S/g, "1794498689000000000").replace(/\$\$/g, "4242");
    const parsed = JSON.parse(data);
    expect(
      parsed.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.aggregationTemporality,
    ).toBe(2);
    expect(parsed.resourceMetrics[0].resource.attributes[0].value.stringValue).toBe("fake-api");
    const dp = parsed.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
    expect(dp.bucketCounts).toHaveLength(dp.explicitBounds.length + 1);
    // no site: only the OTLP command
    expect(
      testCommands({
        site: null,
        pin: null,
        ingestOrigin: undefined,
        otlpEndpoint: undefined,
        serviceName: "x",
      }),
    ).toHaveLength(1);
  });

  it("checklist reflects the tenant's progress", () => {
    const c = checklist({
      site: {
        ...SITE,
        domains: [{ ...(SITE.domains[0] as KitSite["domains"][0]), state: "verified" }],
      },
      devOrCountedEvents: false,
      stellarAccount: false,
      footprintItems: 2,
      apiServices: 0,
      registryMatch: false,
      registryKnown: true,
    });
    const done = Object.fromEntries(c.map((x) => [x.id, x.done]));
    expect(done).toEqual({
      project: true,
      website: true,
      domain_declared: true,
      domain_verified: true,
      snippet_live: false,
      stellar_account: false,
      contracts: true,
      api_service: false,
      registry_match: false,
    });
    expect(c.find((x) => x.id === "registry_match")?.optional).toBe(false);
  });
});

describe("rate limit of the public picker", () => {
  it("adds a per-subnet search limit to searchRegistryProjects only", () => {
    const op = { operationId: "searchRegistryProjects" } as OperationSpec;
    const l = limitsFor(op, null, "203.0.113.0/24");
    expect(l).toContainEqual({
      key: "rs:203.0.113.0/24",
      limit: REGISTRY_SEARCH_PER_MIN,
      windowMs: 60_000,
    });
    const other = limitsFor({ operationId: "getPublishedThresholds" } as OperationSpec, null, "s");
    expect(other.some((x) => x.key.startsWith("rs:"))).toBe(false);
  });
});
