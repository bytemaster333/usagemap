// SPDX-License-Identifier: Apache-2.0
// Starts job `erasure` (scf_jobs + scf_umami_maint) in the jobs service (F16); undefined when not configured.

import pg from "pg";
import { createPool, Database } from "../db/database.ts";
import type { WorkerConfig } from "../workers/config.ts";
import { UmamiEraser } from "./umami.ts";
import { ErasureWorker, type WorkerLogger } from "./worker.ts";

export interface ErasureRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  wake(): void;
}

/**
 * The `umami` pool of job erasure as scf_umami_maint, through PgBouncer in transaction mode: no startup parameters
 * besides `application_name` (PgBouncer refuses others with 08P01); the statement timeout is set per transaction by
 * UmamiEraser (SET LOCAL, C-119).
 */
export function umamiMaintPool(url: string, max = 2): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "scf-jobs-erasure",
  });
  pool.on("error", () => {});
  return pool;
}

export function startErasureWorker(
  config: WorkerConfig,
  log: WorkerLogger,
  onOutcome?: (o: "success" | "failure") => void,
): ErasureRunner | undefined {
  if (!config.erasure.umamiMaintUrl) return undefined;
  const db = new Database(
    createPool({
      connectionString: config.jobsDatabaseUrl,
      max: 2,
      applicationName: "scf-jobs-erasure",
    }),
  );
  const umamiPool = umamiMaintPool(config.erasure.umamiMaintUrl);
  const worker = new ErasureWorker(db, new UmamiEraser(umamiPool), {
    intervalMs: config.erasure.intervalMs,
    sweepDelayMs: config.erasure.sweepDelayMs,
    listenUrl: config.listenDatabaseUrl,
    log,
    ...(onOutcome ? { onOutcome } : {}),
  });
  return {
    start: () => worker.start(),
    wake: () => worker.wake(),
    async stop() {
      await worker.stop();
      await Promise.allSettled([db.close(), umamiPool.end()]);
    },
  };
}
