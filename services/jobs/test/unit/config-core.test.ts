// SPDX-License-Identifier: Apache-2.0
// Configuration of the jobs with requirements: requirements per job, default set without them, explicit selection with them.

import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";

const base = {
  SCF_JOBS_DATABASE_URL: "postgres://scf_jobs@pgbouncer:6432/scf",
  SCF_UMAMI_RO_URL: "postgres://scf_umami_ro@pgbouncer:6432/umami",
  SCF_UMAMI_MAINT_URL: "postgres://scf_umami_maint@pgbouncer:6432/umami",
};

describe("configuration of jobs with requirements", () => {
  it("leaves out default jobs whose requirements are missing, and names them", () => {
    const c = loadConfig(base);
    expect(c.enabled).toEqual([
      "partitions",
      "retention",
      "stream_gc",
      "web_rollup",
      "durability_reconcile",
      "trust_scoring",
      "audit_verify",
    ]);
    expect(c.disabled.map((d) => d.job)).toEqual([
      "tenant_purge",
      "registry_sync",
      "contract_verification",
      "audit_anchor",
      "daily_seal",
      "onchain_correlation",
      "usage_map",
      "protocol_usage",
    ]);
  });
  it("refuses an explicitly named job without its requirements", () => {
    expect(() => loadConfig({ ...base, SCF_JOBS_ENABLED: "tenant_purge" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SCF_JOBS_ENABLED: "registry_sync" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...base,
        SCF_JOBS_ENABLED: "tenant_purge",
        SCF_ENGINE_PROXY_URL: "https://ep:8443",
        SCF_ENGINE_PROXY_PROVISIONER_CERT: "x",
      }),
    ).toThrow(/SCF_ENGINE_PROXY_CA/);
  });
  it("reads every setting of the jobs with requirements", () => {
    const c = loadConfig({
      ...base,
      SCF_ENGINE_PROXY_URL: "https://core-a:8443",
      SCF_ENGINE_PROXY_URLS: "https://core-a:8443,https://core-b:8443",
      SCF_ENGINE_PROXY_CA: "ca",
      SCF_ENGINE_PROXY_PROVISIONER_CERT: "cert",
      SCF_ENGINE_PROXY_PROVISIONER_KEY: "key",
      SCF_UMAMI_PROVISIONER_USER: "scf-provisioner",
      SCF_UMAMI_PROVISIONER_PASSWORD: "pw",
      SCF_REGISTRY_SOURCES: "stellarlight,pg_atlas",
      SCF_HORIZON_URL: "https://horizon-testnet.stellar.org",
      SCF_STELLAR_NETWORK: "testnet",
      SCF_AUDIT_ANCHOR_DIR: "/var/lib/scf/evidence",
      SCF_DURABILITY_PROMETHEUS_URL: "http://mon-c:9090",
      SCF_ONCHAIN_LEDGER_DIR: "/var/lib/scf/ledgers",
      SCF_SEAL_HORIZON_URL: "https://horizon-testnet.stellar.org",
    });
    expect(c.disabled).toEqual([]);
    expect(c.engine?.purgeUrls).toEqual(["https://core-a:8443", "https://core-b:8443"]);
    expect(c.registry.sources.map((s) => s.url)).toEqual([
      "https://stellarlight.xyz",
      "https://api.pgatlas.xyz",
    ]);
    expect(c.contracts).toMatchObject({ network: "testnet", rpcUrl: null });
    expect(c.durability).toMatchObject({ prometheusUrl: "http://mon-c:9090", canaryLagHours: 72 });
    expect(() => loadConfig({ ...base, SCF_REGISTRY_SOURCES: "lumenloop" })).toThrow(ConfigError);
  });
});
