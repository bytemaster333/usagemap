// SPDX-License-Identifier: Apache-2.0
// Configuration of the core workers that run in the JOBS service, not in the internet-facing control plane:
// edge_snapshot (builder + Ed25519 signer), umami_reconcile, domain_verification, erasure, public_metrics
// (metrics_endpoint documents and the signing of traction snapshots). Every credential that only these workers need —
// scf_jobs, scf_umami_maint, the provisioner certificate and admin password, both snapshot-signing keys — lives in the
// jobs container only. Every secret can be given as a file (`<NAME>_FILE`); values are never logged.
//
//   SCF_JOBS_DATABASE_URL           `scf` as scf_jobs through PgBouncer (required for every worker)
//   SCF_JOBS_LISTEN_DATABASE_URL    direct (non-pooled) scf_jobs connection used only for LISTEN (scf_edge, scf_umami,
//                                   scf_verify, scf_erasure, scf_snapshot); polling alone without it
//   SCF_CORE_WORKERS                comma-separated subset of edge_snapshot, umami_reconcile, domain_verification,
//                                   erasure, public_metrics (default: every worker whose requirements are met)
// edge_snapshot (wire-formats §e):
//   SCF_EDGE_SIGNING_KEY            Ed25519 PKCS#8 PEM; SCF_EDGE_SIGNING_KID (default edge-1)
//   SCF_EDGE_SNAPSHOT_INTERVAL_MS   rebuild interval (default 10000; also on NOTIFY scf_edge)
//   SCF_EDGE_SNAPSHOT_MAX_AGE_S     hard validity of an issued snapshot: payload `expires_at` = issued_at + this
//                                   (default 86400; 0 = no expires_at). An unchanged snapshot is re-issued once a
//                                   quarter of it has elapsed, so a connected node never holds one near expiry (F12)
//   SCF_PATHNORM_RULES_VERSION      default scf-path-rules/1.1.0
//   SCF_TRACKER_MANIFEST_DIR, SCF_TRACKER_RELEASES_FILE   the released tracker versions (snapshot `tracker_versions`)
// umami_reconcile (wire-formats §j.2):
//   SCF_ENGINE_PROXY_URL, SCF_ENGINE_PROXY_URLS, SCF_ENGINE_PROXY_CA
//   SCF_ENGINE_PROXY_PROVISIONER_CERT / _KEY, SCF_UMAMI_PROVISIONER_USER / _PASSWORD
//   SCF_ENGINE_PROXY_READER_CERT / _KEY  (optional: reads with a freshly rotated key)
//   SCF_UMAMI_CREDS_KEYS, SCF_UMAMI_CREDS_KEY_VERSION, SCF_UMAMI_RECONCILE_INTERVAL_MS (default 300000)
// domain_verification: SCF_DOMAIN_VERIFY_INTERVAL_MS (default 300000), SCF_VERIFIER_DNS_SERVERS
// erasure: SCF_UMAMI_MAINT_URL, SCF_ERASURE_INTERVAL_MS (60000), SCF_ERASURE_SWEEP_DELAY_MS (259200000)
// public_metrics: SCF_PORTAL_ORIGIN, SCF_PUBLIC_METRICS_INTERVAL_MS (3600000),
//   SCF_SNAPSHOT_SIGNING_KEY (Ed25519 PKCS#8 PEM, traction snapshots), SCF_SNAPSHOT_KID (snap-1),
//   SCF_SNAPSHOT_SIGN_INTERVAL_MS (default 30000; also on NOTIFY scf_snapshot), SCF_STELLAR_NETWORK (public|testnet:
//   whose verified contracts v2 snapshots count), SCF_SEAL_NETWORK (testnet|mainnet, named in v2 snapshots, C-135)

import { readFileSync } from "node:fs";
import { parseCredsKeys, type UmamiCredsKeys } from "../config.ts";
import { type SealNetworkName, sealNetworkName } from "../programme/seal-network.ts";

