// SPDX-License-Identifier: Apache-2.0
// MCP OAuth consent page model (src/pages/oauth/model.ts): URL state and the only navigations the page performs.

import { describe, expect, it } from "vitest";
import { approveBody, parseConsentSearch, safeRedirect } from "../../src/pages/oauth/model.ts";

describe("oauth consent model", () => {
  it("keeps only a UUID request id", () => {
    const id = "0190a000-0000-7000-8000-000000000001";
    expect(parseConsentSearch({ request: id })).toEqual({ request: id });
    expect(parseConsentSearch({ request: "../x" })).toEqual({});
    expect(parseConsentSearch({ request: 1 })).toEqual({});
    expect(parseConsentSearch({})).toEqual({});
  });

  it("sends exactly one of tenant_id and operator", () => {
    expect(approveBody({ tenantId: "t" })).toEqual({ tenant_id: "t" });
    expect(approveBody({ operator: true })).toEqual({ operator: true });
  });

  it("navigates only to http(s) redirect URIs", () => {
    expect(safeRedirect("https://claude.ai/api/mcp/auth_callback?code=c&state=s")).toBe(
      "https://claude.ai/api/mcp/auth_callback?code=c&state=s",
    );
    expect(safeRedirect("http://localhost:3118/callback?code=c")).toBe(
      "http://localhost:3118/callback?code=c",
    );
    expect(safeRedirect("javascript:alert(1)")).toBeNull();
    expect(safeRedirect("data:text/html,x")).toBeNull();
    expect(safeRedirect("not a url")).toBeNull();
  });
});
