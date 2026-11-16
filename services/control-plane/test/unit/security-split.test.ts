// SPDX-License-Identifier: Apache-2.0
// Secrets kept out of the internet-facing control plane, rate-limit keys, the control plane's
// Prometheus metrics and the live-read fallback classification (2026-11-13 journey regression). Pure parts only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UmamiHttpError, UmamiUnavailableError } from "@usagemap/umami-adapter";
import { describe, expect, it } from "vitest";
import { JOBS_ONLY_SETTINGS, loadConfig } from "../../src/config.ts";
import { PgRateLimiter } from "../../src/http/ratelimit.ts";
import { CpMetrics, MetricsRegistry, operatorRef, routeClassOf } from "../../src/obs/metrics.ts";
import { liveFallbackReason } from "../../src/web/handlers.ts";
import { loadWorkerConfig, plannedWorkers } from "../../src/workers/config.ts";

const BASE = {
  SCF_PORTAL_ORIGIN: "https://portal.test",
  SCF_DATABASE_URL: "postgres://x@127.0.0.1/scf",
  SCF_INTERNAL_LISTEN_HOST: "127.0.0.1",
};
const SRC = join(import.meta.dirname, "../../src");

describe("F16: the control plane holds no jobs-only secret", () => {
  it.each(JOBS_ONLY_SETTINGS)("refuses to start with %s", (name) => {
    expect(() => loadConfig({ ...BASE, [name]: "x" })).toThrow(/jobs service/);
    expect(() => loadConfig({ ...BASE, [`${name}_FILE`]: "/nonexistent" })).toThrow();
  });

  it("starts without them, with the public snapshot key only", () => {
    const c = loadConfig(BASE);
    expect(c.programme.snapshotPublicKeyPem).toBeUndefined();
    expect(JSON.stringify(Object.keys(c))).not.toMatch(/jobsDatabaseUrl|erasure/);
  });

  it("the process entry point starts no background worker and imports no signer", () => {
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    for (const banned of [
      "SnapshotBuilder",
      "SnapshotSigner",
      "SnapshotLoop",
      "TractionSigner",
      "UmamiReconcile",
      "DomainVerificationWorker",
      "startErasureWorker",
      "PublicMetricsJob",
      "workers/",
    ])
      expect(main).not.toContain(banned);
    const app = readFileSync(join(SRC, "app.ts"), "utf8");
    expect(app).not.toMatch(/SnapshotSigner|TractionSigningKey|createPrivateKey/);
  });

  it("the workers' configuration: planned set and refusals name the variable, never a value", () => {
    expect(loadWorkerConfig({})).toBeUndefined();
    const c = loadWorkerConfig({
      SCF_JOBS_DATABASE_URL: "postgres://j@pgbouncer/scf",
      SCF_UMAMI_MAINT_URL: "postgres://m@pgbouncer/umami",
      SCF_PORTAL_ORIGIN: "https://portal.test/",
    });
    if (!c) throw new Error("config");
    const p = plannedWorkers(c);
    expect(p.run.sort()).toEqual(["domain_verification", "erasure", "public_metrics"]);
    expect(Object.keys(p.missing).sort()).toEqual(["edge_snapshot", "umami_reconcile"]);
    expect(c.edge.maxAgeS).toBe(86_400);
    expect(() => plannedWorkers({ ...c, only: ["edge_snapshot"] })).toThrow(/SCF_EDGE_SIGNING_KEY/);
    expect(() =>
      loadWorkerConfig({ SCF_JOBS_DATABASE_URL: "x", SCF_CORE_WORKERS: "nope" }),
    ).toThrow(/unknown worker/);
  });
});

