// SPDX-License-Identifier: Apache-2.0
// The core workers, started by the JOBS service (services/jobs/src/core-workers.ts), never by the internet-facing
// control plane. Each worker has its own small scf_jobs pool and, with a listen URL, its own LISTEN
// session: edge_snapshot (scf_edge), umami_reconcile (scf_umami), domain_verification (scf_verify), erasure
// (scf_erasure), public_metrics (hourly documents; traction-snapshot signing on scf_snapshot).
//
// This module is the package export `@usagemap/control-plane/workers`.

import {
  HttpClient,
  UmamiProvisioner,
  UmamiReader,
  visitTokenPurgeOnEveryCore,
} from "@usagemap/umami-adapter";
import { createPool, Database } from "../db/database.ts";
import { SnapshotLoop } from "../edge/loop.ts";
import { SnapshotBuilder, SnapshotSigner } from "../edge/snapshot.ts";
import { startErasureWorker } from "../erasure/start.ts";
import { PublicMetricsJob } from "../programme/metrics-endpoint.ts";
import { TractionSigner, TractionSigningKey } from "../programme/signer.ts";
import { loadTrackerRegistry } from "../tracker.ts";
import { UmamiReconcileLoop, UmamiReconciler } from "../umami/reconcile.ts";
import { DomainVerifier } from "../verify/verifier.ts";
import { DomainVerificationWorker } from "../verify/worker.ts";
import { type CoreWorker, plannedWorkers, type WorkerConfig } from "./config.ts";

export { cpMetrics } from "../obs/metrics.ts";
export { CORE_WORKERS, type CoreWorker, loadWorkerConfig, type WorkerConfig } from "./config.ts";

export interface WorkerLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface CoreWorkers {
  /** Workers started (names as in data-model §6.3, plus `traction_snapshot_sign` for the signer of public_metrics). */
  running: string[];
  /** Workers not started and the configuration each lacks (no values). */
  disabled: Record<string, string>;
  stop(): Promise<void>;
}

interface Stoppable {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts every worker whose configuration is present. `onOutcome(worker, outcome)` is called after each pass (the
 * jobs service turns it into `scf_job_runs_total`, `scf_job_last_success_timestamp_seconds`).
 */
export async function startCoreWorkers(
  cfg: WorkerConfig,
  log: WorkerLog,
  onOutcome: (worker: string, outcome: "success" | "failure") => void = () => {},
): Promise<CoreWorkers> {
  const { run, missing } = plannedWorkers(cfg);
  const dbs: Database[] = [];
  const pool = (name: string, max: number) => {
    const db = new Database(
      createPool({
        connectionString: cfg.jobsDatabaseUrl,
        max,
        applicationName: `scf-jobs-${name}`,
      }),
    );
    dbs.push(db);
    return db;
  };
  const started: Array<{ name: string; w: Stoppable }> = [];
  const add = (name: string, w: Stoppable) => started.push({ name, w });
  const outcome = (name: string) => (o: "success" | "failure") => onOutcome(name, o);
  const want = (w: CoreWorker) => run.includes(w);

  if (want("edge_snapshot") && cfg.edge.signingKeyPem) {
    const builder = new SnapshotBuilder(
      pool("edge-snapshot", 2),
      new SnapshotSigner(cfg.edge.signingKeyPem, cfg.edge.kid),
      {
        pathnormRulesVersion: cfg.edge.pathnormRulesVersion,
        tracker: loadTrackerRegistry(cfg.edge.trackerManifestDir, cfg.edge.trackerReleasesFile),
        maxAgeS: cfg.edge.maxAgeS,
      },
    );
    add(
      "edge_snapshot",
      new SnapshotLoop(builder, {
        intervalMs: cfg.edge.intervalMs,
        listenUrl: cfg.listenDatabaseUrl,
        log,
        onOutcome: outcome("edge_snapshot"),
      }),
    );
  }

  const engine = cfg.engine;
  const prov = engine?.provisioner;
  if (want("umami_reconcile") && engine && prov && cfg.umami.credsKeys) {
    const tls = { cert: prov.cert, key: prov.key, ca: engine.ca };
    const reader = engine.reader
      ? new UmamiReader({
          baseUrl: engine.url,
          tls: { cert: engine.reader.cert, key: engine.reader.key, ca: engine.ca },
          timeoutMs: 5_000,
        })
      : undefined;
    const reconciler = new UmamiReconciler({
      jobsDb: pool("umami-reconcile", 3),
      provisioner: new UmamiProvisioner(
        new HttpClient({ baseUrl: engine.url, tls, timeoutMs: 30_000 }),
      ),
      purge: visitTokenPurgeOnEveryCore(
        engine.urls.map((baseUrl) => new HttpClient({ baseUrl, tls, timeoutMs: 10_000 })),
      ),
      reader,
      credsKeys: cfg.umami.credsKeys,
      admin: { username: prov.user, password: prov.password },
      log,
    });
    add(
      "umami_reconcile",
      new UmamiReconcileLoop(reconciler, {
        intervalMs: cfg.umami.reconcileIntervalMs,
        listenUrl: cfg.listenDatabaseUrl,
        log,
        onOutcome: outcome("umami_reconcile"),
      }),
    );
  }

  if (want("domain_verification")) {
    add(
      "domain_verification",
      new DomainVerificationWorker(
        pool("domain-verification", 2),
        new DomainVerifier({ dnsServers: cfg.verifier.dnsServers }),
        {
          intervalMs: cfg.verifier.intervalMs,
          listenUrl: cfg.listenDatabaseUrl,
          log,
          onOutcome: outcome("domain_verification"),
        },
      ),
    );
  }

  if (want("erasure")) {
    const e = startErasureWorker(cfg, log, outcome("erasure"));
    if (e) add("erasure", e);
  }

  if (want("public_metrics") && cfg.programme.portalOrigin) {
    const db = pool("public-metrics", 2);
    add(
      "public_metrics",
      new PublicMetricsJob(db, {
        portalOrigin: cfg.programme.portalOrigin,
        intervalMs: cfg.programme.publicMetricsIntervalMs,
        log,
        onOutcome: outcome("public_metrics"),
      }),
    );
    if (cfg.programme.snapshotSigningKeyPem) {
      add(
        "traction_snapshot_sign",
        new TractionSigner(
          db,
          new TractionSigningKey(cfg.programme.snapshotSigningKeyPem, cfg.programme.snapshotKid),
          {
            portalOrigin: cfg.programme.portalOrigin,
            onchainNetwork: cfg.programme.onchainNetwork,
            sealNetwork: cfg.programme.sealNetwork,
            intervalMs: cfg.programme.signIntervalMs,
            listenUrl: cfg.listenDatabaseUrl,
            log,
            onOutcome: outcome("traction_snapshot_sign"),
          },
        ),
      );
    } else {
      missing.traction_snapshot_sign = "SCF_SNAPSHOT_SIGNING_KEY";
    }
  }

  for (const { w } of started) await w.start();
  return {
    running: started.map((s) => s.name),
    disabled: missing,
    async stop() {
      await Promise.allSettled(started.map((s) => s.w.stop()));
      await Promise.allSettled(dbs.map((d) => d.close()));
    },
  };
}
