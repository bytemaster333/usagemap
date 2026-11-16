// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, sign } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../../src/auth/github.ts";
import {
  isComplete,
  parseCookies,
  recentAuthValidUntil,
  type Session,
  stepUpValidUntil,
} from "../../src/auth/sessions.ts";
import {
  decodeAccountId,
  encodeAccountId,
  NO_FEE_NOTICE,
  sep53Digest,
  sep53Message,
  verifySep53,
} from "../../src/auth/stellar.ts";
import { isLoopbackHost, loadConfig } from "../../src/config.ts";
import { normaliseHost } from "../../src/domain/sites.ts";
import { NODE_NAME_RE } from "../../src/edge/internal.ts";
import { OpenApi } from "../../src/http/openapi.ts";
import { DEFAULT_CREATE_LIMIT_PER_HOUR, limitsFor } from "../../src/http/pipeline.ts";
import { ApiError, problemBody } from "../../src/http/problem.ts";
import { RateLimiter, subnetOf } from "../../src/http/ratelimit.ts";
import {
  loadTrackerRegistry,
  selectTrackerVersion,
  type TrackerVersionView,
  trackerOutdated,
  trackerVersionSeen,
} from "../../src/tracker.ts";
import {
  derivedUuid,
  newInvitationCode,
  newOpaqueToken,
  newSiteKey,
  uuidv7,
} from "../../src/util/ids.ts";
import { footprintChallengeMessage } from "../../src/verify/footprint.ts";
import { linkMessage } from "../../src/verify/ladder.ts";

const src = join(import.meta.dirname, "..", "..", "src");

describe("identifiers (wire-formats §k)", () => {
  it("generates UUIDv7, site keys, invitation codes and opaque tokens in the documented shapes", () => {
    const u = uuidv7(Date.UTC(2026, 10, 12));
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(u.replace(/-/g, "").slice(0, 12), 16)).toBe(Date.UTC(2026, 10, 12));
    expect(newSiteKey()).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(newInvitationCode()).toMatch(/^scfi_[0-9A-Za-z]{22}$/);
    expect(newOpaqueToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 200 }, newSiteKey)).size).toBe(200);
    expect(derivedUuid("a", "b")).toBe(derivedUuid("a", "b"));
    expect(derivedUuid("a", "b")).not.toBe(derivedUuid("ab", ""));
  });
});

describe("Stellar SEP-23 StrKey and SEP-53", () => {
  it("decodes the all-zero account and rejects a bad checksum", () => {
    const zero = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    expect(decodeAccountId(zero).equals(Buffer.alloc(32))).toBe(true);
    expect(encodeAccountId(Buffer.alloc(32))).toBe(zero);
    expect(() =>
      decodeAccountId("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHG"),
    ).toThrow(/checksum/);
    expect(() =>
      decodeAccountId("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
    ).toThrow();
  });

  it("tells the signer that signing sends no transaction and costs no fee (every SEP-53 message)", () => {
    expect(NO_FEE_NOTICE).toBe("Signing this message does not send a transaction or cost a fee.");
    const common = {
      domain: "portal.test",
      account: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      network: "public",
      nonce: "n",
      issuedAt: new Date(0),
      expiresAt: new Date(1),
    };
    const messages = [
      sep53Message(common),
      linkMessage({ ...common, tenantId: "t", slug: "s" }),
      footprintChallengeMessage({ ...common, tenantId: "t", slug: "s" }),
    ];
    for (const m of messages) {
      const lines = m.split("\n");
      // directly after the Purpose line, so wallets that truncate long messages still show it
      expect(lines[lines.findIndex((l) => l.startsWith("Purpose: ")) + 1]).toBe(NO_FEE_NOTICE);
    }
  });

  it("verifies a signature over SHA-256('Stellar Signed Message:\\n' + message) only", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const account = encodeAccountId(
      Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"),
    );
    const msg = sep53Message({
      domain: "portal.test",
      account,
      network: "public",
      nonce: "n",
      issuedAt: new Date(0),
      expiresAt: new Date(1),
    });
    expect(msg.split("\n")[1]).toBe(account);
    const good = sign(null, sep53Digest(msg), privateKey).toString("base64");
    expect(verifySep53(account, msg, good)).toBe(true);
    expect(verifySep53(account, `${msg} `, good)).toBe(false);
    const raw = sign(null, Buffer.from(msg), privateKey).toString("base64"); // unprefixed: must fail
    expect(verifySep53(account, msg, raw)).toBe(false);
    expect(verifySep53(account, msg, "AAAA")).toBe(false);
  });
});

