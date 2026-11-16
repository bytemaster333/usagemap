// SPDX-License-Identifier: Apache-2.0
// Wires configuration, pools, the runner with its jobs and the health listener. Used by main.ts and by the tests.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import {
  type AnchorPublisher,
  auditAnchorJob,
  auditVerifyJob,
  FilePublisher,
} from "./audit/anchor.ts";
import type { Config } from "./config.ts";
import { startWorkers, workerMetricsText } from "./core-workers.ts";
import { createPool, ScfDb, UmamiDb } from "./db.ts";
import { AdapterEnginePurger } from "./engine.ts";
import { createHttpServer } from "./http.ts";
import { contractVerificationJob } from "./jobs/contract-verification.ts";
import { durabilityJob, PrometheusCanarySource } from "./jobs/durability.ts";
import { onchainCorrelationJob } from "./jobs/onchain-correlation.ts";
import { partitionsJob } from "./jobs/partitions.ts";
import { protocolUsageJob } from "./jobs/protocol-usage.ts";
import { retentionJob, streamGcJob } from "./jobs/retention.ts";
import { tenantPurgeJob } from "./jobs/tenant-purge.ts";
import { trustScoringJob } from "./jobs/trust-scoring.ts";
import { usageMapJob } from "./jobs/usage-map.ts";
import { webRollupJob } from "./jobs/web-rollup.ts";
import { AdvisoryLocker, FenceRegistry, type Locker } from "./lock.ts";
import { createLogger, errorFields, type Logger } from "./log.ts";
import { jobMetrics, Registry } from "./metrics.ts";
import { HorizonLedgerHashes } from "./onchain/ledger-hashes.ts";
import { LedgerProtocolReader } from "./onchain/protocols/reader.ts";
import { LedgerFileFetcher, LedgerFileReader } from "./onchain/reader.ts";
import { LedgerUsageReader } from "./onchain/usage.ts";
import { PgAtlasSource, StellarlightSource } from "./registry/sources.ts";
import { registrySyncJob } from "./registry/sync.ts";
import { Runner } from "./runner.ts";
import { dailySealJob } from "./seal/daily-seal.ts";
import { HorizonSealLedger } from "./seal/horizon.ts";
import { HorizonRpcLedger } from "./stellar/ledger.ts";

export interface App {
  runner: Runner;
  /** Starts the control plane's former in-process workers (F16) when configured. */
  startCoreWorkers(): Promise<void>;
  server: Server;
  registry: Registry;
  log: Logger;
  listen(): Promise<number>;
  stop(): Promise<void>;
}