export const CORE_WORKERS = [
  "edge_snapshot",
  "umami_reconcile",
  "domain_verification",
  "erasure",
  "public_metrics",
] as const;
export type CoreWorker = (typeof CORE_WORKERS)[number];

export interface WorkerConfig {
  jobsDatabaseUrl: string;
  listenDatabaseUrl: string | undefined;
  /** Workers asked for explicitly (SCF_CORE_WORKERS); undefined = every configured one. */
  only: CoreWorker[] | undefined;
  edge: {
    signingKeyPem: string | undefined;
    kid: string;
    intervalMs: number;
    maxAgeS: number;
    pathnormRulesVersion: string;
    trackerManifestDir: string | undefined;
    trackerReleasesFile: string | undefined;
  };
  engine:
    | {
        url: string;
        urls: string[];
        ca: string;
        provisioner: { cert: string; key: string; user: string; password: string } | undefined;
        reader: { cert: string; key: string } | undefined;
      }
    | undefined;
  umami: { credsKeys: UmamiCredsKeys | undefined; reconcileIntervalMs: number };
  verifier: { intervalMs: number; dnsServers: string[] | undefined };
  erasure: { umamiMaintUrl: string | undefined; intervalMs: number; sweepDelayMs: number };
  programme: {
    portalOrigin: string | undefined;
    publicMetricsIntervalMs: number;
    snapshotSigningKeyPem: string | undefined;
    snapshotKid: string;
    signIntervalMs: number;
    /** SCF_STELLAR_NETWORK: the deployment's network, whose verified contracts v2 snapshots count (default public). */
    onchainNetwork: "public" | "testnet";
    /** SCF_SEAL_NETWORK: the daily seal's network named in v2 snapshots (default testnet, C-135). */
    sealNetwork: SealNetworkName;
  };
}

type Env = Record<string, string | undefined>;

