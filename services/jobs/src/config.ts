// SPDX-License-Identifier: Apache-2.0
// Configuration from the environment. Every secret can also be given as a file (`<NAME>_FILE`), which is how Compose
// and SOPS-decrypted deployments pass them; values are never logged.
//
// Databases (data-model §3, §16; C-115: runtime roles reach PostgreSQL only through PgBouncer in transaction mode):
//   SCF_JOBS_DATABASE_URL[_FILE]   database `scf` as role scf_jobs, through PgBouncer
//   SCF_JOBS_DB_PASSWORD_FILE      optional: password of scf_jobs, overrides the one in the URL
//   SCF_UMAMI_RO_URL[_FILE]        database `umami` as role scf_umami_ro (job web_rollup reads the scf_ro views only)
//   SCF_UMAMI_RO_PASSWORD_FILE     optional: its password
//   SCF_UMAMI_MAINT_URL[_FILE]     database `umami` as role scf_umami_maint (job retention, DELETE only, §16.1)
//   SCF_UMAMI_MAINT_PASSWORD_FILE  optional: its password
// Listener:
//   SCF_JOBS_LISTEN_HOST (default 0.0.0.0), SCF_JOBS_PORT (default 8080): GET /healthz, /readyz, /metrics
// Jobs:
//   SCF_JOBS_ENABLED               comma-separated job names (default: all of this service)
//   SCF_JOBS_RUN_ON_START          run every enabled job once at start (default true)
//   SCF_JOBS_HOURLY_MINUTE         minute of the hourly runs (default 5; web_rollup runs at +5 of it)
//   SCF_WEB_ROLLUP_DAILY_AT        HH:MM UTC of the daily D-1…D-4 rollup (D-4 final) (default 01:30, data-model §6.3)
//   SCF_STREAM_GC_DAILY_AT         HH:MM UTC of stream_gc (default 03:30)
//   SCF_ENGINE_VERSION             stamped on web_daily_totals rows (default umami/3.5.0)
//   SCF_JOBS_SHUTDOWN_GRACE_MS     how long a running job may take to stop at SIGTERM (default 30000)
//   SCF_JOBS_NODE                  node name for logs (default: hostname), pattern ^[a-z0-9][a-z0-9-]{1,31}$
// Jobs with requirements (each needs the variables listed in README §Configuration; when SCF_JOBS_ENABLED is not set, a job whose
// requirements are missing is left out with a warning, when it is named explicitly a missing requirement is an error):
//   tenant_purge          SCF_ENGINE_PROXY_URL, SCF_ENGINE_PROXY_URLS, SCF_ENGINE_PROXY_CA,
//                         SCF_ENGINE_PROXY_PROVISIONER_CERT/_KEY, SCF_UMAMI_PROVISIONER_USER/_PASSWORD (all [_FILE])
//   durability_reconcile  — (canary check: SCF_DURABILITY_PROMETHEUS_URL and SCF_UMAMI_RO_URL)
//   registry_sync         SCF_REGISTRY_SOURCES (stellarlight,pg_atlas), SCF_REGISTRY_<SOURCE>_URL
//   contract_verification SCF_HORIZON_URL, SCF_STELLAR_NETWORK (admin check: SCF_STELLAR_RPC_URL)
//   trust_scoring         —
//   audit_anchor          SCF_AUDIT_ANCHOR_DIR (file publisher; SCF_AUDIT_ANCHOR_STELLAR_* is no longer read, C-136)
//   audit_verify          —
//   daily_seal            SCF_SEAL_HORIZON_URL, SCF_AUDIT_ANCHOR_DIR (reads the anchor documents); optional
//                         SCF_SEAL_NETWORK (testnet | mainnet, default testnet), SCF_SEAL_NETWORK_PASSPHRASE,
//                         SCF_SEAL_RPC_URL, SCF_SEAL_FRIENDBOT_URL (testnet only), SCF_SEAL_SECRET_FILE (without a key the
//                         days are built but not submitted), SCF_SEAL_MAINNET_APPROVED=1 (required for mainnet, C-135),
//                         SCF_SEAL_DAILY_AT (00:30), SCF_SEAL_FEE_STROOPS (100)
//   onchain_correlation   SCF_ONCHAIN_LEDGER_DIR (local mirror of public ledger data files, C-128), SCF_STELLAR_NETWORK;
//                         optional SCF_ONCHAIN_READER_BIN, SCF_ONCHAIN_DAILY_AT, SCF_ONCHAIN_LOOKBACK_DAYS,
//                         SCF_ONCHAIN_READER_TIMEOUT_S; the fetch step (wire-formats §p.1): SCF_ONCHAIN_LEDGER_SOURCE_URL
//                         (default: the AWS Open Data pubnet store on `public`; none on testnet; `none` turns it off),
//                         SCF_ONCHAIN_FETCH_TIMEOUT_S (21600); the fetch covers the days the count still needs;
//                         the day-anchor check (C-144): SCF_ONCHAIN_HORIZON_URL (default SCF_HORIZON_URL) — without
//                         a Horizon the job is disabled, unless SCF_ONCHAIN_LEDGER_HASH_CHECK=off on testnet (the
//                         synthetic development lake has no network to compare with; refused on public)
//   usage_map             the same requirements and mirror as onchain_correlation (Ecosystem Usage Map, migration 0075);
//                         optional SCF_USAGE_MAP_DAILY_AT (07:30), SCF_USAGE_MAP_LOOKBACK_DAYS (7, at most 7: the
//                         mirror keeps 7 days), SCF_USAGE_MAP_READER_TIMEOUT_S (14400: a weekly run reads 7 days)
//   protocol_usage        the same requirements and mirror as onchain_correlation (protocol interactions, migration
//                         0082); optional SCF_PROTOCOL_USAGE_DAILY_AT (07:45), SCF_PROTOCOL_USAGE_LOOKBACK_DAYS (3, at
//                         most 7), SCF_PROTOCOL_USAGE_READER_TIMEOUT_S (7200)

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export const ALL_JOBS = [
  "partitions",
  "retention",
  "stream_gc",
  "web_rollup",
  "tenant_purge",
  "durability_reconcile",
  "registry_sync",
  "contract_verification",
  "trust_scoring",
  "audit_anchor",
  "audit_verify",
  "daily_seal",
  "onchain_correlation",
  "usage_map",
  "protocol_usage",
] as const;
export type JobName = (typeof ALL_JOBS)[number];

