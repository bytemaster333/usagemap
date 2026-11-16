// SPDX-License-Identifier: Apache-2.0
// The control plane's former in-process jobs, run here: edge_snapshot (builder and Ed25519
// signer), umami_reconcile, domain_verification, erasure and public_metrics (documents + traction-snapshot signing).
// Their code lives in the control-plane package (`@usagemap/control-plane/workers`, sharing its data layer and
// tests); only this process runs it and only this container holds their credentials. The internet-facing control plane
// hands work over with NOTIFY (scf_edge, scf_umami, scf_verify, scf_erasure, scf_snapshot).
//
// Each worker pass becomes `scf_job_runs_total{job,outcome}` and `scf_job_last_success_timestamp_seconds{job}` like
// the scheduled jobs; their logs go through this service's redacting logger.

import {
  type CoreWorkers,
  cpMetrics,
  loadWorkerConfig,
  startCoreWorkers,
  type WorkerLog,
} from "@usagemap/control-plane/workers";
import type { Config } from "./config.ts";
import { errorFields, type LogFields, type Logger, type LogValue } from "./log.ts";
import type { JobMetrics } from "./metrics.ts";

type Env = Record<string, string | undefined>;

/** pino-style `(obj, msg)` calls → this service's `(event, fields)` logger; values pass its redaction. */
export function workerLog(log: Logger): WorkerLog {
  const fields = (obj: object): LogFields => {
    const out: LogFields = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v instanceof Error || (typeof v === "object" && v !== null)) {
        Object.assign(out, errorFields(v));
        continue;
      }
      if (["string", "number", "boolean"].includes(typeof v) || v === null) out[k] = v as LogValue;
    }
    return out;
  };
  const event = (msg: string) =>
    msg
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "worker";
  return {
    info: (o, m) => log.info(event(m), fields(o)),
    warn: (o, m) => log.warn(event(m), fields(o)),
    error: (o, m) => log.error(event(m), fields(o)),
  };
}

/**
 * Starts the core workers when their configuration is present. The scf_jobs and scf_umami_maint URLs are the ones this
 * service already resolved (passwords from their files), so both halves use the same credentials.
 */
export async function startWorkers(
  cfg: Config,
  log: Logger,
  metrics: JobMetrics,
  env: Env = process.env,
): Promise<CoreWorkers | undefined> {
  const wc = loadWorkerConfig({
    ...env,
    SCF_JOBS_DATABASE_URL: cfg.scfUrl,
    SCF_JOBS_DATABASE_URL_FILE: undefined,
    SCF_UMAMI_MAINT_URL: cfg.umamiMaintUrl || undefined,
    SCF_UMAMI_MAINT_URL_FILE: undefined,
  });
  if (!wc) return undefined;
  const workers = await startCoreWorkers(wc, workerLog(log), (job, outcome) => {
    metrics.runs.inc({ job, outcome });
    if (outcome === "success") metrics.lastSuccess.set({ job }, Date.now() / 1000);
  });
  for (const [job, missing] of Object.entries(workers.disabled))
    log.warn("core_worker_disabled", {
      job,
      missing: missing.replace(/[^A-Z0-9_]+/g, "+").slice(0, 96),
    });
  log.info("core_workers_started", { workers: workers.running.join("+") });
  return workers;
}

/** The control-plane module metrics that are produced in this process (the verifier's refused targets). */
export async function workerMetricsText(): Promise<string> {
  const text = await cpMetrics.registry.render();
  return text
    .split("\n")
    .filter((l) => l.includes("scf_cp_verifier_blocked_targets_total"))
    .join("\n");
}