export function buildApp(
  cfg: Config,
  opts: { log?: Logger; locker?: Locker; clock?: () => Date } = {},
): App {
  const log = opts.log ?? createLogger({ service: "jobs", node: cfg.node });
  const registry = new Registry();
  const metrics = jobMetrics(registry);
  const pools: pg.Pool[] = [];
  const scfPool = createPool({ connectionString: cfg.scfUrl, max: 3, applicationName: "scf-jobs" });
  pools.push(scfPool);
  // One registry: the locker records each run's lock, every scf transaction of that job checks it.
  const fences = new FenceRegistry();
  const scf = new ScfDb(scfPool, fences);
  let umamiRo: UmamiDb | null = null;
  let umamiMaint: UmamiDb | null = null;
  if (cfg.umamiRoUrl) {
    const p = createPool({
      connectionString: cfg.umamiRoUrl,
      max: 2,
      applicationName: "scf-jobs-rollup",
    });
    pools.push(p);
    umamiRo = new UmamiDb(p);
  }
  if (cfg.umamiMaintUrl) {
    const p = createPool({
      connectionString: cfg.umamiMaintUrl,
      max: 1,
      applicationName: "scf-jobs-retention",
    });
    pools.push(p);
    umamiMaint = new UmamiDb(p);
  }

  const runner = new Runner({
    locker:
      opts.locker ?? new AdvisoryLocker(cfg.scfUrl, { applicationName: "scf-jobs-lock", fences }),
    log,
    metrics,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  for (const name of cfg.enabled) {
    switch (name) {
      case "partitions":
        runner.register(partitionsJob(scf, cfg.hourlyMinute));
        break;
      case "retention":
        runner.register(retentionJob(scf, umamiMaint, (cfg.hourlyMinute + 20) % 60));
        break;
      case "stream_gc":
        runner.register(streamGcJob(scf, cfg.streamGcDailyAt));
        break;
      case "web_rollup":
        if (!umamiRo) throw new Error("web_rollup needs SCF_UMAMI_RO_URL");
        runner.register(
          webRollupJob(scf, umamiRo, {
            engineVersion: cfg.engineVersion,
            hourlyMinute: cfg.hourlyMinute,
            dailyAt: cfg.rollupDailyAt,
          }),
        );
        break;
      case "tenant_purge":
        runner.register(
          tenantPurgeJob(
            scf,
            cfg.engine ? new AdapterEnginePurger(cfg.engine) : null,
            (cfg.hourlyMinute + 10) % 60,
          ),
        );
        break;
      case "durability_reconcile":
        runner.register(
          durabilityJob(scf, {
            canary: cfg.durability.prometheusUrl
              ? new PrometheusCanarySource(cfg.durability.prometheusUrl)
              : null,
            umami: umamiRo,
            canaryLagHours: cfg.durability.canaryLagHours,
            dailyAt: cfg.durability.dailyAt,
          }),
        );
        break;
      case "registry_sync":
        runner.register(
          registrySyncJob(scf, {
            sources: cfg.registry.sources.map((s) =>
              s.source === "stellarlight"
                ? new StellarlightSource(s.url)
                : new PgAtlasSource(s.url),
            ),
            maxDropShare: cfg.registry.maxDropShare,
            dailyAt: cfg.registry.dailyAt,
          }),
        );
        break;
      case "contract_verification":
        runner.register(
          contractVerificationJob(
            scf,
            new HorizonRpcLedger({
              horizonUrl: cfg.contracts.horizonUrl,
              rpcUrl: cfg.contracts.rpcUrl,
              network: cfg.contracts.network,
            }),
            { network: cfg.contracts.network, dailyAt: cfg.contracts.dailyAt },
          ),
        );
        break;
      case "trust_scoring":
        runner.register(trustScoringJob(scf, cfg.trust.dailyAt, cfg.contracts.network));
        break;
      case "audit_anchor": {
        const pubs: AnchorPublisher[] = [];
        if (cfg.anchor.dir) pubs.push(new FilePublisher(cfg.anchor.dir));
        runner.register(
          auditAnchorJob(scf, pubs, cfg.anchor.dailyAt, (cfg.hourlyMinute + 15) % 60),
        );
        break;
      }
      case "daily_seal": {
        const sl = cfg.seal;
        if (!sl || !cfg.anchor.dir)
          throw new Error("daily_seal needs SCF_SEAL_HORIZON_URL and SCF_AUDIT_ANCHOR_DIR");
        runner.register(
          dailySealJob(
            scf,
            new HorizonSealLedger({ horizonUrl: sl.horizonUrl, friendbotUrl: sl.friendbotUrl }),
            {
              network: sl.network,
              passphrase: sl.passphrase,
              anchorDir: cfg.anchor.dir,
              secretSeed: sl.secretSeed,
              feeStroops: sl.feeStroops,
              friendbot: sl.friendbotUrl !== null,
              dailyAt: sl.dailyAt,
              hourlyMinute: (cfg.hourlyMinute + 25) % 60,
            },
          ),
        );
        if (!sl.secretSeed)
          log.warn("seal_build_only", { job: "daily_seal", missing: "SCF_SEAL_SECRET_FILE" });
        break;
      }
      case "audit_verify":
        runner.register(
          auditVerifyJob(
            scf,
            cfg.anchor.dir ? new FilePublisher(cfg.anchor.dir) : null,
            cfg.auditVerifyDailyAt,
          ),
        );
        break;
      case "onchain_correlation": {
        const o = cfg.onchain;
        if (!o) throw new Error("onchain_correlation needs SCF_ONCHAIN_LEDGER_DIR");
        runner.register(
          onchainCorrelationJob(
            scf,
            new LedgerFileReader({
              bin: o.readerBin,
              ledgerDir: o.ledgerDir,
              timeoutMs: o.timeoutMs,
            }),
            {
              network: o.network,
              lookbackDays: o.lookbackDays,
              dailyAt: o.dailyAt,
              fetcher: o.sourceUrl
                ? new LedgerFileFetcher({
                    bin: o.readerBin,
                    sourceUrl: o.sourceUrl,
                    ledgerDir: o.ledgerDir,
                    timeoutMs: o.fetchTimeoutMs,
                  })
                : null,
              ledgerHashes: o.horizonUrl
                ? new HorizonLedgerHashes({ horizonUrl: o.horizonUrl })
                : null,
            },
          ),
        );
        break;
      }
      // Protocol interactions (migration 0082): same mirror, reader binary, fetch and Horizon as above.
      case "protocol_usage": {
        const o = cfg.onchain;
        const p = cfg.protocolUsage;
        if (!o || !p) throw new Error("protocol_usage needs SCF_ONCHAIN_LEDGER_DIR");
        runner.register(
          protocolUsageJob(
            scf,
            new LedgerProtocolReader({
              bin: o.readerBin,
              ledgerDir: o.ledgerDir,
              timeoutMs: p.timeoutMs,
            }),
            {
              network: o.network,
              lookbackDays: p.lookbackDays,
              dailyAt: p.dailyAt,
              fetcher: o.sourceUrl
                ? new LedgerFileFetcher({
                    bin: o.readerBin,
                    sourceUrl: o.sourceUrl,
                    ledgerDir: o.ledgerDir,
                    timeoutMs: o.fetchTimeoutMs,
                  })
                : null,
              ledgerHashes: o.horizonUrl
                ? new HorizonLedgerHashes({ horizonUrl: o.horizonUrl })
                : null,
            },
          ),
        );
        break;
      }
      // Ecosystem Usage Map (migration 0075): same mirror, reader binary, fetch and Horizon as above.
      case "usage_map": {
        const o = cfg.onchain;
        const u = cfg.usageMap;
        if (!o || !u) throw new Error("usage_map needs SCF_ONCHAIN_LEDGER_DIR");
        runner.register(
          usageMapJob(
            scf,
            new LedgerUsageReader({
              bin: o.readerBin,
              ledgerDir: o.ledgerDir,
              timeoutMs: u.timeoutMs,
            }),
            {
              network: o.network,
              lookbackDays: u.lookbackDays,
              dailyAt: u.dailyAt,
              fetcher: o.sourceUrl
                ? new LedgerFileFetcher({
                    bin: o.readerBin,
                    sourceUrl: o.sourceUrl,
                    ledgerDir: o.ledgerDir,
                    timeoutMs: o.fetchTimeoutMs,
                  })
                : null,
              ledgerHashes: o.horizonUrl
                ? new HorizonLedgerHashes({ horizonUrl: o.horizonUrl })
                : null,
            },
          ),
        );
        break;
      }
    }
  }
  for (const d of cfg.disabled) log.warn("job_disabled", { job: d.job, missing: d.missing });
  for (const v of cfg.ignored)
    log.warn("setting_ignored", { setting: v, reason: "superseded_c136" });

  const server = createHttpServer(
    {
      live: () => runner.started && !runner.stopping,
      ready: async () => {
        try {
          await Promise.all([scf.ping(), umamiRo?.ping(), umamiMaint?.ping()]);
          return true;
        } catch (err) {
          log.warn("readiness_failed", errorFields(err));
          return false;
        }
      },
    },
    registry,
    workerMetricsText,
  );

  let workers: Awaited<ReturnType<typeof startWorkers>>;
  return {
    runner,
    startCoreWorkers: async () => {
      workers = await startWorkers(cfg, log, metrics);
    },
    server,
    registry,
    log,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, cfg.listenHost, () =>
          resolve((server.address() as AddressInfo).port),
        );
      }),
    stop: async () => {
      await workers?.stop();
      const clean = await runner.stop(cfg.shutdownGraceMs);
      if (!clean) log.warn("shutdown_grace_exceeded", { grace_ms: cfg.shutdownGraceMs });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(pools.map((p) => p.end().catch(() => {})));
    },
  };
}
