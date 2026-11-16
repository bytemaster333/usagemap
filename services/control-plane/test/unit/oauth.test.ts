// SPDX-License-Identifier: Apache-2.0
// MCP OAuth authorization server: pure rules (src/oauth/rules.ts), configuration, Client ID Metadata Documents and the
// delegated-token policy (src/oauth/principal.ts). Database behaviour: test/integration/oauth.test.ts.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OpenApi } from "../../src/http/openapi.ts";
import { fetchClientMetadata } from "../../src/oauth/cimd.ts";
import { oauthConfig } from "../../src/oauth/config.ts";
import {
  delegatedBearer,
  OAUTH_TENANT_READ_OPS,
  oauthOperatorKey,
  oauthSession,
} from "../../src/oauth/principal.ts";
import {
  canonicalResource,
  cleanClientName,
  grantedScope,
  isCimdClientId,
  isLoopbackRedirect,
  newDcrClientId,
  newToken,
  pkceChallenge,
  redirectMatches,
  redirectUriProblem,
  tokenHash,
  tokenKind,
  validateClientMetadata,
  verifyPkce,
  withParams,
} from "../../src/oauth/rules.ts";
import type { OAuthPrincipal } from "../../src/oauth/service.ts";

describe("tokens", () => {
  it("are 256-bit opaque values with a kind prefix; only SHA-256 is stored", () => {
    const seen = new Set<string>();
    for (const kind of ["access", "refresh", "delegated", "code"] as const) {
      for (let i = 0; i < 50; i++) {
        const t = newToken(kind);
        expect(t).toMatch(/^scfa_o(at|rt|dt|ac)_[A-Za-z0-9_-]{43}$/);
        expect(tokenKind(t)).toBe(kind);
        expect(Buffer.from(t.slice(9), "base64url")).toHaveLength(32);
        seen.add(t);
      }
    }
    expect(seen.size).toBe(200);
    const t = newToken("access");
    expect(tokenHash(t).equals(createHash("sha256").update(t).digest())).toBe(true);
    expect(tokenKind("scfa_op_x")).toBeNull();
    expect(tokenKind(`${newToken("access")}x`)).toBeNull();
  });
});

describe("PKCE (RFC 7636, S256 only)", () => {
  // RFC 7636 Appendix B test vector
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  it("matches the RFC test vector", () => {
    expect(pkceChallenge(verifier)).toBe(challenge);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });
  it("refuses a wrong, short, long, missing or ill-formed verifier", () => {
    expect(verifyPkce(`${verifier.slice(0, -1)}Y`, challenge)).toBe(false);
    expect(verifyPkce("a".repeat(42), pkceChallenge("a".repeat(42)))).toBe(false);
    expect(verifyPkce("a".repeat(129), pkceChallenge("a".repeat(129)))).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce(`${"a".repeat(43)} `, challenge)).toBe(false);
    // `plain` would compare the verifier with itself: never accepted
    expect(verifyPkce("a".repeat(43), "a".repeat(43))).toBe(false);
  });
});