/** Jobs that are left out of the default set (not an error) when their requirements are missing. */
const OPTIONAL_BY_DEFAULT: readonly JobName[] = [
  "tenant_purge",
  "registry_sync",
  "contract_verification",
  "audit_anchor",
  "daily_seal",
  "onchain_correlation",
  "usage_map",
  "protocol_usage",
];

export type RegistrySource = "stellarlight" | "pg_atlas";

export interface EngineSettings {
  url: string;
  purgeUrls: string[];
  ca: string;
  cert: string;
  key: string;
  user: string;
  password: string;
}

export interface SealSettings {
  network: "testnet" | "mainnet";
  passphrase: string;
  horizonUrl: string;
  rpcUrl: string | null;
  /** testnet only (re-funds the sealing account after a reset, C-137). */
  friendbotUrl: string | null;
  /** Ed25519 seed of the sealing account (S…), from SCF_SEAL_SECRET_FILE; never logged. Null: build only. */
  secretSeed: string | null;
  dailyAt: HM;
  feeStroops: number;
}

type HM = { hour: number; minute: number };

export interface Config {
  scfUrl: string;
  umamiRoUrl: string;
  umamiMaintUrl: string;
  listenHost: string;
  port: number;
  enabled: JobName[];
  runOnStart: boolean;
  hourlyMinute: number;
  rollupDailyAt: { hour: number; minute: number };
  streamGcDailyAt: { hour: number; minute: number };
  engineVersion: string;
  shutdownGraceMs: number;
  node: string;
  /** Default-enabled jobs left out because their requirements are missing (logged at start). */
  disabled: { job: JobName; missing: string }[];
  engine: EngineSettings | null;
  durability: { dailyAt: HM; prometheusUrl: string | null; canaryLagHours: number };
  registry: {
    dailyAt: HM;
    sources: { source: RegistrySource; url: string }[];
    maxDropShare: number;
  };
  contracts: {
    dailyAt: HM;
    horizonUrl: string;
    rpcUrl: string | null;
    network: "public" | "testnet";
  };
  trust: { dailyAt: HM };
  anchor: { dailyAt: HM; dir: string | null };
  seal: SealSettings | null;
  /** Variables that are set but no longer read (logged once at start). */
  ignored: string[];
  auditVerifyDailyAt: HM;
  onchain: OnchainSettings | null;
  /** Job usage_map: reuses `onchain` (mirror, reader, network, fetch, Horizon); null without it. */
  usageMap: { dailyAt: HM; lookbackDays: number; timeoutMs: number } | null;
  /** Job protocol_usage (I1, migration 0082): reuses `onchain`; null without it. */
  protocolUsage: { dailyAt: HM; lookbackDays: number; timeoutMs: number } | null;
}

