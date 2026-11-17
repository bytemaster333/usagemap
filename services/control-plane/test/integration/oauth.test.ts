// SPDX-License-Identifier: Apache-2.0
// MCP OAuth authorization server against real PostgreSQL (migration 0083): a scripted MCP client runs the whole
// authorization-code + PKCE flow through the portal consent API, refreshes with rotation, and the MCP server's token
// exchange yields a control-plane token that reads ONE tenant (or, for an SCF operator, /op/v1) and nothing else.

import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageSession,
  call,
  createTenant,
  type Harness,
  newGithubUser,
  operatorSession,
  PLATFORM_CHAIN,
  PORTAL,
  signInGithub,
  startHarness,
  verifyAuditChain,
} from "../support/harness.ts";

const SECRET = "exchange-secret-for-tests-0123456789abcdef";
const RESOURCE = `${PORTAL}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ SCF_OAUTH_EXCHANGE_SECRET: SECRET, SCF_OAUTH_DCR_PER_HOUR: "1000" });
});
afterAll(async () => {
  expect(h.responseProblems).toEqual([]);
  await h?.close();
});

function form(o: Record<string, string>): string {
  return new URLSearchParams(o).toString();
}

async function post(
  url: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return call(h, {
    method: "POST",
    url,
    body: form(body),
    noCsrf: true,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  });
}

/** A scripted public MCP client (what claude.ai does): DCR, PKCE S256, state, resource, iss check. */
class ScriptedClient {
  clientId = "";
  verifier = randomBytes(32).toString("base64url");
  state = randomBytes(16).toString("base64url");
  readonly redirect: string;
  constructor(redirect = REDIRECT) {
    this.redirect = redirect;
  }

  get challenge(): string {
    return createHash("sha256").update(this.verifier).digest("base64url");
  }

  async register(): Promise<void> {
    const r = await call(h, {
      method: "POST",
      url: "/v1/oauth/register",
      noCsrf: true,
      body: {
        client_name: "Claude",
        redirect_uris: [this.redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    this.clientId = r.json().client_id;
  }

  authorizeUrl(extra: Record<string, string> = {}): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirect,
      code_challenge: this.challenge,
      code_challenge_method: "S256",
      state: this.state,
      scope: "usagemap:read offline_access",
      resource: RESOURCE,
      ...extra,
    });
    return `/v1/oauth/authorize?${q}`;
  }

  /** Authorization request → the consent page's request id. */
  async authorize(): Promise<string> {
    const r = await call(h, { method: "GET", url: this.authorizeUrl() });
    expect(r.statusCode, r.body).toBe(302);
    const loc = new URL(String(r.headers.location));
    expect(loc.origin + loc.pathname).toBe(`${PORTAL}/oauth/consent`);
    return loc.searchParams.get("request") as string;
  }

  /** Parses the redirect back to the client: checks state and iss (RFC 9207) and returns the code. */
  codeFrom(redirectTo: string): string {
    const u = new URL(redirectTo);
    expect(u.origin + u.pathname).toBe(this.redirect);
    expect(u.searchParams.get("state")).toBe(this.state);
    expect(u.searchParams.get("iss")).toBe(PORTAL);
    return u.searchParams.get("code") as string;
  }

  async token(code: string, verifier = this.verifier): Promise<LightMyRequestResponse> {
    return post("/v1/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirect,
      client_id: this.clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
  }

  async refresh(refreshToken: string): Promise<LightMyRequestResponse> {
    return post("/v1/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId,
      resource: RESOURCE,
    });
  }
}

/** What the hosted MCP server does with a client's access token: RFC 8693 exchange for a control-plane token. */
async function exchange(accessToken: string, secret = SECRET): Promise<LightMyRequestResponse> {
  return post(
    "/v1/oauth/token",
    {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: accessToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience: "usagemap-api",
    },
    { authorization: basic("usagemap-mcp", secret) },
  );
}

async function consent(
  cookie: string,
  requestId: string,
  body: object,
): Promise<LightMyRequestResponse> {
  return call(h, {
    method: "POST",
    url: `/v1/oauth/requests/${requestId}/approve`,
    cookie,
    body,
  });
}

/** Full flow for a tenant member: returns the token set and the delegated token. */
async function tenantFlow(cookie: string, tenantId: string, client = new ScriptedClient()) {
  await client.register();
  const requestId = await client.authorize();
  const view = await call(h, { method: "GET", url: `/v1/oauth/requests/${requestId}`, cookie });
  expect(view.statusCode, view.body).toBe(200);
  const approved = await consent(cookie, requestId, { tenant_id: tenantId });
  expect(approved.statusCode, approved.body).toBe(200);
  const code = client.codeFrom(approved.json().redirect_to);
  const t = await client.token(code);
  expect(t.statusCode, t.body).toBe(200);
  const tokens = t.json() as { access_token: string; refresh_token: string; expires_in: number };
  const x = await exchange(tokens.access_token);
  expect(x.statusCode, x.body).toBe(200);
  return {
    client,
    tokens,
    delegated: x.json().access_token as string,
    exchanged: x.json(),
    view: view.json(),
  };
}

describe("metadata and registration", () => {
  it("serves RFC 8414 metadata Claude can use (S256, none, CIMD, iss)", async () => {
    const r = await call(h, { method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(r.statusCode).toBe(200);
    const m = r.json();
    expect(m.issuer).toBe(PORTAL);
    expect(m.authorization_endpoint).toBe(`${PORTAL}/v1/oauth/authorize`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint_auth_methods_supported).toContain("none");
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.registration_endpoint).toBe(`${PORTAL}/v1/oauth/register`);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("refuses redirect URIs that are neither https nor loopback, and confidential clients", async () => {
    for (const body of [
      { redirect_uris: ["http://evil.test/cb"] },
      { redirect_uris: ["https://c.test/cb#x"] },
      { redirect_uris: ["https://c.test/cb"], token_endpoint_auth_method: "client_secret_post" },
    ]) {
      const r = await call(h, { method: "POST", url: "/v1/oauth/register", noCsrf: true, body });
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("rate-limits dynamic registration per client subnet", async () => {
    const h2 = await startHarness({
      SCF_OAUTH_EXCHANGE_SECRET: SECRET,
      SCF_OAUTH_DCR_PER_HOUR: "2",
    });
    try {
      const reg = () =>
        h2.app.inject({
          method: "POST",
          url: "/v1/oauth/register",
          payload: { redirect_uris: ["http://127.0.0.1/cb"] },
        });
      expect((await reg()).statusCode).toBe(201);
      expect((await reg()).statusCode).toBe(201);
      const third = await reg();
      expect(third.statusCode).toBe(429);
      expect(third.headers["retry-after"]).toBeDefined();
    } finally {
      await h2.close();
    }
  });

  it("is switched off (404) without the exchange secret", async () => {
    const h3 = await startHarness({});
    try {
      expect(
        (await h3.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await h3.app.inject({
            method: "POST",
            url: "/v1/oauth/register",
            payload: { redirect_uris: ["https://c.test/cb"] },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await h3.close();
    }
  });
});

describe("authorization endpoint", () => {
  it("never redirects for an unknown client or an unregistered redirect URI", async () => {
    const c = new ScriptedClient();
    await c.register();
    const unknown = await call(h, {
      method: "GET",
      url: c.authorizeUrl({ client_id: "umc_unknownunknownunknownunknownun" }),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.headers.location).toBeUndefined();
    const other = await call(h, {
      method: "GET",
      url: c.authorizeUrl({ redirect_uri: "https://evil.test/cb" }),
    });
    expect(other.statusCode).toBe(400);
    expect(other.headers.location).toBeUndefined();
  });

  it("redirects other errors with state and iss: PKCE missing or plain, wrong resource, bad scope", async () => {
    const c = new ScriptedClient();
    await c.register();
    for (const [extra, error] of [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: "short" }, "invalid_request"],
      [{ resource: "https://other.test/mcp" }, "invalid_target"],
      [{ scope: "usagemap:write" }, "invalid_scope"],
      [{ response_type: "token" }, "unsupported_response_type"],
    ] as const) {
      const r = await call(h, { method: "GET", url: c.authorizeUrl(extra) });
      expect(r.statusCode, JSON.stringify(extra)).toBe(302);
      const u = new URL(String(r.headers.location));
      expect(u.origin + u.pathname).toBe(REDIRECT);
      expect(u.searchParams.get("error")).toBe(error);
      expect(u.searchParams.get("state")).toBe(c.state);
      expect(u.searchParams.get("iss")).toBe(PORTAL);
    }
  });

  it("accepts a loopback redirect on any port (Claude Code) and a Client ID Metadata Document", async () => {
    const url = "https://client.test/oauth/claude-code-client-metadata";
    h.fetcher.bodies.set(
      "client.test/oauth/claude-code-client-metadata",
      JSON.stringify({
        client_id: url,
        client_name: "Claude Code",
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    );
    const c = new ScriptedClient("http://localhost:41234/callback");
    c.clientId = url;
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    const tenantId = await createTenant(h, cookie);
    const requestId = await c.authorize();
    const view = await call(h, { method: "GET", url: `/v1/oauth/requests/${requestId}`, cookie });
    expect(view.json().client).toMatchObject({
      kind: "cimd",
      name: "Claude Code",
      metadata_host: "client.test",
    });
    expect(view.json().redirect_loopback).toBe(true);
    const ok = await consent(cookie, requestId, { tenant_id: tenantId });
    const t = await c.token(c.codeFrom(ok.json().redirect_to));
    expect(t.statusCode, t.body).toBe(200);
  });
});

describe("tenant grant: consent, tokens, isolation", () => {
  let cookieA: string;
  let tenantA: string;
  let tenantB: string;
  let flow: Awaited<ReturnType<typeof tenantFlow>>;

  beforeAll(async () => {
    cookieA = await signInGithub(h, newGithubUser());
    tenantA = await createTenant(h, cookieA);
    const cookieB = await signInGithub(h, newGithubUser());
    tenantB = await createTenant(h, cookieB);
    flow = await tenantFlow(cookieA, tenantA);
  });

  it("the consent page lists only the user's own tenants and offers no operator view", () => {
    expect(flow.view.tenants.map((t: { tenant_id: string }) => t.tenant_id)).toEqual([tenantA]);
    expect(flow.view.operator.eligible).toBe(false);
    expect(flow.view.access).toBe("read_only");
    expect(flow.view.redirect_host).toBe("claude.ai");
  });

  it("issues short-lived tokens; the exchange names the tenant and nothing personal", () => {
    expect(flow.tokens.access_token).toMatch(/^scfa_oat_/);
    expect(flow.tokens.refresh_token).toMatch(/^scfa_ort_/);
    expect(flow.tokens.expires_in).toBeLessThanOrEqual(600);
    expect(flow.delegated).toMatch(/^scfa_odt_/);
    expect(flow.exchanged.expires_in).toBeLessThanOrEqual(300);
    expect(flow.exchanged.usagemap).toMatchObject({
      kind: "tenant",
      tenant_id: tenantA,
      client_name: "Claude",
    });
    expect(JSON.stringify(flow.exchanged)).not.toMatch(/user_id|login|email/);
  });

  it("the delegated token reads tenant A's allow-listed operations", async () => {
    const auth = { authorization: `Bearer ${flow.delegated}` };
    for (const url of [
      `/v1/tenants/${tenantA}`,
      `/v1/tenants/${tenantA}/sites`,
      `/v1/tenants/${tenantA}/services`,
      `/v1/tenants/${tenantA}/verification`,
    ]) {
      const r = await call(h, { method: "GET", url, headers: auth });
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
    }
  });

  it("…and nothing else: tenant B is 404, members/audit/keys 403, writes 403, operator APIs refused", async () => {
    const auth = { authorization: `Bearer ${flow.delegated}` };
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${tenantB}`, headers: auth })).statusCode,
    ).toBe(404);
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${tenantB}/sites`, headers: auth }))
        .statusCode,
    ).toBe(404);
    for (const url of [
      `/v1/tenants/${tenantA}/members`,
      `/v1/tenants/${tenantA}/audit`,
      `/v1/tenants/${tenantA}/share-keys`,
      "/v1/me",
      "/v1/operator/tenants",
    ])
      expect((await h.app.inject({ method: "GET", url, headers: auth })).statusCode, url).toBe(403);
    const write = await h.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}`,
      headers: { ...auth, origin: PORTAL, "x-scf-request": "1" },
      payload: { name: "hijacked" },
    });
    expect(write.statusCode).toBe(403);
    const op = await h.app.inject({ method: "GET", url: "/op/v1/projects", headers: auth });
    expect(op.statusCode).toBe(403);
  });

  it("the client's own access token is not accepted by the control plane (no token passthrough)", async () => {
    const r = await h.app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantA}`,
      headers: { authorization: `Bearer ${flow.tokens.access_token}` },
    });
    expect(r.statusCode).toBe(401);
    const op = await h.app.inject({
      method: "GET",
      url: "/op/v1/projects",
      headers: { authorization: `Bearer ${flow.tokens.access_token}` },
    });
    expect(op.statusCode).toBe(401);
  });

  it("token exchange needs the MCP server's credentials and an access token for the MCP resource", async () => {
    expect((await exchange(flow.tokens.access_token, `${SECRET}x`)).statusCode).toBe(401);
    const noAuth = await post("/v1/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: flow.tokens.access_token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
    expect(noAuth.statusCode).toBe(401);
    const refreshAsSubject = await exchange(flow.tokens.refresh_token);
    expect(refreshAsSubject.statusCode).toBe(400);
    expect(refreshAsSubject.json().error).toBe("invalid_grant");
    const delegatedAsSubject = await exchange(flow.delegated);
    expect(delegatedAsSubject.json().error).toBe("invalid_grant");
  });

  it("codes are single-use with PKCE; a replayed code revokes the grant", async () => {
    const c = new ScriptedClient();
    await c.register();
    const id = await c.authorize();
    const code = c.codeFrom(
      (await consent(cookieA, id, { tenant_id: tenantA })).json().redirect_to,
    );
    const wrong = await c.token(code, randomBytes(32).toString("base64url"));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("invalid_grant");
    // the code was spent by the failed attempt; using it again revokes the grant
    const replay = await c.token(code);
    expect(replay.json().error).toBe("invalid_grant");
    const grants = await h.su.query(
      `SELECT revoke_reason FROM scf.oauth_grants g JOIN scf.oauth_clients c USING (client_id) WHERE c.client_id = $1`,
      [c.clientId],
    );
    expect(grants.rows[0]?.revoke_reason).toBe("code_reuse");
  });

  it("a request can be decided once; a foreign tenant id is 404", async () => {
    const c = new ScriptedClient();
    await c.register();
    const id = await c.authorize();
    expect((await consent(cookieA, id, { tenant_id: tenantB })).statusCode).toBe(404);
    expect((await consent(cookieA, id, { tenant_id: tenantA })).statusCode).toBe(200);
    expect((await consent(cookieA, id, { tenant_id: tenantA })).statusCode).toBe(404);
    expect(
      (await call(h, { method: "GET", url: `/v1/oauth/requests/${id}`, cookie: cookieA }))
        .statusCode,
    ).toBe(404);
  });

  it("deny sends access_denied back to the client", async () => {
    const c = new ScriptedClient();
    await c.register();
    const id = await c.authorize();
    const r = await call(h, {
      method: "POST",
      url: `/v1/oauth/requests/${id}/deny`,
      cookie: cookieA,
    });
    expect(r.statusCode).toBe(200);
    const u = new URL(r.json().redirect_to);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe(c.state);
  });

  it("refresh tokens rotate; a reused refresh token revokes the grant and its tokens", async () => {
    const f = await tenantFlow(cookieA, tenantA);
    const r1 = await f.client.refresh(f.tokens.refresh_token);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().refresh_token).not.toBe(f.tokens.refresh_token);
    const reuse = await f.client.refresh(f.tokens.refresh_token);
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error).toBe("invalid_grant");
    // everything issued under the grant is dead now
    expect((await f.client.refresh(r1.json().refresh_token)).json().error).toBe("invalid_grant");
    expect((await exchange(r1.json().access_token)).json().error).toBe("invalid_grant");
    const r = await h.app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantA}`,
      headers: { authorization: `Bearer ${f.delegated}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it("a member who loses the membership loses the grant at the next use", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const tenant = await createTenant(h, owner);
    const memberUser = newGithubUser();
    const member = await signInGithub(h, memberUser);
    const memberId = (await call(h, { method: "GET", url: "/v1/me", cookie: member })).json()
      .user_id;
    await h.su.query(
      `INSERT INTO scf.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [tenant, memberId],
    );
    const f = await tenantFlow(member, tenant);
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: `/v1/tenants/${tenant}`,
          headers: { authorization: `Bearer ${f.delegated}` },
        })
      ).statusCode,
    ).toBe(200);
    await h.su.query(`DELETE FROM scf.memberships WHERE tenant_id = $1 AND user_id = $2`, [
      tenant,
      memberId,
    ]);
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: `/v1/tenants/${tenant}`,
          headers: { authorization: `Bearer ${f.delegated}` },
        })
      ).statusCode,
    ).toBe(404);
    expect((await exchange(f.tokens.access_token)).json().error).toBe("invalid_grant");
    const rr = await f.client.refresh(f.tokens.refresh_token);
    expect(rr.json().error).toBe("invalid_grant");
    const g = await h.su.query(`SELECT revoke_reason FROM scf.oauth_grants WHERE client_id = $1`, [
      f.client.clientId,
    ]);
    expect(g.rows[0]?.revoke_reason).toBe("access_lost");
  });

  it("connected apps: listed, revocable by the user (audited), and RFC 7009 revocation works", async () => {
    const f = await tenantFlow(cookieA, tenantA);
    const list = await call(h, { method: "GET", url: "/v1/me/oauth-grants", cookie: cookieA });
    const mine = list
      .json()
      .find((g: { tenant_id: string; client_name: string }) => g.tenant_id === tenantA);
    expect(mine).toMatchObject({ client_name: "Claude", kind: "tenant", tenant_id: tenantA });
    const del = await call(h, {
      method: "DELETE",
      url: `/v1/me/oauth-grants/${mine.grant_id}`,
      cookie: cookieA,
    });
    expect(del.statusCode).toBe(204);
    // another user cannot revoke (or see) it
    const other = await signInGithub(h, newGithubUser());
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/me/oauth-grants/${mine.grant_id}`,
          cookie: other,
        })
      ).statusCode,
    ).toBe(404);

    const g = await tenantFlow(cookieA, tenantA);
    const rv = await post("/v1/oauth/revoke", {
      token: g.tokens.refresh_token,
      client_id: g.client.clientId,
    });
    expect(rv.statusCode).toBe(200);
    expect((await exchange(g.tokens.access_token)).json().error).toBe("invalid_grant");
    // unknown token: 200 as well
    expect(
      (await post("/v1/oauth/revoke", { token: "nope", client_id: g.client.clientId })).statusCode,
    ).toBe(200);
    void f;
  });

  it("audits consent and revocation in the tenant chain; stores only hashes; logs no token", async () => {
    const rows = await h.su.query<{ action: string }>(
      `SELECT action FROM scf.audit_log WHERE tenant_id = $1 AND action LIKE 'oauth.%' ORDER BY seq`,
      [tenantA],
    );
    expect(rows.rows.map((r) => r.action)).toContain("oauth.grant_created");
    expect(rows.rows.map((r) => r.action)).toContain("oauth.grant_revoked");
    await verifyAuditChain(h, tenantA);
    await verifyAuditChain(h, PLATFORM_CHAIN);
    const stored = await h.su.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM scf.oauth_tokens WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [flow.tokens.access_token],
    );
    expect(stored.rows[0]?.n).toBe("1");
    expect(h.logs.lines.join("\n")).not.toMatch(/scfa_o(at|rt|dt|ac)_/);
  });
});

describe("operator grant", () => {
  it("needs the operator role, two passkeys and a fresh step-up; reads /op/v1 and no tenant API", async () => {
    const op = await operatorSession(h, "operator");
    const c = new ScriptedClient();
    await c.register();
    const id = await c.authorize();
    const view = await call(h, {
      method: "GET",
      url: `/v1/oauth/requests/${id}`,
      cookie: op.cookie,
    });
    expect(view.json().operator.eligible).toBe(true);
    expect(view.json().operator.step_up_valid_until).not.toBeNull();

    // a stale step-up is refused
    await ageSession(h, op.cookie, 11);
    const stale = await consent(op.cookie, id, { operator: true });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe("step_up_required");
    await ageSession(h, op.cookie, 1);

    const ok = await consent(op.cookie, id, { operator: true });
    expect(ok.statusCode, ok.body).toBe(200);
    const t = await c.token(c.codeFrom(ok.json().redirect_to));
    expect(t.statusCode, t.body).toBe(200);
    const x = await exchange(t.json().access_token);
    expect(x.json().usagemap).toMatchObject({ kind: "operator", tenant_id: null });
    const auth = { authorization: `Bearer ${x.json().access_token}` };
    const projects = await h.app.inject({
      method: "GET",
      url: "/op/v1/projects?min_level=L0",
      headers: auth,
    });
    expect(projects.statusCode, projects.body).toBe(200);
    // audited by op_begin under the grant's id
    const audit = await h.su.query(
      `SELECT actor_kind, actor_id FROM scf.audit_log WHERE action = 'operator.read.op_projects' AND actor_id LIKE 'oauth:%' ORDER BY seq DESC LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({ actor_kind: "op_key" });
    // no tenant API and no operator console
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/operator/tenants", headers: auth }))
        .statusCode,
    ).toBe(403);
    const tenant = await createTenant(h, await signInGithub(h, newGithubUser()));
    expect(
      (await h.app.inject({ method: "GET", url: `/v1/tenants/${tenant}`, headers: auth }))
        .statusCode,
    ).toBe(403);

    // the operator role is revoked: the token is dead at once
    await h.su.query(`UPDATE scf.platform_operators SET revoked_at = now() WHERE user_id = $1`, [
      op.userId,
    ]);
    expect(
      (await h.app.inject({ method: "GET", url: "/op/v1/projects", headers: auth })).statusCode,
    ).toBe(401);
  });

  it("a non-operator cannot ask for the operator view", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const c = new ScriptedClient();
    await c.register();
    const id = await c.authorize();
    const r = await consent(cookie, id, { operator: true });
    expect(r.statusCode).toBe(403);
    expect(
      (
        await consent(cookie, id, {
          operator: true,
          tenant_id: "0190a000-0000-7000-8000-000000000001",
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("end to end: scripted MCP client → hosted MCP server → authorization server → control plane", () => {
  it("discovers, signs in with PKCE, reads one tenant through the MCP tools, and loses access on revocation", async () => {
    const { createMcpHttpServer } = await import("../../../mcp/src/http.ts");
    const { loadConfig: loadMcpConfig } = await import("../../../mcp/src/config.ts");
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const cpAddr = h.app.server.address() as AddressInfo;
    const mcpLogs: string[] = [];
    const mcp = createMcpHttpServer({
      config: loadMcpConfig({
        MCP_CONTROL_PLANE_URL: `http://127.0.0.1:${cpAddr.port}`,
        MCP_OAUTH_EXCHANGE_SECRET: SECRET,
        MCP_RESOURCE_URL: RESOURCE,
      }),
      version: "e2e",
      log: (level, msg, fields) => mcpLogs.push(JSON.stringify({ level, msg, ...fields })),
    });
    await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
    const mcpBase = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
    const rpc = async (
      token: string | null,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      const r = await fetch(`${mcpBase}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const text = await r.text();
      return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : undefined };
    };
    try {
      // 1. unauthenticated → 401 with the resource metadata pointer (RFC 9728 §5.1)
      const first = await rpc(null, "tools/list");
      expect(first.status).toBe(401);
      const m = /resource_metadata="([^"]+)"/.exec(first.headers.get("www-authenticate") ?? "");
      expect(m?.[1]).toBe(`${PORTAL}/.well-known/oauth-protected-resource/mcp`);
      const prm = (await (
        await fetch(`${mcpBase}${new URL(m?.[1] as string).pathname}`)
      ).json()) as { resource: string; authorization_servers: string[] };
      expect(prm.resource).toBe(RESOURCE);
      const issuer = prm.authorization_servers[0];
      // 2. authorization server metadata; issuer must match (RFC 8414 §3.3)
      const asm = (
        await call(h, { method: "GET", url: "/.well-known/oauth-authorization-server" })
      ).json();
      expect(asm.issuer).toBe(issuer);
      expect(asm.code_challenge_methods_supported).toContain("S256");
      // 3. DCR, authorization code + PKCE through the portal consent
      const cookie = await signInGithub(h, newGithubUser());
      const tenant = await createTenant(h, cookie);
      const other = await createTenant(h, await signInGithub(h, newGithubUser()));
      const f = await tenantFlow(cookie, tenant);
      // 4. MCP with the client's access token
      const list = await rpc(f.tokens.access_token, "tools/list");
      expect(list.status).toBe(200);
      const names = list.json.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("project_overview");
      expect(names).not.toContain("list_projects");
      const ov = await rpc(f.tokens.access_token, "tools/call", {
        name: "project_overview",
        arguments: {},
      });
      expect(ov.json.result.isError, JSON.stringify(ov.json)).not.toBe(true);
      expect(ov.json.result.structuredContent.tenant.tenant_id).toBe(tenant);
      expect(JSON.stringify(ov.json)).not.toContain(other);
      // another tenant's site id is not reachable
      const foreign = await rpc(f.tokens.access_token, "tools/call", {
        name: "web_stats",
        arguments: { site_id: "0190a000-0000-7000-8000-00000000dead" },
      });
      expect(foreign.json.result.isError).toBe(true);
      // the refresh token is not accepted by the MCP server, nor is the delegated token
      expect((await rpc(f.tokens.refresh_token, "tools/list")).status).toBe(401);
      expect((await rpc(f.delegated, "tools/list")).status).toBe(401);
      // 5. the user disconnects the app → tool calls fail at once, then the MCP server answers 401
      const grants = (await call(h, { method: "GET", url: "/v1/me/oauth-grants", cookie })).json();
      for (const g of grants)
        expect(
          (await call(h, { method: "DELETE", url: `/v1/me/oauth-grants/${g.grant_id}`, cookie }))
            .statusCode,
        ).toBe(204);
      const after = await rpc(f.tokens.access_token, "tools/call", {
        name: "project_overview",
        arguments: {},
      });
      expect(after.status === 401 || after.json?.result?.isError === true).toBe(true);
      expect((await rpc(f.tokens.access_token, "tools/list")).status).toBe(401);
      expect(mcpLogs.join("\n")).not.toMatch(/scfa_o(at|rt|dt|ac)_[A-Za-z0-9_-]{10,}/);
    } finally {
      await new Promise<void>((r) => {
        mcp.closeAllConnections();
        mcp.close(() => r());
      });
    }
  });
});