describe("sessions", () => {
  const base: Session = {
    hash: Buffer.alloc(32),
    userId: "u",
    kind: "tenant_user",
    firstFactor: "github",
    passkeyVerifiedAt: null,
    stepUpAt: null,
    reauthenticatedAt: new Date(),
    reauthMethod: "github",
    createdAt: new Date(),
    lastSeenAt: new Date(),
    idleExpiresAt: new Date(),
    absoluteExpiresAt: new Date(),
    platformRole: null,
    passkeyCount: 0,
  };
  it("operators are partial until a passkey assertion (C-09)", () => {
    expect(isComplete(base)).toBe(true);
    const op = { ...base, kind: "operator" as const, platformRole: "operator" as const };
    expect(isComplete(op)).toBe(false);
    expect(isComplete({ ...op, passkeyVerifiedAt: new Date() })).toBe(true);
  });
  it("step-up and recent authentication last 10 minutes; with a passkey only a passkey counts (C-87)", () => {
    const t = new Date("2026-11-12T10:00:00Z");
    expect(
      stepUpValidUntil({ ...base, platformRole: "operator", stepUpAt: t })?.toISOString(),
    ).toBe("2026-11-12T10:10:00.000Z");
    expect(stepUpValidUntil({ ...base, stepUpAt: t })).toBeNull();
    expect(recentAuthValidUntil({ ...base, reauthenticatedAt: t })?.toISOString()).toBe(
      "2026-11-12T10:10:00.000Z",
    );
    expect(recentAuthValidUntil({ ...base, reauthenticatedAt: t, passkeyCount: 1 })).toBeNull();
    expect(
      recentAuthValidUntil({
        ...base,
        reauthenticatedAt: t,
        passkeyCount: 1,
        reauthMethod: "passkey",
      }),
    ).not.toBeNull();
  });
  it("completeness and step-up follow the CURRENT platform role, not the kind frozen at creation (C-114)", () => {
    const t = new Date("2026-11-12T10:00:00Z");
    // A member promoted to SCF operator after signing in is partial until a passkey assertion.
    expect(isComplete({ ...base, platformRole: "operator" })).toBe(false);
    expect(isComplete({ ...base, platformRole: "operator", passkeyVerifiedAt: t })).toBe(true);
    // An operator whose role was revoked is an ordinary member again.
    expect(isComplete({ ...base, kind: "operator", platformRole: null })).toBe(true);
    expect(stepUpValidUntil({ ...base, platformRole: "operator", stepUpAt: t })).not.toBeNull();
    expect(stepUpValidUntil({ ...base, kind: "operator", stepUpAt: t })).toBeNull();
  });
  it("for an SCF operator with a passkey only a step-up counts as recent authentication (C-114)", () => {
    const t = new Date("2026-11-12T10:00:00Z");
    const op = { ...base, kind: "operator" as const, platformRole: "operator" as const };
    expect(
      recentAuthValidUntil({
        ...op,
        passkeyCount: 1,
        reauthMethod: "passkey",
        reauthenticatedAt: t,
      }),
    ).toBeNull();
    expect(
      recentAuthValidUntil({
        ...op,
        passkeyCount: 1,
        reauthMethod: "passkey",
        stepUpAt: t,
      })?.toISOString(),
    ).toBe("2026-11-12T10:10:00.000Z");
    // First enrolment: no passkey yet, the first factor counts for 10 minutes.
    expect(recentAuthValidUntil({ ...op, reauthenticatedAt: t })?.toISOString()).toBe(
      "2026-11-12T10:10:00.000Z",
    );
  });
  it("parses cookies defensively", () => {
    const m = parseCookies("a=1; __Host-scf_session=abc; junk; a=2");
    expect(m.get("a")).toBe("1");
    expect(m.get("__Host-scf_session")).toBe("abc");
    expect(parseCookies(undefined).size).toBe(0);
  });
});