describe("redirect URIs", () => {
  it("accepts https and loopback http only", () => {
    expect(redirectUriProblem("https://claude.ai/api/mcp/auth_callback")).toBeNull();
    expect(redirectUriProblem("http://localhost:3118/callback")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1/callback")).toBeNull();
    expect(redirectUriProblem("http://[::1]:8080/cb")).toBeNull();
    for (const bad of [
      "http://example.com/cb",
      "http://localhost.evil.com/cb",
      "https://claude.ai/cb#frag",
      "https://user:pw@claude.ai/cb",
      "cursor://anysphere.cursor-retrieval/oauth",
      "javascript:alert(1)",
      "/relative",
      "",
      `https://x.test/${"a".repeat(2050)}`,
      42,
    ])
      expect(redirectUriProblem(bad), String(bad)).not.toBeNull();
  });

  it("match exactly, except loopback redirects, which ignore the port (RFC 8252 §7.3)", () => {
    const reg = [
      "https://claude.ai/api/mcp/auth_callback",
      "http://localhost/callback",
      "http://127.0.0.1/callback",
    ];
    expect(redirectMatches(reg, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectMatches(reg, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(redirectMatches(reg, "https://claude.ai:8443/api/mcp/auth_callback")).toBe(false);
    expect(redirectMatches(reg, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(redirectMatches(reg, "http://localhost:3118/callback")).toBe(true);
    expect(redirectMatches(reg, "http://127.0.0.1:55555/callback")).toBe(true);
    expect(redirectMatches(reg, "http://localhost:3118/other")).toBe(false);
    expect(redirectMatches(reg, "http://[::1]:3118/callback")).toBe(false);
    expect(redirectMatches(["http://localhost/callback"], "http://127.0.0.1:1/callback")).toBe(
      false,
    );
    expect(isLoopbackRedirect("http://localhost:1/x")).toBe(true);
    expect(isLoopbackRedirect("https://localhost:1/x")).toBe(false);
  });
});

describe("resource indicators (RFC 8707)", () => {
  it("canonicalise scheme and host case and a lone trailing slash", () => {
    expect(canonicalResource("https://app.usagemap.dev/mcp")).toBe("https://app.usagemap.dev/mcp");
    expect(canonicalResource("HTTPS://APP.UsageMap.dev/mcp")).toBe("https://app.usagemap.dev/mcp");
    expect(canonicalResource("https://app.usagemap.dev/mcp/")).toBe("https://app.usagemap.dev/mcp");
    expect(canonicalResource("https://app.usagemap.dev/")).toBe("https://app.usagemap.dev");
    expect(canonicalResource("https://app.usagemap.dev:443/mcp")).toBe(
      "https://app.usagemap.dev/mcp",
    );
    expect(canonicalResource("https://app.usagemap.dev/MCP")).toBe("https://app.usagemap.dev/MCP");
    for (const bad of ["app.usagemap.dev", "https://x.test/mcp#f", "ftp://x.test", "", 1])
      expect(canonicalResource(bad)).toBeNull();
  });
});

describe("scopes", () => {
  it("grant read only; offline_access is accepted; anything else is invalid_scope", () => {
    expect(grantedScope(undefined)).toEqual({ ok: true, scope: "usagemap:read" });
    expect(grantedScope("usagemap:read offline_access")).toEqual({
      ok: true,
      scope: "usagemap:read",
    });
    expect(grantedScope("offline_access")).toEqual({ ok: true, scope: "usagemap:read" });
    expect(grantedScope("usagemap:write").ok).toBe(false);
    expect(grantedScope("usagemap:read admin").ok).toBe(false);
  });
});

describe("client metadata (RFC 7591 / CIMD)", () => {
  it("accepts a public client", () => {
    const r = validateClientMetadata({
      client_name: "Claude",
      redirect_uris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.ai/api/mcp/auth_callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(r).toEqual({
      ok: true,
      clientName: "Claude",
      clientUri: null,
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
  });

  it("refuses confidential clients, other grants, bad redirects and bad names", () => {
    const base = { redirect_uris: ["https://c.test/cb"] };
    const cases: [unknown, string][] = [
      [null, "invalid_client_metadata"],
      [[], "invalid_client_metadata"],
      [{}, "invalid_redirect_uri"],
      [{ redirect_uris: [] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["http://c.test/cb"] }, "invalid_redirect_uri"],
      [{ ...base, token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata"],
      [{ ...base, grant_types: ["client_credentials"] }, "invalid_client_metadata"],
      [{ ...base, grant_types: ["refresh_token"] }, "invalid_client_metadata"],
      [{ ...base, response_types: ["token"] }, "invalid_client_metadata"],
      [{ ...base, client_name: "\u0000‮" }, "invalid_client_metadata"],
      [{ ...base, client_uri: "http://c.test" }, "invalid_client_metadata"],
    ];
    for (const [doc, error] of cases) {
      const r = validateClientMetadata(doc);
      expect(r.ok, JSON.stringify(doc)).toBe(false);
      if (!r.ok) expect(r.error, JSON.stringify(doc)).toBe(error);
    }
  });

  it("a metadata document must name itself", () => {
    const url = "https://claude.ai/oauth/claude-code-client-metadata";
    const doc = {
      client_id: url,
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback"],
    };
    expect(validateClientMetadata(doc, url).ok).toBe(true);
    expect(validateClientMetadata(doc, "https://evil.test/meta").ok).toBe(false);
  });

  it("client names are cleaned for display", () => {
    expect(cleanClientName("  Claude‮  \n Code ")).toBe("Claude Code");
    expect(cleanClientName("x".repeat(300))).toHaveLength(100);
    expect(cleanClientName("   ")).toBeNull();
  });

  it("recognises CIMD client ids and DCR ids", () => {
    expect(isCimdClientId("https://claude.ai/oauth/claude-code-client-metadata")).toBe(true);
    expect(isCimdClientId("https://claude.ai")).toBe(false);
    expect(isCimdClientId("https://claude.ai/")).toBe(false);
    expect(isCimdClientId("https://claude.ai:8443/meta")).toBe(false);
    expect(isCimdClientId("http://claude.ai/meta")).toBe(false);
    expect(isCimdClientId("https://claude.ai/meta#x")).toBe(false);
    expect(newDcrClientId()).toMatch(/^umc_[A-Za-z0-9_-]{32}$/);
  });

  it("fetches a metadata document through the SSRF-safe fetcher and validates it", async () => {
    const url = "https://client.test/oauth/meta.json";
    const bodies = new Map<string, string>([
      [
        "client.test/oauth/meta.json",
        JSON.stringify({
          client_id: url,
          client_name: "Test",
          redirect_uris: ["http://127.0.0.1/cb"],
        }),
      ],
      [
        "client.test/other.json",
        JSON.stringify({ client_id: "https://elsewhere.test/x", redirect_uris: [] }),
      ],
      ["client.test/bad.json", "<html>"],
    ]);
    const fetcher = {
      fetchText: async (host: string, path: string) => {
        const b = bodies.get(`${host}${path}`);
        return b === undefined
          ? { kind: "code" as const, code: "HTTP_STATUS" as const }
          : { kind: "ok" as const, body: b };
      },
    };
    expect(await fetchClientMetadata(fetcher, url)).toEqual({
      ok: true,
      clientName: "Test",
      clientUri: null,
      redirectUris: ["http://127.0.0.1/cb"],
    });
    expect((await fetchClientMetadata(fetcher, "https://client.test/other.json")).ok).toBe(false);
    expect((await fetchClientMetadata(fetcher, "https://client.test/bad.json")).ok).toBe(false);
    expect((await fetchClientMetadata(fetcher, "https://client.test/missing")).ok).toBe(false);
  });
});

describe("configuration", () => {
  const env = (o: Record<string, string>) => (n: string) => o[n];
  it("is off without the exchange secret and defaults the resource to <portal>/mcp", () => {
    const c = oauthConfig(env({}), "https://app.usagemap.dev");
    expect(c.enabled).toBe(false);
    expect(c.mcpResource).toBe("https://app.usagemap.dev/mcp");
    expect(c.issuer).toBe("https://app.usagemap.dev");
    expect(c.cimd).toBe(true);
  });
  it("validates its settings", () => {
    expect(() =>
      oauthConfig(env({ SCF_OAUTH_EXCHANGE_SECRET: "short" }), "https://a.test"),
    ).toThrow();
    expect(() => oauthConfig(env({ SCF_OAUTH_MCP_RESOURCE: "x#y" }), "https://a.test")).toThrow();
    expect(() => oauthConfig(env({ SCF_OAUTH_CIMD: "yes" }), "https://a.test")).toThrow();
    const c = oauthConfig(
      env({ SCF_OAUTH_EXCHANGE_SECRET: "s".repeat(32), SCF_OAUTH_CIMD: "false" }),
      "https://a.test",
    );
    expect(c.enabled).toBe(true);
    expect(c.cimd).toBe(false);
    expect(c.exchangeSecretHash?.equals(createHash("sha256").update("s".repeat(32)).digest())).toBe(
      true,
    );
  });
});

describe("delegated tokens at the control-plane API", () => {
  const openapi = new OpenApi();
  const tenantId = "0190a000-0000-7000-8000-000000000001";
  const p: OAuthPrincipal = {
    grantId: "0190a000-0000-7000-8000-0000000000aa",
    userId: "0190a000-0000-7000-8000-0000000000bb",
    kind: "tenant",
    tenantId,
    clientId: "umc_x",
    clientName: "Claude",
    scope: "usagemap:read",
    resource: "https://app.usagemap.dev/mcp",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const token = newToken("delegated");

  it("are recognised only as a well-formed Bearer value", () => {
    expect(delegatedBearer(`Bearer ${token}`)).toBe(token);
    expect(delegatedBearer(`bearer ${token}`)).toBeUndefined();
    expect(delegatedBearer(`Bearer ${newToken("access")}`)).toBeUndefined();
    expect(delegatedBearer(undefined)).toBeUndefined();
  });

  it("the allow-list holds tenant-viewer GET operations only, nothing that leaks secrets, members or audit", () => {
    for (const id of OAUTH_TENANT_READ_OPS) {
      const op = openapi.get(id);
      expect(op.method, id).toBe("get");
      expect(op.roles, id).toEqual(["tenant:viewer"]);
    }
    for (const id of [
      "listMembers",
      "listTenantAudit",
      "listIngestTokens",
      "listShareKeys",
      "getSnippet",
      "getOtelConfig",
      "exportWebDaily",
      "getSecretSeedWarning",
    ])
      expect(OAUTH_TENANT_READ_OPS.has(id), id).toBe(false);
  });

  it("a tenant grant reads its own tenant only, GET allow-listed operations only, with no elevated session", () => {
    const s = oauthSession(p, token, openapi.get("getWebStats"), { tenantId, siteId: "x" });
    expect(s.userId).toBe(p.userId);
    expect(s.platformRole).toBeNull();
    expect(s.passkeyCount).toBe(0);
    expect(s.stepUpAt).toBeNull();
    expect(s.reauthenticatedAt.getTime()).toBe(0);
    expect(() =>
      oauthSession(p, token, openapi.get("getWebStats"), {
        tenantId: "0190a000-0000-7000-8000-000000000002",
        siteId: "x",
      }),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => oauthSession(p, token, openapi.get("listMembers"), { tenantId })).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => oauthSession(p, token, openapi.get("updateTenant"), { tenantId })).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => oauthSession(p, token, openapi.get("operatorListTenants"), {})).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() =>
      oauthSession({ ...p, kind: "operator", tenantId: null }, token, openapi.get("getWebStats"), {
        tenantId,
      }),
    ).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("an operator grant reads /op/v1 with the three read scopes; a tenant grant cannot", () => {
    const k = oauthOperatorKey({ ...p, kind: "operator", tenantId: null });
    expect(k.key_id).toBe(`oauth:${p.grantId}`);
    expect(k.scopes).toEqual(["registry:read", "web:read", "api:read"]);
    expect(k.tenant_restriction).toBeNull();
    expect(() => oauthOperatorKey(p)).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("withParams keeps the redirect URI's own query", () => {
    expect(
      withParams("https://c.test/cb?x=1", { code: "c", state: undefined, iss: "https://i.test" }),
    ).toBe("https://c.test/cb?x=1&code=c&iss=https%3A%2F%2Fi.test");
  });
});
