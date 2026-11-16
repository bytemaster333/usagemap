// SPDX-License-Identifier: Apache-2.0
// Control-plane entry point: public listener (default 8080), internal edge listener (default 8081) and the Prometheus
// listener (default 127.0.0.1:9464). Background work — edge_snapshot, umami_reconcile, domain_verification, erasure,
// public_metrics and the signing of traction snapshots — runs in the jobs service, woken by
// NOTIFY; this process holds no signing key and no scf_jobs / scf_umami_maint credential.

import { UmamiReader } from "@usagemap/umami-adapter";
import { buildApps } from "./app.ts";
import { httpGithubClient } from "./auth/github.ts";
import { httpHorizonClient } from "./auth/stellar.ts";
import { loadConfig } from "./config.ts";
import { createPool, Database } from "./db/database.ts";
import { cpMetrics, createMetricsServer } from "./obs/metrics.ts";
import { loadTrackerRegistry } from "./tracker.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(
    createPool({ connectionString: config.databaseUrl, max: config.databasePoolMax }),
  );
  const tracker = loadTrackerRegistry(config.tracker.manifestDir, config.tracker.releasesFile);
  // Live-window reads (wire-formats §j.3) go through the engine proxy with the reader certificate, one timeout per call
  // (C-112(6)); without an engine every range is answered from the rollups.
  const reader = config.engine
    ? new UmamiReader({
        baseUrl: config.engine.url,
        tls: {
          cert: config.engine.reader.cert,
          key: config.engine.reader.key,
          ca: config.engine.ca,
        },
        timeoutMs: config.umami.liveTimeoutMs,
      })
    : undefined;
  // Operator metrics API (`/op/v1`) as scf_metrics_ro (data-model §3, §11).
  const metricsDb = config.metricsDatabaseUrl
    ? new Database(
        createPool({
          connectionString: config.metricsDatabaseUrl,
          max: 4,
          applicationName: "scf-control-plane-op-metrics",
        }),
      )
    : undefined;
  const { publicApp, internalApp } = await buildApps({
    config,
    db,
    tracker,
    github: config.github ? httpGithubClient(config.github) : undefined,
    horizon: httpHorizonClient({ network: config.stellar.network, url: config.stellar.horizonUrl }),
    reader,
    metricsDb,
  });

  // Age of the edge snapshot this core serves (SnapshotStale): read at scrape time, as scf_app.
  cpMetrics.registry.onCollect(async () => {
    const r = await db.tx({ tenantId: null, actorKind: "system", actorId: "metrics" }, (tx) =>
      tx.maybeOne<{ age: number | null; seq: string | null }>(
        `SELECT extract(epoch FROM now() - max(issued_at))::float8 AS age, max(sequence)::text AS seq
           FROM scf.edge_snapshots`,
      ),
    );
    if (r?.age !== null && r?.age !== undefined) {
      cpMetrics.registry.set(
        "scf_cp_edge_snapshot_age_seconds",
        "Age of the newest signed edge snapshot this control plane serves",
        Number(r.age),
      );
      cpMetrics.registry.set(
        "scf_cp_edge_snapshot_sequence",
        "Sequence of the newest signed edge snapshot",
        Number(r.seq),
      );
    }
  });
  const metricsServer = createMetricsServer(cpMetrics.registry);

  await publicApp.listen({ host: config.host, port: config.publicPort });
  // Mutual TLS unless bound to loopback (C-114); loadConfig refuses anything else, buildApps re-checks.
  await internalApp.listen({ host: config.edge.internalHost, port: config.internalPort });
  await new Promise<void>((resolve, reject) => {
    metricsServer.once("error", reject);
    metricsServer.listen(config.metrics.port, config.metrics.host, () => resolve());
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    metricsServer.close();
    await Promise.allSettled([publicApp.close(), internalApp.close()]);
    await Promise.allSettled([db.close(), metricsDb?.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  // Configuration and start-up errors: message only (never values from the environment).
  process.stderr.write(
    `control-plane failed to start: ${err instanceof Error ? err.message : "unknown error"}\n`,
  );
  process.exit(1);
});
