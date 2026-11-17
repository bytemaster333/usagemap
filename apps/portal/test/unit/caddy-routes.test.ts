// SPDX-License-Identifier: Apache-2.0
// The portal origin is the only public entry to the control plane (ADR-0024): every non-internal operation of both
// OpenAPI documents must be matched by the Caddyfile's `@api` matcher and so reverse-proxied, never answered with the SPA
// shell (regression: `/op/v1/*` once fell through to the catch-all and returned 200 text/html).
// Internal edge operations must NOT be proxied.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { controlPlaneOpenApi, operatorMetricsOpenApi } from "@usagemap/api-types";
import { describe, expect, it } from "vitest";

const caddyfile = readFileSync(join(import.meta.dirname, "../../server/Caddyfile"), "utf8");
/** The production Caddyfile (lean profile, infra/ansible): the same portal site with TLS, plus the landing/docs hosts. */
const prodTemplate = readFileSync(
  join(import.meta.dirname, "../../../../infra/ansible/roles/compose_stack/templates/Caddyfile.j2"),
  "utf8",
);
/** The portal site block of the production template (up to the next site block or template condition). */
const prodPortal = (() => {
  const start = prodTemplate.indexOf("https://{{ scf_portal_hostname }}:8443 {");
  if (start < 0) throw new Error("no portal site in Caddyfile.j2");
  const end = prodTemplate.indexOf("\n}\n", start);
  return prodTemplate.slice(start, end + 2);
})();

/** The patterns of the `@api path …` matcher. */
function apiPatterns(source = caddyfile): string[] {
  const m = /^\s*@api path (.+)$/m.exec(source);
  if (!m?.[1]) throw new Error("no @api path matcher in the Caddyfile");
  return m[1].trim().split(/\s+/);
}

/** Caddy's path matcher: exact, or a `*` wildcard (prefix/suffix/substring) — the forms the Caddyfile uses. */
function matches(pattern: string, path: string): boolean {
  if (!pattern.includes("*")) return pattern === path;
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(path);
}

function paths(doc: unknown): Array<{ path: string; internal: boolean }> {
  const d = doc as { paths: Record<string, Record<string, { "x-internal"?: boolean }>> };
  return Object.entries(d.paths).map(([path, item]) => ({
    // a concrete example path: every `{param}` becomes one segment
    path: path.replace(/\{[^}]+\}/g, "x"),
    internal: Object.values(item).some((op) => op?.["x-internal"] === true),
  }));
}

describe("Caddyfile @api matcher ↔ OpenAPI", () => {
  const patterns = apiPatterns();
  const all = [...paths(controlPlaneOpenApi()), ...paths(operatorMetricsOpenApi())];

  it("proxies every public operation of both documents, /op/v1 included", () => {
    const missing = all
      .filter((p) => !p.internal && !patterns.some((pat) => matches(pat, p.path)))
      .map((p) => p.path);
    expect(missing).toEqual([]);
    expect(patterns.some((pat) => matches(pat, "/op/v1/me"))).toBe(true);
  });

  it("never proxies the internal edge API or SPA routes", () => {
    const internal = all.filter((p) => p.internal).map((p) => p.path);
    expect(internal.length).toBeGreaterThan(0);
    for (const p of [
      ...internal,
      "/",
      "/dashboard",
      "/operator/tenants",
      "/docs/methodology/1.0.0",
    ])
      expect(patterns.some((pat) => matches(pat, p))).toBe(false);
  });
});

// app.usagemap.dev/.well-known/stellar.toml answered 200 with the SPA shell (review 2026-11-20). /.well-known/ paths
// are never the shell: the ones the control plane serves are in @api, stellar.toml goes to the SEP-1 home domain (the
// landing host) in production, everything else is a 404. Checked against a real Caddy 2.11.9 on 2026-11-20.
describe("Caddyfile /.well-known/ paths are never the SPA shell", () => {
  const wellKnown404 =
    /@wellknown path \/\.well-known\/\*\n(?:\t#[^\n]*\n)*\thandle @wellknown \{\n\t\theader Cache-Control "no-store"\n\t\trespond 404\n\t\}/;

  it("answers 404 for every /.well-known/ path not proxied, in the image and in production", () => {
    for (const site of [caddyfile, prodPortal]) {
      expect(site).toMatch(wellKnown404);
      // A single-path `handle /.well-known/*` would be sorted before @api by Caddy and shadow its paths.
      expect(site).not.toMatch(/handle \/\.well-known\/\*/);
      // The 404 comes before the catch-all that serves the shell.
      expect(site.indexOf("@wellknown")).toBeLessThan(
        site.lastIndexOf("try_files {path} /index.html"),
      );
    }
  });

  it("keeps the control plane's /.well-known/ paths proxied, the same in both files", () => {
    const image = apiPatterns().filter((p) => p.startsWith("/.well-known/"));
    expect(image).toEqual([
      "/.well-known/scf-snapshot-keys.json",
      "/.well-known/oauth-authorization-server",
    ]);
    expect(apiPatterns(prodPortal).filter((p) => p.startsWith("/.well-known/"))).toEqual(image);
  });

  it("redirects the portal host's stellar.toml to the SEP-1 home domain (308), 404 without a landing host", () => {
    expect(prodPortal).toContain(
      [
        "\thandle /.well-known/stellar.toml {",
        '\t\theader Cache-Control "no-store"',
        "{% if scf_landing_hostname %}",
        "\t\tredir https://{{ scf_landing_hostname }}/.well-known/stellar.toml 308",
        "{% else %}",
        "\t\trespond 404",
        "{% endif %}",
        "\t}",
      ].join("\n"),
    );
    // The image has no home domain: its stellar.toml is the plain 404.
    expect(caddyfile).not.toContain("stellar.toml {");
  });
});
