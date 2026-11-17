// SPDX-License-Identifier: Apache-2.0
// "Find your project" onboarding: URL state, slug retries, host clean-up and the sign-up sequence (which uses only
// the existing operations and never undoes a created project).
import { describe, expect, it } from "vitest";
import {
  cleanHost,
  type EnrolApi,
  type EnrolStep,
  enrol,
  FRAMEWORKS,
  nextSlug,
  parseCoverageSearch,
  parseKitSearch,
  parseOnboardSearch,
  progress,
} from "../../src/pages/onboard/model.ts";

const ID = "0f0f0f0f-1111-4222-8333-444455556666";
const C1 = `C${"A".repeat(55)}`;
const C2 = `C${"B".repeat(55)}`;

function problem(status: number, detail: string) {
  return Object.assign(new Error(detail), { status, problem: { title: "x", detail } });
}

function fakeApi(o: { takenSlugs?: string[]; failSite?: boolean; failDomain?: boolean } = {}) {
  const calls: string[] = [];
  const api: EnrolApi = {
    createTenant: async ({ slug }) => {
      calls.push(`tenant ${slug}`);
      if (o.takenSlugs?.includes(slug)) throw problem(409, "conflict");
      return { tenant_id: "t1" };
    },
    createSite: async (_t, { name }) => {
      calls.push(`site ${name}`);
      if (o.failSite) throw problem(403, "site limit reached at L0");
      return { site_id: "s1" };
    },
    addDomain: async (_t, _s, host) => {
      calls.push(`domain ${host}`);
      if (o.failDomain) throw problem(400, "not a valid host name");
    },
    addContract: async (_t, c) => {
      calls.push(`contract ${c}`);
      if (c === C2) throw problem(409, "this contract is already registered");
    },
  };
  return { api, calls };
}

const INPUT = {
  name: "Fakeorbit Wallet",
  slug: "fakeorbit-wallet",
  siteName: "fakeorbit.example",
  domain: "https://WWW.Fakeorbit.example/app?x=1",
  contracts: [C1, C2],
};

describe("onboarding URL state", () => {
  it("keeps only valid values", () => {
    expect(parseOnboardSearch({ project: ID.toUpperCase(), q: "fake" })).toEqual({
      project: ID,
      q: "fake",
    });
    expect(parseOnboardSearch({ project: "../etc", q: "x".repeat(81) })).toEqual({});
    expect(parseKitSearch({ site: ID, framework: "nuxt" })).toEqual({
      site: ID,
      framework: "nuxt",
    });
    expect(parseKitSearch({ site: "nope", framework: "cobol" })).toEqual({});
    expect(parseCoverageSearch({ status: "measuring", q: "orbit" })).toEqual({
      status: "measuring",
      q: "orbit",
    });
    expect(parseCoverageSearch({ status: "everything" })).toEqual({});
    expect(FRAMEWORKS.map((f) => f.id)).toEqual([
      "nextjs",
      "nuxt",
      "sveltekit",
      "astro",
      "react_spa",
      "html",
      "nocode",
      "other",
    ]);
  });

  it("slug retries and host clean-up", () => {
    expect(nextSlug("fakeorbit-wallet", 1)).toBe("fakeorbit-wallet-2");
    const long = "a".repeat(40);
    expect(nextSlug(long, 3)).toBe(`${"a".repeat(38)}-4`);
    expect(nextSlug(long, 3)).toHaveLength(40);
    expect(cleanHost(" https://WWW.Example.org:8443/path?q#f ")).toBe("www.example.org");
    expect(cleanHost("example.org.")).toBe("example.org");
  });
});

describe("sign-up sequence", () => {
  it("creates the project, website, domain and contracts in order", async () => {
    const { api, calls } = fakeApi();
    const steps: EnrolStep[] = [];
    const r = await enrol(api, INPUT, (s) => steps.push(s));
    expect(r).toEqual({ tenantId: "t1", siteId: "s1", warnings: [] });
    expect(calls).toEqual([
      "tenant fakeorbit-wallet",
      "site fakeorbit.example",
      "domain www.fakeorbit.example",
      `contract ${C1}`,
      `contract ${C2}`, // already registered (409): not a warning
    ]);
    expect(steps).toEqual(["project", "website", "domain", "contracts"]);
  });

  it("a taken slug gets a suffix; a taken slug five times fails without creating anything else", async () => {
    const a = fakeApi({ takenSlugs: ["fakeorbit-wallet", "fakeorbit-wallet-2"] });
    expect((await enrol(a.api, INPUT)).tenantId).toBe("t1");
    expect(a.calls.slice(0, 3)).toEqual([
      "tenant fakeorbit-wallet",
      "tenant fakeorbit-wallet-2",
      "tenant fakeorbit-wallet-3",
    ]);
    const all = ["", "-2", "-3", "-4", "-5"].map((x) => `fakeorbit-wallet${x}`);
    const b = fakeApi({ takenSlugs: all });
    await expect(enrol(b.api, INPUT)).rejects.toMatchObject({ status: 409 });
    expect(b.calls.every((c) => c.startsWith("tenant "))).toBe(true);
  });

  it("later failures are reported, never undone", async () => {
    const site = fakeApi({ failSite: true });
    const r = await enrol(site.api, INPUT);
    expect(r).toMatchObject({ tenantId: "t1", siteId: null });
    expect(r.warnings).toEqual(["Website: site limit reached at L0"]);
    expect(site.calls.some((c) => c.startsWith("domain"))).toBe(false);
    const dom = fakeApi({ failDomain: true });
    const r2 = await enrol(dom.api, { ...INPUT, contracts: [] });
    expect(r2.warnings).toEqual(["Domain www.fakeorbit.example: not a valid host name"]);
  });

  it("progress counts required steps only", () => {
    expect(
      progress([
        { id: "project", label: "", done: true, optional: false },
        { id: "website", label: "", done: false, optional: false },
        { id: "contracts", label: "", done: true, optional: true },
      ]),
    ).toEqual({ done: 1, total: 2 });
  });
});