describe("F21: rate-limit buckets", () => {
  it("are an HMAC of the key: stable for one secret, different across secrets, never the key itself", () => {
    const a = new PgRateLimiter({} as never, Buffer.alloc(32, 1));
    const b = new PgRateLimiter({} as never, Buffer.alloc(32, 2));
    const key = "a:198.51.100.0/24";
    expect(a.bucketOf(key)).toEqual(a.bucketOf(key));
    expect(a.bucketOf(key)).not.toEqual(b.bucketOf(key));
    expect(a.bucketOf(key).length).toBe(32);
    expect(a.bucketOf(key).toString("latin1")).not.toContain("198.51.100");
    expect(() => new PgRateLimiter({} as never, Buffer.alloc(8))).toThrow();
  });

  it("the secret is shared by every instance of a deployment (same peppers or same explicit secret)", () => {
    const peppers = { SCF_PEPPER_OP: `1:${Buffer.alloc(32, 9).toString("base64")}` };
    const x = loadConfig({ ...BASE, ...peppers }).rateLimit.secret;
    const y = loadConfig({ ...BASE, ...peppers }).rateLimit.secret;
    expect(x).toEqual(y);
    const s1 = loadConfig({ ...BASE, SCF_RATE_LIMIT_SECRET: "s".repeat(32) }).rateLimit.secret;
    expect(s1).toEqual(
      loadConfig({ ...BASE, SCF_RATE_LIMIT_SECRET: "s".repeat(32) }).rateLimit.secret,
    );
    expect(s1).not.toEqual(x);
    expect(() => loadConfig({ ...BASE, SCF_RATE_LIMIT_SECRET: "short" })).toThrow(/32 bytes/);
    expect(loadConfig(BASE).rateLimit.store).toBe("postgres");
    expect(() => loadConfig({ ...BASE, SCF_RATE_LIMIT_STORE: "redis" })).toThrow();
  });
});

describe("control-plane metrics (scf_cp_*)", () => {
  it("export the alert catalogue's families with closed label sets", async () => {
    const m = new CpMetrics(new MetricsRegistry());
    m.auth("github", "failed");
    m.auth("passkey", "step_up_failed");
    m.auth('evil"method', "x");
    m.signup();
    m.rateLimited(routeClassOf("createSite"));
    m.opKey("bad_checksum");
    m.operatorRead("0193b7e2-0000-7000-8000-000000000001");
    m.verifierBlocked("private");
    m.liveFallback("unauthorized");
    const text = await m.registry.render();
    for (const name of [
      "scf_cp_auth_events_total",
      "scf_cp_signups_total",
      "scf_cp_rate_limited_total",
      "scf_cp_op_key_events_total",
      "scf_cp_op_key_accepted_after_revocation_total",
      "scf_cp_operator_reads_total",
      "scf_cp_verifier_blocked_targets_total",
      "scf_cp_web_live_fallbacks_total",
    ])
      expect(text).toContain(`# TYPE ${name} counter`);
    expect(text).toContain('scf_cp_auth_events_total{method="github",outcome="failed"} 1');
    expect(text).toContain('scf_cp_auth_events_total{method="other",outcome="other"} 1');
    expect(text).toContain('scf_cp_rate_limited_total{route_class="create"} 1');
    expect(text).toContain("scf_cp_op_key_accepted_after_revocation_total 0");
    expect(text).toContain(`operator_ref="${operatorRef("0193b7e2-0000-7000-8000-000000000001")}"`);
    // No personal data: neither the operator's id nor anything address-like.
    expect(text).not.toContain("0193b7e2-0000-7000-8000-000000000001");
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe("live-read fallback reasons", () => {
  it("401/403 = the key may not read the website; timeouts and other errors are told apart", () => {
    expect(liveFallbackReason(new UmamiHttpError("GET", "/x", 401))).toBe("unauthorized");
    expect(liveFallbackReason(new UmamiHttpError("GET", "/x", 403))).toBe("unauthorized");
    expect(liveFallbackReason(new UmamiHttpError("GET", "/x", 500))).toBe("engine_error");
    expect(liveFallbackReason(new UmamiUnavailableError("GET", "/x", "timeout"))).toBe("timeout");
    expect(liveFallbackReason(new Error("x"))).toBe("engine_error");
  });
});