describe("rate limits", () => {
  it("counts per window and reports the most restrictive limit", () => {
    let now = 0;
    const rl = new RateLimiter(() => now);
    const l = [{ key: "a", limit: 2, windowMs: 1000 }];
    expect(rl.hit(l)).toMatchObject({ allowed: true, remaining: 1 });
    expect(rl.hit(l)).toMatchObject({ allowed: true, remaining: 0 });
    expect(rl.hit(l)).toMatchObject({ allowed: false, remaining: 0, reset: 1 });
    now = 1001;
    expect(rl.hit(l).allowed).toBe(true);
    const v = rl.hit([
      { key: "b", limit: 100, windowMs: 1000 },
      { key: "c", limit: 1, windowMs: 1000 },
    ]);
    expect(v.limit).toBe(1);
  });
  it("limits creating calls per subnet per hour by the configured figure (C-64)", () => {
    const api = new OpenApi();
    const create = api.get("createTenant");
    const read = api.get("authGetSession");
    const cs = (ls: { key: string; limit: number; windowMs: number }[]) =>
      ls.find((l) => l.key.startsWith("cs:"));
    expect(DEFAULT_CREATE_LIMIT_PER_HOUR).toBe(60);
    expect(cs(limitsFor(create, null, "203.0.113.0/24"))).toEqual({
      key: "cs:203.0.113.0/24",
      limit: 60,
      windowMs: 3_600_000,
    });
    expect(cs(limitsFor(create, null, "203.0.113.0/24", 5000))?.limit).toBe(5000);
    expect(cs(limitsFor(read, null, "203.0.113.0/24", 5000))).toBeUndefined();
    // the 61st creating call from one subnet within the hour is refused at the default
    const rl = new RateLimiter(() => 0);
    const verdicts = Array.from({ length: 61 }, () =>
      rl.hit(limitsFor(create, null, "198.51.100.0/24")),
    );
    expect(verdicts[59]?.allowed).toBe(true);
    expect(verdicts[60]?.allowed).toBe(false);
  });
  it("truncates client addresses to /24 and /48 in memory", () => {
    expect(subnetOf("203.0.113.77")).toBe("203.0.113.0/24");
    expect(subnetOf("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
    expect(subnetOf("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(subnetOf("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(subnetOf(undefined)).toBe("unknown");
  });
});

describe("problems", () => {
  it("follow RFC 9457 with the closed code catalogue, including not_implemented (501)", () => {
    expect(problemBody(new ApiError("not_found"), "https://p/problems/", "r1")).toEqual({
      type: "https://p/problems/not_found",
      title: "Not found",
      status: 404,
      code: "not_found",
      request_id: "r1",
    });
    const nb = problemBody(new ApiError("not_implemented", "x"), "https://p/problems/", "r");
    expect(nb.status).toBe(501);
    expect(nb.code).toBe("not_implemented");
  });
});

describe("OpenAPI-driven routing", () => {
  const oa = new OpenApi();
  it("loads every operation with its authorisation metadata", () => {
    expect(oa.operations.length).toBeGreaterThanOrEqual(130);
    const op = oa.get("removeOwnTenant");
    expect(op).toMatchObject({
      roles: ["tenant:owner"],
      recentAuth: true,
      csrf: true,
      audited: true,
    });
    expect(oa.get("operatorCreateApiKey").stepUp).toBe(true);
    expect(oa.get("edgeGetSnapshot").internal).toBe(true);
    for (const o of oa.operations) expect(o.roles.length).toBeGreaterThan(0);
  });
  it("validates request bodies against the contract (closed schemas)", () => {
    const v = oa.get("createTenant").validateBody;
    expect(v?.({ slug: "ok-slug", name: "n" })).toBe(true);
    expect(v?.({ slug: "ok-slug", name: "n", tenant_id: "x" })).toBe(false);
    expect(v?.({ slug: "-bad", name: "n" })).toBe(false);
  });
});

describe("host normalisation", () => {
  it("stores lower-case A-labels and refuses anything that is not a host", () => {
    expect(normaliseHost("Example.ORG")).toBe("example.org");
    expect(normaliseHost("bücher.example.")).toBe("xn--bcher-kva.example");
    expect(normaliseHost("example.org:443")).toBeNull();
    expect(normaliseHost("https://example.org")).toBeNull();
    expect(normaliseHost("localhost")).toBeNull();
    expect(normaliseHost("a b.example")).toBeNull();
  });
});

describe("configuration", () => {
  it("requires the portal origin and the database URL, and reads secrets from *_FILE", () => {
    expect(() => loadConfig({})).toThrow(/SCF_PORTAL_ORIGIN/);
    expect(() =>
      loadConfig({ SCF_PORTAL_ORIGIN: "https://p.test/path", SCF_DATABASE_URL: "x" }),
    ).toThrow(/origin/);
    const c = loadConfig({
      SCF_PORTAL_ORIGIN: "https://p.test",
      SCF_DATABASE_URL: "postgres://x",
      SCF_INTERNAL_LISTEN_HOST: "127.0.0.1",
    });
    expect(c.publicPort).toBe(8080);
    expect(c.internalPort).toBe(8081);
    expect(c.github).toBeUndefined();
    expect(c.webauthn.rpId).toBe("p.test");
    expect(c.edge.nodeHeader).toBe("x-scf-edge-node");
    expect(c.stellar.network).toBe("public");
    expect(c.trustProxy).toBe(false);
    expect(c.createLimitPerHour).toBe(60);
  });

  it("reads SCF_CREATE_LIMIT_PER_HOUR (a positive integer)", () => {
    const base = {
      SCF_PORTAL_ORIGIN: "https://p.test",
      SCF_DATABASE_URL: "postgres://x",
      SCF_INTERNAL_LISTEN_HOST: "127.0.0.1",
    };
    expect(loadConfig({ ...base, SCF_CREATE_LIMIT_PER_HOUR: "5000" }).createLimitPerHour).toBe(
      5000,
    );
    expect(() => loadConfig({ ...base, SCF_CREATE_LIMIT_PER_HOUR: "0" })).toThrow(
      /SCF_CREATE_LIMIT_PER_HOUR/,
    );
    expect(() => loadConfig({ ...base, SCF_CREATE_LIMIT_PER_HOUR: "lots" })).toThrow(
      /SCF_CREATE_LIMIT_PER_HOUR/,
    );
  });

  const minimal = { SCF_PORTAL_ORIGIN: "https://p.test", SCF_DATABASE_URL: "postgres://x" };
  const tls = {
    SCF_INTERNAL_TLS_CERT: "cert",
    SCF_INTERNAL_TLS_KEY: "key",
    SCF_INTERNAL_TLS_CA: "ca",
  };

  it("refuses a plain-HTTP internal listener on a non-loopback address; mTLS is the default (C-114)", () => {
    expect(() => loadConfig(minimal)).toThrow(/SCF_INTERNAL_TLS_CERT/);
    expect(() => loadConfig({ ...minimal, SCF_LISTEN_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => loadConfig({ ...minimal, SCF_INTERNAL_LISTEN_HOST: "10.0.0.5" })).toThrow(
      /loopback/,
    );
    expect(() => loadConfig({ ...minimal, SCF_INTERNAL_LISTEN_HOST: "::" })).toThrow(/loopback/);
    for (const host of ["127.0.0.1", "127.9.9.9", "::1", "localhost"]) {
      expect(loadConfig({ ...minimal, SCF_INTERNAL_LISTEN_HOST: host }).edge.tls).toBeUndefined();
    }
    // The public listener's host does not loosen the internal one.
    expect(() =>
      loadConfig({ ...minimal, SCF_LISTEN_HOST: "127.0.0.1", SCF_INTERNAL_LISTEN_HOST: "0.0.0.0" }),
    ).toThrow(/loopback/);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("with TLS requires the allowed client CNs, which are node names (C-60, C-114)", () => {
    expect(() => loadConfig({ ...minimal, ...tls })).toThrow(/SCF_INTERNAL_ALLOWED_CLIENTS/);
    expect(() =>
      loadConfig({ ...minimal, ...tls, SCF_INTERNAL_ALLOWED_CLIENTS: "Core_A" }),
    ).toThrow(/SCF_INTERNAL_ALLOWED_CLIENTS/);
    const c = loadConfig({ ...minimal, ...tls, SCF_INTERNAL_ALLOWED_CLIENTS: "core-a, core-b" });
    expect(c.edge.tls).toEqual({
      cert: "cert",
      key: "key",
      ca: "ca",
      allowedClients: ["core-a", "core-b"],
    });
    expect(c.edge.internalHost).toBe("0.0.0.0");
    expect(() => loadConfig({ ...minimal, SCF_INTERNAL_TLS_CERT: "cert" })).toThrow(
      /SCF_INTERNAL_TLS_KEY/,
    );
  });

  it("takes the Stellar network from configuration only (C-114)", () => {
    const base = { ...minimal, SCF_INTERNAL_LISTEN_HOST: "127.0.0.1" };
    expect(loadConfig({ ...base, SCF_STELLAR_NETWORK: "testnet" }).stellar.network).toBe("testnet");
    expect(() => loadConfig({ ...base, SCF_STELLAR_NETWORK: "futurenet" })).toThrow(
      /SCF_STELLAR_NETWORK/,
    );
    expect(loadConfig(base).stellar.horizonUrl).toBe("https://horizon.stellar.org");
    expect(loadConfig({ ...base, SCF_STELLAR_NETWORK: "testnet" }).stellar.horizonUrl).toBe(
      "https://horizon-testnet.stellar.org",
    );
  });

  it("reads SCF_TRUST_PROXY as true/false or a list of proxy addresses (per-subnet auth limits)", () => {
    const base = { ...minimal, SCF_INTERNAL_LISTEN_HOST: "127.0.0.1" };
    expect(loadConfig({ ...base, SCF_TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, SCF_TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, SCF_TRUST_PROXY: "10.0.0.0/8, 172.16.0.0/12" }).trustProxy).toBe(
      "10.0.0.0/8,172.16.0.0/12",
    );
    expect(() => loadConfig({ ...base, SCF_TRUST_PROXY: "portal" })).toThrow(/SCF_TRUST_PROXY/);
  });
});

describe("return_to (C-114)", () => {
  const origin = "https://portal.test";
  it("accepts same-origin paths only: no control characters, no backslashes, no scheme-relative", () => {
    expect(safeReturnTo("/dashboard", origin)).toBe("/dashboard");
    expect(safeReturnTo("/t/abc?tab=sites#x", origin)).toBe("/t/abc?tab=sites#x");
    expect(safeReturnTo("/", origin)).toBe("/");
    for (const bad of [
      "/\t/evil.example",
      "/\u0009/evil.example",
      "//evil.example",
      "/\\evil.example",
      "/a\\b",
      " /x",
      "/x\u0000",
      "/x\u007f",
      "/x\r\nSet-Cookie: a=b",
      "https://evil.example/",
      "evil",
      "",
      42,
      undefined,
    ]) {
      expect(safeReturnTo(bad, origin), JSON.stringify(bad)).toBe("/");
    }
  });
  it("the contract pattern refuses the same values", () => {
    const v = new OpenApi().get("authGithubStart").validateQuery;
    expect(v?.({ return_to: "/dashboard" })).toBe(true);
    expect(v?.({ return_to: "/\t/evil.example" })).toBe(false);
    expect(v?.({ return_to: "//evil.example" })).toBe(false);
    expect(v?.({ return_to: "/a\\b" })).toBe(false);
  });
});

describe("node names (C-114)", () => {
  it("one pattern everywhere: ^[a-z0-9][a-z0-9-]{1,31}$", () => {
    expect(NODE_NAME_RE.source).toBe("^[a-z0-9][a-z0-9-]{1,31}$");
    for (const ok of ["ab", "edge-a1", "core-b", "a".repeat(32), "0-"])
      expect(NODE_NAME_RE.test(ok)).toBe(true);
    for (const bad of ["a", "-ab", "a".repeat(33), "Edge-a1", "edge_a1", "edge.a1"])
      expect(NODE_NAME_RE.test(bad), bad).toBe(false);
  });
});

describe("tracker registry", () => {
  it("publishes versions present in both the releases file and the manifests, newest first", () => {
    const dir = join(import.meta.dirname, "..", "support", "fixtures", "tracker");
    const v = loadTrackerRegistry(dir, join(dir, "releases.json")).versions();
    expect(v).toHaveLength(1);
    expect(v[0]?.files.map((f) => f.url)).toEqual([
      "/lib/1.0.0/standard.js",
      "/lib/1.0.0/strict.js",
    ]);
    expect(v[0]?.files[0]?.integrity).toMatch(/^sha384-/);
    expect(loadTrackerRegistry(undefined, undefined).versions()).toEqual([]);
  });

  it("serves two released versions side by side; the snippet pins either, the default is the newest (tracker.intentional-upgrade)", () => {
    const fixtures = join(import.meta.dirname, "..", "support", "fixtures", "tracker");
    const dir = mkdtempSync(join(tmpdir(), "scf-cp-tracker-"));
    try {
      const m1 = JSON.parse(readFileSync(join(fixtures, "1.0.0", "manifest.json"), "utf8"));
      // A second release: same layout, its own bytes and therefore its own SRI hashes.
      const m2 = {
        ...m1,
        version: "1.1.0",
        files: m1.files.map((f: { integrity: string }, i: number) => ({
          ...f,
          integrity: `sha384-${Buffer.alloc(48, i + 1).toString("base64")}`,
        })),
      };
      for (const m of [m1, m2]) {
        mkdirSync(join(dir, m.version));
        writeFileSync(join(dir, m.version, "manifest.json"), JSON.stringify(m));
      }
      const releases = join(dir, "releases.json");
      writeFileSync(
        releases,
        JSON.stringify([
          { version: "1.0.0", released_at: "2026-11-12T00:00:00Z", status: "active" },
          { version: "1.1.0", released_at: "2026-12-01T00:00:00Z", status: "active" },
        ]),
      );
      const reg = loadTrackerRegistry(dir, releases);
      const v = reg.versions();
      expect(v.map((x) => [x.version, x.status])).toEqual([
        ["1.1.0", "active"],
        ["1.0.0", "active"],
      ]);
      expect(v[0]?.files[0]?.url).toBe("/lib/1.1.0/standard.js");
      expect(v[1]?.files[0]?.url).toBe("/lib/1.0.0/standard.js");
      expect(v[0]?.files[0]?.integrity).not.toBe(v[1]?.files[0]?.integrity);
      // A tenant that has not upgraded keeps getting its version; a new snippet gets the newest.
      expect(selectTrackerVersion(v, "1.0.0")?.files[0]?.integrity).toBe(m1.files[0].integrity);
      expect(selectTrackerVersion(v, undefined)?.version).toBe("1.1.0");
      expect(selectTrackerVersion(v, "9.9.9")).toBeUndefined();
      // Withdrawing the old version (security defect, C-37) removes it from snippets only.
      writeFileSync(
        releases,
        JSON.stringify([
          { version: "1.0.0", released_at: "2026-11-12T00:00:00Z", status: "withdrawn" },
          { version: "1.1.0", released_at: "2026-12-01T00:00:00Z", status: "active" },
        ]),
      );
      const after = loadTrackerRegistry(dir, releases).versions();
      expect(after.find((x) => x.version === "1.0.0")?.status).toBe("withdrawn");
      expect(selectTrackerVersion(after, "1.0.0")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("source lint (data-model §4.1, C-103)", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  }
  it("never sets context outside scf.set_tenant_ctx and never uses session state", () => {
    for (const f of files(src)) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/set_config\(/i);
      expect(text, f).not.toMatch(/\b(SET|RESET)\s+(LOCAL\s+)?app\./i);
      expect(text, f).not.toMatch(/\bPREPARE\s+\w+/i);
      expect(text, f).not.toMatch(/pg_advisory_lock\(/i);
    }
  });
});

describe("tracker version seen (C-129, web counter tracker_version)", () => {
  const view = (version: string, status: "active" | "withdrawn"): TrackerVersionView => ({
    version,
    status,
    released_at: "2026-11-12T00:00:00.000Z",
    files: [],
    advisory_url: null,
  });
  it("reports the version with the most events; ties go to the higher version; odd labels are ignored", () => {
    expect(trackerVersionSeen([])).toBeNull();
    expect(
      trackerVersionSeen([
        { label: "v1_0_0", count: 5 },
        { label: "v1_10_0", count: 3 },
        { label: "v1_10_0", count: 2 },
        { label: "v1.2.0", count: 99 },
        { label: "all", count: 99 },
      ]),
    ).toBe("1.10.0");
    expect(
      trackerVersionSeen([
        { label: "v2_0_0", count: 4 },
        { label: "v1_9_9", count: 7 },
      ]),
    ).toBe("1.9.9");
    expect(trackerVersionSeen([{ label: "v0_0_0", count: 0 }])).toBeNull();
  });
  it("is outdated only when below the newest active release", () => {
    const versions = [view("1.2.0", "withdrawn"), view("1.1.0", "active"), view("1.0.0", "active")];
    expect(trackerOutdated("1.0.0", versions)).toBe(true);
    expect(trackerOutdated("1.1.0", versions)).toBe(false);
    expect(trackerOutdated("1.2.0", versions)).toBe(false); // a withdrawn newer version does not count
    expect(trackerOutdated(null, versions)).toBe(false);
    expect(trackerOutdated("1.0.0", [])).toBe(false);
  });
});
