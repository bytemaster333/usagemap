// SPDX-License-Identifier: Apache-2.0
// Job `partitions` (data-model §6.3, §10): hourly, creates the partitions ahead of time and drops expired ones by
// calling the database's own SECURITY DEFINER functions. `scf.ensure_partitions()` creates each new partition in
// `scf_part` with RLS enabled and forced and a copy of every parent policy (no grants); `scf.drop_expired_partitions()`
// detaches and drops partitions past their retention (api_metrics_1m 35 days, api_metrics_1h and web_hourly_totals
// 25 months; api_metrics_1d is never dropped — retention.aggregates-24m, retention.raw-metrics). Both run in one transaction each.

import type { ScfDb } from "../db.ts";
import type { JobContext, JobDef } from "../runner.ts";

export function partitionsJob(db: ScfDb, hourlyMinute: number): JobDef {
  return {
    name: "partitions",
    triggers: [{ schedule: { kind: "hourly", minute: hourlyMinute }, mode: "hourly" }],
    run: async (ctx) => {
      await runPartitions(db, ctx);
    },
  };
}

export async function runPartitions(
  db: ScfDb,
  ctx: JobContext,
): Promise<{ created: number; dropped: number }> {
  const created = await db.tx("partitions", null, async (tx) => {
    const r = await tx.one<{ n: number }>("SELECT scf.ensure_partitions() AS n");
    return r.n;
  });
  const dropped = await db.tx("partitions", null, async (tx) => {
    const r = await tx.one<{ n: number }>("SELECT scf.drop_expired_partitions() AS n");
    return r.n;
  });
  ctx.metrics.partitions.inc({ job: "partitions", action: "created" }, created);
  ctx.metrics.partitions.inc({ job: "partitions", action: "dropped" }, dropped);
  ctx.log.info("partitions_done", { job: "partitions", created, dropped });
  return { created, dropped };
}
