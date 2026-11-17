// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, buildPath, buildQuery } from "../../src/api/client.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return r;
  });
  return { f: f as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
const problem = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  new Response(
    JSON.stringify({ type: "about:blank", title: `t-${code}`, status, code, ...extra }),
    {
      status,
      headers: { "content-type": "application/problem+json", ...headers },
    },
  );

describe("ApiClient", () => {
  it("sends X-SCF-Request on writes only, same-origin credentials, JSON bodies (C-20)", async () => {
    const { f, calls } = fakeFetch([json(201, { tenant_id: "t" }), json(200, [])]);
    const c = new ApiClient(f);
    await c.call("createTenant", { body: { slug: "a-b", name: "A" } });
    await c.call("listMyTenants", {});
    expect(calls[0]?.url).toBe("/v1/tenants");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.["X-SCF-Request"]).toBe(
      "1",
    );
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect(calls[0]?.init.body).toBe('{"slug":"a-b","name":"A"}');
    expect(
      (calls[1]?.init.headers as Record<string, string> | undefined)?.["X-SCF-Request"],
    ).toBeUndefined();
  });

  it("encodes path parameters and serialises array queries as form/explode=false", () => {
    expect(
      buildPath("/v1/tenants/{tenantId}/sites/{siteId}", { tenantId: "a/b", siteId: "c?d" }),
    ).toBe("/v1/tenants/a%2Fb/sites/c%3Fd");
    expect(() => buildPath("/v1/tenants/{tenantId}", {})).toThrow();
    expect(buildQuery({ range: "7d", metrics: ["pageviews", "visitors"], x: undefined })).toBe(
      "?range=7d&metrics=pageviews%2Cvisitors",
    );
  });

  it("raises problem details with Retry-After", async () => {
    const { f } = fakeFetch([
      problem(429, "rate_limited", { detail: "slow down" }, { "retry-after": "12" }),
    ]);
    const err = await new ApiClient(f).call("listMyTenants", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfter).toBe(12);
    expect(err.message).toBe("slow down");
  });

  it("synthesises a problem for non-JSON errors", async () => {
    const { f } = fakeFetch([new Response("bad gateway", { status: 502 })]);
    const err = await new ApiClient(f).call("listMyTenants", {}).catch((e) => e);
    expect(err.problem.title).toBe("The service could not be reached");
  });

  it("asks for re-authentication on recent_auth_required and retries once", async () => {
    const { f, calls } = fakeFetch([
      problem(403, "recent_auth_required"),
      new Response(null, { status: 204 }),
    ]);
    const c = new ApiClient(f);
    const reauthenticate = vi.fn(async () => true);
    c.setHooks({ reauthenticate });
    await expect(
      c.call("deletePasskey", { path: { credentialId: "abc" } }),
    ).resolves.toBeUndefined();
    expect(reauthenticate).toHaveBeenCalledWith("recent_auth_required");
    expect(calls).toHaveLength(2);
  });

  it("does not retry when re-authentication is cancelled; step-up is passed through", async () => {
    const { f, calls } = fakeFetch([problem(403, "step_up_required")]);
    const c = new ApiClient(f);
    c.setHooks({ reauthenticate: async () => false });
    const err = await c.call("deletePasskey", { path: { credentialId: "abc" } }).catch((e) => e);
    expect(err.code).toBe("step_up_required");
    expect(calls).toHaveLength(1);
  });

  it("reports 401 to the session hook, except for the session probe itself", async () => {
    const { f } = fakeFetch([problem(401, "unauthenticated"), problem(401, "unauthenticated")]);
    const c = new ApiClient(f);
    const onUnauthenticated = vi.fn();
    c.setHooks({ onUnauthenticated });
    await c.call("authGetSession", {}).catch(() => undefined);
    expect(onUnauthenticated).not.toHaveBeenCalled();
    await c.call("getMe", {}).catch(() => undefined);
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });
});