function get(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

function req(env: Env, name: string): string {
  const v = get(env, name);
  if (v === undefined) throw new Error(`missing required configuration ${name}`);
  return v;
}

function int(env: Env, name: string, dflt: number): number {
  const v = get(env, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function list(v: string | undefined): string[] | undefined {
  const items = (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function onchainNetwork(v: string | undefined): "public" | "testnet" {
  if (v === undefined || v === "public") return "public";
  if (v === "testnet") return "testnet";
  throw new Error("SCF_STELLAR_NETWORK must be public or testnet");
}

/** Undefined when SCF_JOBS_DATABASE_URL is not set: then no core worker runs in this process. */
export function loadWorkerConfig(env: Env = process.env): WorkerConfig | undefined {
  const jobsDatabaseUrl = get(env, "SCF_JOBS_DATABASE_URL");
  if (!jobsDatabaseUrl) return undefined;
  const only = list(get(env, "SCF_CORE_WORKERS"));
  if (only?.some((w) => !(CORE_WORKERS as readonly string[]).includes(w)))
    throw new Error(`SCF_CORE_WORKERS: unknown worker (known: ${CORE_WORKERS.join(", ")})`);
  const engineUrl = get(env, "SCF_ENGINE_PROXY_URL");
  const provCert = get(env, "SCF_ENGINE_PROXY_PROVISIONER_CERT");
  const readerCert = get(env, "SCF_ENGINE_PROXY_READER_CERT");
  const kid = get(env, "SCF_SNAPSHOT_KID") ?? "snap-1";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid))
    throw new Error("SCF_SNAPSHOT_KID is not a valid key id");
  const portal = get(env, "SCF_PORTAL_ORIGIN");
  return {
    jobsDatabaseUrl,
    listenDatabaseUrl: get(env, "SCF_JOBS_LISTEN_DATABASE_URL"),
    only: only as CoreWorker[] | undefined,
    edge: {
      signingKeyPem: get(env, "SCF_EDGE_SIGNING_KEY"),
      kid: get(env, "SCF_EDGE_SIGNING_KID") ?? "edge-1",
      intervalMs: int(env, "SCF_EDGE_SNAPSHOT_INTERVAL_MS", 10_000),
      maxAgeS: int(env, "SCF_EDGE_SNAPSHOT_MAX_AGE_S", 86_400),
      pathnormRulesVersion: get(env, "SCF_PATHNORM_RULES_VERSION") ?? "scf-path-rules/1.1.0",
      trackerManifestDir: get(env, "SCF_TRACKER_MANIFEST_DIR"),
      trackerReleasesFile: get(env, "SCF_TRACKER_RELEASES_FILE"),
    },
    engine: engineUrl
      ? {
          url: engineUrl,
          urls: list(get(env, "SCF_ENGINE_PROXY_URLS")) ?? [engineUrl],
          ca: req(env, "SCF_ENGINE_PROXY_CA"),
          provisioner: provCert
            ? {
                cert: provCert,
                key: req(env, "SCF_ENGINE_PROXY_PROVISIONER_KEY"),
                user: req(env, "SCF_UMAMI_PROVISIONER_USER"),
                password: req(env, "SCF_UMAMI_PROVISIONER_PASSWORD"),
              }
            : undefined,
          reader: readerCert
            ? { cert: readerCert, key: req(env, "SCF_ENGINE_PROXY_READER_KEY") }
            : undefined,
        }
      : undefined,
    umami: {
      credsKeys: parseCredsKeys(
        get(env, "SCF_UMAMI_CREDS_KEYS"),
        get(env, "SCF_UMAMI_CREDS_KEY_VERSION"),
      ),
      reconcileIntervalMs: int(env, "SCF_UMAMI_RECONCILE_INTERVAL_MS", 300_000),
    },
    verifier: {
      intervalMs: int(env, "SCF_DOMAIN_VERIFY_INTERVAL_MS", 300_000),
      dnsServers: list(get(env, "SCF_VERIFIER_DNS_SERVERS")),
    },
    erasure: {
      umamiMaintUrl: get(env, "SCF_UMAMI_MAINT_URL"),
      intervalMs: int(env, "SCF_ERASURE_INTERVAL_MS", 60_000),
      sweepDelayMs: int(env, "SCF_ERASURE_SWEEP_DELAY_MS", 72 * 3_600_000),
    },
    programme: {
      portalOrigin: portal ? new URL(portal).origin : undefined,
      publicMetricsIntervalMs: int(env, "SCF_PUBLIC_METRICS_INTERVAL_MS", 3_600_000),
      snapshotSigningKeyPem: get(env, "SCF_SNAPSHOT_SIGNING_KEY"),
      snapshotKid: kid,
      signIntervalMs: int(env, "SCF_SNAPSHOT_SIGN_INTERVAL_MS", 30_000),
      onchainNetwork: onchainNetwork(get(env, "SCF_STELLAR_NETWORK")),
      sealNetwork: sealNetworkName(get(env, "SCF_SEAL_NETWORK")),
    },
  };
}

/** Which workers can run with this configuration, and why the others cannot (logged, no values). */
export function plannedWorkers(c: WorkerConfig): {
  run: CoreWorker[];
  missing: Record<string, string>;
} {
  const missing: Record<string, string> = {};
  if (!c.edge.signingKeyPem) missing.edge_snapshot = "SCF_EDGE_SIGNING_KEY";
  if (!c.engine?.provisioner || !c.umami.credsKeys)
    missing.umami_reconcile =
      "SCF_ENGINE_PROXY_URL, the provisioner certificate and password, SCF_UMAMI_CREDS_KEYS";
  if (!c.erasure.umamiMaintUrl) missing.erasure = "SCF_UMAMI_MAINT_URL";
  if (!c.programme.portalOrigin) missing.public_metrics = "SCF_PORTAL_ORIGIN";
  const wanted = c.only ?? [...CORE_WORKERS];
  if (c.only) {
    const bad = c.only.filter((w) => missing[w]);
    if (bad.length > 0)
      throw new Error(
        `SCF_CORE_WORKERS names ${bad.join(", ")} without its configuration (${bad.map((w) => missing[w]).join("; ")})`,
      );
  }
  return { run: wanted.filter((w) => !missing[w]), missing };
}