export interface OnchainSettings {
  /** Absolute path of the read-only mirror of ledger data files (Galexie layout). */
  ledgerDir: string;
  readerBin: string;
  network: "public" | "testnet";
  dailyAt: HM;
  /** Days before today that are (re)tried while a contract still lacks a row (C-128: complete days only). */
  lookbackDays: number;
  timeoutMs: number;
  /** Fetch step (wire-formats §p.1): the public ledger-data store, or null when the mirror is filled elsewhere. */
  sourceUrl: string | null;
  fetchTimeoutMs: number;
  /**
   * Horizon whose `/ledgers/{seq}` hash each complete day's anchor is compared with before the day is used (C-144);
   * null only with SCF_ONCHAIN_LEDGER_HASH_CHECK=off on testnet.
   */
  horizonUrl: string | null;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function fromFile(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

function dbUrl(env: Env, urlName: string, passwordName: string, required: boolean): string {
  const raw = fromFile(env, urlName);
  if (!raw) {
    if (required) throw new ConfigError(`${urlName} is required`);
    return "";
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${urlName} is not a URL`);
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new ConfigError(`${urlName} must be a postgres:// URL`);
  }
  const pwFile = env[`${passwordName}_FILE`];
  if (pwFile) u.password = encodeURIComponent(readFileSync(pwFile, "utf8").replace(/\r?\n$/, ""));
  return u.toString();
}

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer in ${min}..${max}`);
  }
  return n;
}

function hhmm(env: Env, name: string, def: string): { hour: number; minute: number } {
  const v = env[name] || def;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) throw new ConfigError(`${name} must be HH:MM (UTC)`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

function engine(env: Env): EngineSettings | null {
  const url = fromFile(env, "SCF_ENGINE_PROXY_URL");
  const cert = fromFile(env, "SCF_ENGINE_PROXY_PROVISIONER_CERT");
  if (!url || !cert) return null;
  const need = (n: string): string => {
    const v = fromFile(env, n);
    if (!v) throw new ConfigError(`${n} is required with SCF_ENGINE_PROXY_PROVISIONER_CERT`);
    return v;
  };
  const urls = (fromFile(env, "SCF_ENGINE_PROXY_URLS") ?? url)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const u of [url, ...urls]) {
    if (!/^https:\/\/[^/?#\s]+\/?$/.test(u)) {
      throw new ConfigError("SCF_ENGINE_PROXY_URL(S) must be https origins");
    }
  }
  return {
    url,
    purgeUrls: urls,
    ca: need("SCF_ENGINE_PROXY_CA"),
    cert,
    key: need("SCF_ENGINE_PROXY_PROVISIONER_KEY"),
    user: need("SCF_UMAMI_PROVISIONER_USER"),
    password: need("SCF_UMAMI_PROVISIONER_PASSWORD"),
  };
}

function httpUrl(env: Env, name: string, def: string | null): string | null {
  const v = fromFile(env, name) ?? def;
  if (v === null) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new ConfigError(`${name} must be http(s)`);
  return v.replace(/\/+$/, "");
}

function network(env: Env): "public" | "testnet" {
  const v = env.SCF_STELLAR_NETWORK || "public";
  if (v !== "public" && v !== "testnet")
    throw new ConfigError("SCF_STELLAR_NETWORK must be public or testnet");
  return v;
}

export const SEAL_PASSPHRASE = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

/** AWS Open Data store of mainnet ledger metadata (references/stellar-facts-check-2026-11-16.md F4). */
export const DEFAULT_LEDGER_SOURCE_PUBNET =
  "https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/pubnet";

function httpsUrl(env: Env, name: string, def: string | null): string | null {
  const v = httpUrl(env, name, def);
  if (v !== null && !v.startsWith("https://")) throw new ConfigError(`${name} must be https`);
  return v;
}

/**
 * The sealing network (C-135): named by SCF_SEAL_NETWORK and/or SCF_SEAL_NETWORK_PASSPHRASE, which
 * must agree; a passphrase alone decides the network (so the mainnet passphrase is mainnet, with its approval gate);
 * only the two public networks are accepted. Horizon, RPC and friendbot are https only.
 */
function seal(env: Env): SealSettings | null {
  const horizonUrl = httpsUrl(env, "SCF_SEAL_HORIZON_URL", null);
  if (!horizonUrl) return null;
  const named = env.SCF_SEAL_NETWORK || null;
  if (named !== null && named !== "testnet" && named !== "mainnet")
    throw new ConfigError("SCF_SEAL_NETWORK must be testnet or mainnet");
  const pass = env.SCF_SEAL_NETWORK_PASSPHRASE || null;
  let fromPass: "testnet" | "mainnet" | null = null;
  if (pass !== null) {
    if (pass === SEAL_PASSPHRASE.testnet) fromPass = "testnet";
    else if (pass === SEAL_PASSPHRASE.mainnet) fromPass = "mainnet";
    else
      throw new ConfigError(
        "SCF_SEAL_NETWORK_PASSPHRASE must be the testnet or the mainnet passphrase",
      );
  }
  if (named !== null && fromPass !== null && named !== fromPass)
    throw new ConfigError("SCF_SEAL_NETWORK_PASSPHRASE does not match SCF_SEAL_NETWORK");
  const network = named ?? fromPass ?? "testnet";
  if (network === "mainnet" && env.SCF_SEAL_MAINNET_APPROVED !== "1") {
    throw new ConfigError("a mainnet seal needs SCF_SEAL_MAINNET_APPROVED=1 (C-135)");
  }
  const passphrase = SEAL_PASSPHRASE[network];
  const friendbotSet = Boolean(env.SCF_SEAL_FRIENDBOT_URL);
  if (network === "mainnet" && friendbotSet)
    throw new ConfigError("SCF_SEAL_FRIENDBOT_URL is for testnet only");
  const friendbotUrl =
    network === "testnet"
      ? httpsUrl(env, "SCF_SEAL_FRIENDBOT_URL", "https://friendbot.stellar.org")
      : null;
  let secretSeed: string | null = null;
  const secretFile = env.SCF_SEAL_SECRET_FILE;
  if (secretFile) {
    secretSeed = readFileSync(secretFile, "utf8").trim();
    if (!/^S[A-Z2-7]{55}$/.test(secretSeed))
      throw new ConfigError("SCF_SEAL_SECRET_FILE does not hold a Stellar secret seed");
  }
  return {
    network,
    passphrase,
    horizonUrl,
    rpcUrl: httpsUrl(env, "SCF_SEAL_RPC_URL", null),
    friendbotUrl,
    secretSeed,
    dailyAt: hhmm(env, "SCF_SEAL_DAILY_AT", "00:30"),
    feeStroops: int(env, "SCF_SEAL_FEE_STROOPS", 100, 100, 10_000_000),
  };
}

const REGISTRY_DEFAULT_URL: Record<RegistrySource, string> = {
  stellarlight: "https://stellarlight.xyz",
  pg_atlas: "https://api.pgatlas.xyz",
};

export function loadConfig(env: Env = process.env): Config {
  const enabledRaw = env.SCF_JOBS_ENABLED?.trim();
  const explicit = Boolean(enabledRaw);
  let enabled = (
    enabledRaw ? enabledRaw.split(",").map((s) => s.trim()) : [...ALL_JOBS]
  ) as JobName[];
  for (const j of enabled) {
    if (!(ALL_JOBS as readonly string[]).includes(j)) {
      throw new ConfigError(`SCF_JOBS_ENABLED: unknown job ${JSON.stringify(j).slice(0, 40)}`);
    }
  }
  const needsUmamiRo =
    enabled.includes("web_rollup") ||
    (enabled.includes("durability_reconcile") && Boolean(env.SCF_DURABILITY_PROMETHEUS_URL));
  const needsUmamiMaint = enabled.includes("retention");
  const nodeRaw = (env.SCF_JOBS_NODE || hostname()).toLowerCase();
  const node = NODE_NAME_RE.test(nodeRaw) ? nodeRaw : "jobs";
  const runOnStart = (env.SCF_JOBS_RUN_ON_START ?? "true").toLowerCase();
  if (runOnStart !== "true" && runOnStart !== "false") {
    throw new ConfigError("SCF_JOBS_RUN_ON_START must be true or false");
  }
  const engineVersion = env.SCF_ENGINE_VERSION || "umami/3.5.0";
  if (!/^[a-z]+\/\d+\.\d+\.\d+$/.test(engineVersion)) {
    throw new ConfigError("SCF_ENGINE_VERSION must look like umami/3.5.0");
  }
  const eng = engine(env);
  const sourcesRaw = env.SCF_REGISTRY_SOURCES?.trim() ?? "";
  const sources = sourcesRaw
    ? sourcesRaw.split(",").map((x) => {
        const s = x.trim();
        if (s !== "stellarlight" && s !== "pg_atlas") {
          throw new ConfigError("SCF_REGISTRY_SOURCES: stellarlight and/or pg_atlas");
        }
        const url = httpUrl(env, `SCF_REGISTRY_${s.toUpperCase()}_URL`, REGISTRY_DEFAULT_URL[s]);
        return { source: s as RegistrySource, url: url as string };
      })
    : [];
  const horizonUrl = httpUrl(env, "SCF_HORIZON_URL", null);
  const anchorDir = fromFile(env, "SCF_AUDIT_ANCHOR_DIR") ?? null;
  const ledgerDir = env.SCF_ONCHAIN_LEDGER_DIR?.trim() || null;
  if (ledgerDir && !ledgerDir.startsWith("/")) {
    throw new ConfigError("SCF_ONCHAIN_LEDGER_DIR must be an absolute path");
  }
  const readerBin = env.SCF_ONCHAIN_READER_BIN?.trim() || "/usr/local/bin/onchain-reader";
  if (!readerBin.startsWith("/"))
    throw new ConfigError("SCF_ONCHAIN_READER_BIN must be an absolute path");
  let onchain: OnchainSettings | null = null;
  let onchainMissing: string | undefined = ledgerDir ? undefined : "SCF_ONCHAIN_LEDGER_DIR";
  if (ledgerDir) {
    const net = network(env);
    const hashCheck = env.SCF_ONCHAIN_LEDGER_HASH_CHECK?.trim() || "on";
    if (hashCheck !== "on" && hashCheck !== "off")
      throw new ConfigError("SCF_ONCHAIN_LEDGER_HASH_CHECK must be on or off");
    if (hashCheck === "off" && net !== "testnet")
      throw new ConfigError(
        "SCF_ONCHAIN_LEDGER_HASH_CHECK=off is accepted on testnet only (a public deployment always compares day anchors with Horizon)",
      );
    const onchainHorizon =
      hashCheck === "off" ? null : httpUrl(env, "SCF_ONCHAIN_HORIZON_URL", horizonUrl);
    if (hashCheck === "on" && !onchainHorizon)
      onchainMissing = "SCF_ONCHAIN_HORIZON_URL|SCF_HORIZON_URL";
    const rawSource = env.SCF_ONCHAIN_LEDGER_SOURCE_URL?.trim();
    const sourceUrl =
      rawSource === "none"
        ? null
        : rawSource
          ? (httpUrl(env, "SCF_ONCHAIN_LEDGER_SOURCE_URL", null) as string)
          : net === "public"
            ? DEFAULT_LEDGER_SOURCE_PUBNET
            : null;
    if (sourceUrl && !sourceUrl.startsWith("https://"))
      throw new ConfigError("SCF_ONCHAIN_LEDGER_SOURCE_URL must be https (wire-formats §p.1)");
    onchain = {
      ledgerDir,
      readerBin,
      network: net,
      dailyAt: hhmm(env, "SCF_ONCHAIN_DAILY_AT", "06:00"),
      lookbackDays: int(env, "SCF_ONCHAIN_LOOKBACK_DAYS", 3, 1, 30),
      timeoutMs: int(env, "SCF_ONCHAIN_READER_TIMEOUT_S", 3600, 10, 86_400) * 1000,
      sourceUrl,
      fetchTimeoutMs: int(env, "SCF_ONCHAIN_FETCH_TIMEOUT_S", 6 * 3600, 10, 86_400) * 1000,
      horizonUrl: onchainHorizon,
    };
  }
  // C-136: the manage_data anchor publisher is withdrawn; its variables are no longer read (only their presence noted).
  const ignored = [
    "SCF_AUDIT_ANCHOR_STELLAR_SECRET",
    "SCF_AUDIT_ANCHOR_STELLAR_SECRET_FILE",
    "SCF_AUDIT_ANCHOR_STELLAR_HORIZON_URL",
  ].filter((n) => Boolean(env[n]));
  const sealCfg = seal(env);
  const missing: Partial<Record<JobName, string | undefined>> = {
    tenant_purge: eng ? undefined : "SCF_ENGINE_PROXY_URL+SCF_ENGINE_PROXY_PROVISIONER_CERT",
    registry_sync: sources.length > 0 ? undefined : "SCF_REGISTRY_SOURCES",
    contract_verification: horizonUrl ? undefined : "SCF_HORIZON_URL",
    audit_anchor: anchorDir ? undefined : "SCF_AUDIT_ANCHOR_DIR",
    daily_seal: !sealCfg ? "SCF_SEAL_HORIZON_URL" : anchorDir ? undefined : "SCF_AUDIT_ANCHOR_DIR",
    onchain_correlation: onchainMissing,
    usage_map: onchainMissing,
    protocol_usage: onchainMissing,
  };
  const disabled: Config["disabled"] = [];
  for (const job of OPTIONAL_BY_DEFAULT) {
    const m = missing[job];
    if (!m || !enabled.includes(job)) continue;
    if (explicit) throw new ConfigError(`${job} needs ${m}`);
    disabled.push({ job, missing: m });
  }
  enabled = enabled.filter((j) => !disabled.some((d) => d.job === j));
  const durabilityProm = httpUrl(env, "SCF_DURABILITY_PROMETHEUS_URL", null);
  return {
    disabled,
    engine: eng,
    durability: {
      dailyAt: hhmm(env, "SCF_DURABILITY_DAILY_AT", "02:00"),
      prometheusUrl: durabilityProm,
      canaryLagHours: int(env, "SCF_DURABILITY_CANARY_LAG_HOURS", 72, 0, 168),
    },
    registry: {
      dailyAt: hhmm(env, "SCF_REGISTRY_SYNC_DAILY_AT", "04:00"),
      sources,
      maxDropShare: int(env, "SCF_REGISTRY_MAX_DROP_PERCENT", 20, 1, 100) / 100,
    },
    contracts: {
      dailyAt: hhmm(env, "SCF_CONTRACT_VERIFICATION_DAILY_AT", "05:00"),
      horizonUrl: horizonUrl ?? "",
      rpcUrl: httpUrl(env, "SCF_STELLAR_RPC_URL", null),
      network: network(env),
    },
    trust: { dailyAt: hhmm(env, "SCF_TRUST_SCORING_DAILY_AT", "03:00") },
    anchor: { dailyAt: hhmm(env, "SCF_AUDIT_ANCHOR_DAILY_AT", "00:15"), dir: anchorDir },
    seal: sealCfg,
    ignored,
    auditVerifyDailyAt: hhmm(env, "SCF_AUDIT_VERIFY_DAILY_AT", "00:45"),
    onchain,
    usageMap: onchain
      ? {
          dailyAt: hhmm(env, "SCF_USAGE_MAP_DAILY_AT", "07:30"),
          lookbackDays: int(env, "SCF_USAGE_MAP_LOOKBACK_DAYS", 7, 1, 7),
          timeoutMs: int(env, "SCF_USAGE_MAP_READER_TIMEOUT_S", 4 * 3600, 10, 86_400) * 1000,
        }
      : null,
    protocolUsage: onchain
      ? {
          dailyAt: hhmm(env, "SCF_PROTOCOL_USAGE_DAILY_AT", "07:45"),
          lookbackDays: int(env, "SCF_PROTOCOL_USAGE_LOOKBACK_DAYS", 3, 1, 7),
          timeoutMs: int(env, "SCF_PROTOCOL_USAGE_READER_TIMEOUT_S", 2 * 3600, 10, 86_400) * 1000,
        }
      : null,
    scfUrl: dbUrl(env, "SCF_JOBS_DATABASE_URL", "SCF_JOBS_DB_PASSWORD", true),
    umamiRoUrl: dbUrl(env, "SCF_UMAMI_RO_URL", "SCF_UMAMI_RO_PASSWORD", needsUmamiRo),
    umamiMaintUrl: dbUrl(env, "SCF_UMAMI_MAINT_URL", "SCF_UMAMI_MAINT_PASSWORD", needsUmamiMaint),
    listenHost: env.SCF_JOBS_LISTEN_HOST || "0.0.0.0",
    port: int(env, "SCF_JOBS_PORT", 8080, 0, 65535),
    enabled: [...new Set(enabled)],
    runOnStart: runOnStart === "true",
    hourlyMinute: int(env, "SCF_JOBS_HOURLY_MINUTE", 5, 0, 54),
    rollupDailyAt: hhmm(env, "SCF_WEB_ROLLUP_DAILY_AT", "01:30"),
    streamGcDailyAt: hhmm(env, "SCF_STREAM_GC_DAILY_AT", "03:30"),
    engineVersion,
    shutdownGraceMs: int(env, "SCF_JOBS_SHUTDOWN_GRACE_MS", 30_000, 0, 600_000),
    node,
  };
}
