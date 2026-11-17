// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { cspDirectives, SEAL_HORIZON_ORIGINS, securityHeaders } from "../../server/headers.ts";

describe("portal security headers (hardening.md §10)", () => {
  for (const scheme of ["http", "https"] as const) {
    it(`${scheme}: strict CSP`, () => {
      const csp = securityHeaders(scheme)["Content-Security-Policy"] ?? "";
      // The only remote origins: Stellar's two public Horizons, for the seal lookup on /verify (plan D-5).
      const rest = SEAL_HORIZON_ORIGINS.reduce((c, o) => c.replaceAll(o, ""), csp);
      expect(rest).not.toMatch(/unsafe-|\*|https?:/);
      const d = cspDirectives(scheme);
      expect(d).toContain("script-src 'self'");
      expect(d).toContain("style-src 'self'");
      expect(d).toContain(`connect-src 'self' ${SEAL_HORIZON_ORIGINS.join(" ")}`);
      expect(d.filter((x) => /https?:/.test(x))).toEqual([
        `connect-src 'self' ${SEAL_HORIZON_ORIGINS.join(" ")}`,
      ]);
      expect(d).toContain("frame-ancestors 'none'");
      expect(d).toContain("require-trusted-types-for 'script'");
      expect(d).toContain("trusted-types 'none'");
      expect(d[0]).toBe("default-src 'none'");
    });
  }
  it("https adds HSTS and upgrade-insecure-requests; http does not", () => {
    expect(securityHeaders("https")["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(cspDirectives("https")).toContain("upgrade-insecure-requests");
    expect(securityHeaders("http")["Strict-Transport-Security"]).toBeUndefined();
    expect(cspDirectives("http")).not.toContain("upgrade-insecure-requests");
  });
  it("keeps powerful features off except passkeys and clipboard writes", () => {
    const pp = securityHeaders("https")["Permissions-Policy"] ?? "";
    expect(pp).toContain("camera=()");
    expect(pp).toContain("geolocation=()");
    expect(pp).toContain("publickey-credentials-get=(self)");
    expect(pp).toContain("publickey-credentials-create=(self)");
    expect(securityHeaders("https")["Referrer-Policy"]).toBe("no-referrer");
  });
});
