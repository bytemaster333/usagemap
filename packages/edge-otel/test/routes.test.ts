// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { normalize } from "../src/pathnorm.ts";
import { compileRoute, createMatcher } from "../src/routes.ts";
import { ACCOUNT } from "./helpers.ts";

describe("route templates", () => {
  it.each([
    ["/sep24/transactions/:id", "/sep24/transactions/{id}"],
    ["/accounts/{accountId}/payments", "/accounts/{accountid}/payments"],
    ["/api/items/[id]", "/api/items/{id}"],
    ["/docs/[...slug]", "/docs/{slug}"],
    ["/docs/[[...slug]]", "/docs/{slug}"],
    ["/files/*", "/files/{wildcard}"],
    ["/files/:path+", "/files/{wildcard}"],
    ["/files/:path*", "/files/{wildcard}"],
    ["/users/<int:user_id>", "/users/{user_id}"],
    ["/orders/:id?", "/orders/{id}"],
    ["/", "/"],
    ["/v1/sep-31/info", "/v1/sep-31/info"],
  ])("%s is reported as %s (pathnorm route mode)", (tpl, route) => {
    expect(compileRoute(tpl).route).toBe(route);
    expect(normalize(route, "route")).toBe(route);
  });

  it("a literal secret in a template is still redacted", () => {
    expect(compileRoute(`/keys/S${"A".repeat(55)}`).route).toBe("/keys/{redacted}");
  });

  it("rejects unusable templates", () => {
    expect(() => compileRoute("no-slash")).toThrow(TypeError);
    expect(() => compileRoute("/a/*/b")).toThrow(/last segment/);
    expect(() => compileRoute("/a/:id?/b")).toThrow(/last segment/);
    expect(() => compileRoute("/a?x=1")).toThrow(/query/);
  });

  it("matches the most specific template first, ties in declared order", () => {
    const m = createMatcher([
      "/files/*",
      "/accounts/:id",
      "/accounts/new",
      "/accounts/:id/payments",
      "/docs/[...slug]",
      "/blog/[[...slug]]",
      "/orders/:id?",
      "/a/:x",
      "/a/:y",
    ]);
    expect(m("/accounts/new")).toBe("/accounts/new");
    expect(m(`/accounts/${ACCOUNT}`)).toBe("/accounts/{id}");
    expect(m(`/accounts/${ACCOUNT}/payments/`)).toBe("/accounts/{id}/payments");
    expect(m("/accounts")).toBeUndefined();
    expect(m("/files")).toBe("/files/{wildcard}");
    expect(m("/files/a/b/c.png")).toBe("/files/{wildcard}");
    expect(m("/docs")).toBeUndefined();
    expect(m("/docs/intro/setup")).toBe("/docs/{slug}");
    expect(m("/blog")).toBe("/blog/{slug}");
    expect(m("/orders")).toBe("/orders/{id}");
    expect(m("/orders/7")).toBe("/orders/{id}");
    expect(m("/orders/7/x")).toBeUndefined();
    expect(m("/a/1")).toBe("/a/{x}");
  });

  it("compares literal segments after percent-decoding", () => {
    const m = createMatcher(["/caf%C3%A9/menu", "/sep%2D24"]);
    expect(m("/café/menu")).toBe("/caf%C3%A9/menu");
    expect(m("/caf%C3%A9/menu")).toBe("/caf%C3%A9/menu");
  });
});
