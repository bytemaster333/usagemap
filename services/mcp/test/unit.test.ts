// SPDX-License-Identifier: Apache-2.0
// Unit tests of the hosted MCP server's building blocks: offline key parsing (grammar + CRC, wire-formats §k), limits,
// subnet keys, header decoding, configuration and per-key tool selection. Run: services/mcp/run test

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keyWithChecksum, parseKeyOffline } from "../../../tools/mcp/src/api.ts";
import { TOOLS, toolsFor } from "../../../tools/mcp/src/tools.ts";
import { checksum as cpChecksum, KEY_RE as cpKeyRe } from "../../control-plane/src/keys/keys.ts";
import { bearer } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { decodeHeaderValue, keyInUrl } from "../src/http.ts";
import { Inflight, subnetKey, WindowLimiter } from "../src/limits.ts";

describe("keys", () => {
  test("parseKeyOffline accepts a key with its CRC and returns kind and public id, never the secret", () => {
    const k = keyWithChecksum("op", "Abc123Def456", "s".repeat(27));
    assert.equal(k.length, "scfa_op_".length + 12 + 1 + 33);
    assert.deepEqual(parseKeyOffline(k), { kind: "op", id: "Abc123Def456" });
    const p = keyWithChecksum("pub", "Abc123Def456", "t".repeat(27));
    assert.deepEqual(parseKeyOffline(p), { kind: "pub", id: "Abc123Def456" });
  });

  test("the checksum agrees with the control plane's own (services/control-plane/src/keys/keys.ts)", () => {
    for (const [kind, id, secret] of [
      ["op", "0".repeat(12), "0".repeat(27)],
      ["pub", "Abc123Def456", "zZ9".repeat(9)],
      ["ing", "zzzzzzzzzzzz", "A".repeat(27)],
    ] as const) {
      const k = keyWithChecksum(kind, id, secret);
      assert.equal(k.slice(-6), cpChecksum(kind, id, secret), `${kind} ${id}`);
      assert.ok(cpKeyRe.test(k));
    }
  });

  test("a changed character, wrong length or unknown kind is refused", () => {
    const k = keyWithChecksum("op", "Abc123Def456", "s".repeat(27));
    const flip = (i: number) => k.slice(0, i) + (k[i] === "s" ? "t" : "s") + k.slice(i + 1);
    assert.equal(parseKeyOffline(flip(30)), null);
    assert.equal(parseKeyOffline(`${k}x`), null);
    assert.equal(parseKeyOffline(k.replace("scfa_op_", "scfa_xx_")), null);
    assert.equal(parseKeyOffline(""), null);
  });

  test("bearer() takes only the Bearer scheme", () => {
    assert.equal(bearer("Bearer abc"), "abc");
    assert.equal(bearer("bearer  abc "), "abc");
    assert.throws(() => bearer(undefined), /required/);
    assert.throws(() => bearer("Basic abc"), /Bearer/);
    assert.throws(() => bearer("Bearer a b"), /Bearer/);
  });

  test("keyInUrl finds raw and percent-encoded keys", () => {
    assert.ok(keyInUrl("/mcp?k=scfa_op_x"));
    assert.ok(keyInUrl("/mcp?k=scfa%5Fpub%5Fx"));
    assert.ok(!keyInUrl("/mcp"));
  });
});

describe("limits", () => {
  test("fixed window: limit, retry-after, reset after the window", () => {
    let t = 1_000_000;
    const l = new WindowLimiter(2, { now: () => t });
    assert.ok(l.hit("a").allowed);
    assert.ok(l.hit("a").allowed);
    const v = l.hit("a");
    assert.equal(v.allowed, false);
    assert.equal(v.retryAfter, 60);
    assert.ok(l.hit("b").allowed, "keys are independent");
    assert.equal(l.blocked("a").allowed, false);
    t += 60_000;
    assert.ok(l.blocked("a").allowed);
    assert.ok(l.hit("a").allowed);
  });

  test("the key map is bounded", () => {
    const t = 5_000_000;
    const l = new WindowLimiter(1, { maxKeys: 10, now: () => t });
    for (let i = 0; i < 1000; i++) l.hit(`k${i}`);
    // A flood of distinct keys within one window resets the map instead of growing it: early keys are forgotten.
    assert.ok(l.blocked("k0").allowed);
    assert.equal(l.hit("k999").allowed, false, "the most recent key is still counted");
  });

  test("subnet keys: same /24 or /48 collide, others differ; the key is opaque", () => {
    assert.equal(subnetKey("203.0.113.5"), subnetKey("203.0.113.200"));
    assert.equal(subnetKey("::ffff:203.0.113.5"), subnetKey("203.0.113.9"));
    assert.notEqual(subnetKey("203.0.113.5"), subnetKey("203.0.114.5"));
    assert.equal(subnetKey("2001:db8:1:2::1"), subnetKey("2001:db8:1:ffff::9"));
    assert.notEqual(subnetKey("2001:db8:1::1"), subnetKey("2001:db8:2::1"));
    assert.ok(!subnetKey("203.0.113.5").includes("203"));
  });

  test("in-flight cap", () => {
    const f = new Inflight(1);
    assert.ok(f.enter());
    assert.ok(!f.enter());
    f.leave();
    assert.ok(f.enter());
  });
});

describe("headers, config, tool selection", () => {
  test("decodeHeaderValue handles plain and =?base64?…?= values", () => {
    assert.equal(decodeHeaderValue("web_summary"), "web_summary");
    assert.equal(decodeHeaderValue(`=?base64?${Buffer.from("tööl").toString("base64")}?=`), "tööl");
  });

  test("loadConfig: defaults and refusals", () => {
    const c = loadConfig({ MCP_CONTROL_PLANE_URL: "http://control-plane:8080/" });
    assert.equal(c.controlPlaneUrl, "http://control-plane:8080");
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.path, "/mcp");
    assert.equal(c.keyRatePerMin, 120);
    assert.equal(c.forwardClientAddress, false);
    assert.throws(() => loadConfig({}), /required/);
    assert.throws(() => loadConfig({ MCP_CONTROL_PLANE_URL: "http://u:p@cp" }), /credentials/);
    assert.throws(
      () => loadConfig({ MCP_CONTROL_PLANE_URL: "http://cp", MCP_TRUST_PROXY: "proxy" }),
      /IP/,
    );
    assert.throws(
      () => loadConfig({ MCP_CONTROL_PLANE_URL: "http://cp", MCP_ALLOWED_ORIGINS: "https://a/b" }),
      /origin/,
    );
    assert.throws(
      () => loadConfig({ MCP_CONTROL_PLANE_URL: "http://cp", MCP_KEY_RATE_PER_MIN: "0" }),
      /between/,
    );
    assert.throws(
      () => loadConfig({ MCP_CONTROL_PLANE_URL: "http://cp", MCP_FORWARD_CLIENT_ADDRESS: "yes" }),
      /true or false/,
    );
  });

  test("toolsFor: operator keys by scopes, share keys their public document and evidence links", () => {
    assert.equal(
      toolsFor({ kind: "op", scopes: ["registry:read", "web:read", "api:read"] }).length,
      TOOLS.length,
    );
    assert.deepEqual(
      toolsFor({ kind: "op", scopes: ["api:read"] }).map((t) => t.name),
      ["api_routes_summary", "evidence_links"],
    );
    assert.deepEqual(
      toolsFor({ kind: "op", scopes: [] }).map((t) => t.name),
      ["evidence_links"],
    );
    assert.deepEqual(
      toolsFor({ kind: "pub" }).map((t) => t.name),
      ["project_metrics_document", "evidence_links"],
    );
  });
});
