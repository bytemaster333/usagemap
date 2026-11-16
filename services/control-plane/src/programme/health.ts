// SPDX-License-Identifier: Apache-2.0
// The platform `health_endpoint` (ADR-0032, C-14, C-78; wire-formats §i.2): public, no tenant data, `no-store`;
// `200` for `ok`/`degraded`, `503` for `down`.
//
// Sources available to the control plane (interpretation recorded as C-119 until probe rounds are stored centrally):
//   - edge nodes: the freshness of each node's spool counter reports (wire-formats §l; a node reports every minute),
//     `down` when its last report is older than SCF_HEALTH_NODE_STALE_S (default 300 s);
//   - ingest hostnames: configured with the nodes behind them; a hostname is `ok` while one of its nodes is;
//   - web_ingest / otlp_ingest (the same gateways serve both, §f): `down` when no node is up, `degraded` when a node
//     or a hostname is down;
//   - processing: `degraded` when a node reports more than SCF_HEALTH_BACKLOG_DEGRADED unacknowledged spool records,
//     `down` when no node has reported for an hour;
//   - dashboards: the database answers within 2 s.
// `status` is the worst component.

import type { ProgrammeConfig } from "../config.ts";
import type { Handler } from "../http/pipeline.ts";
import { isoZ } from "./figures.ts";

type Level = "ok" | "degraded" | "down";
const RANK: Record<Level, number> = { ok: 0, degraded: 1, down: 2 };
const worst = (...l: Level[]): Level => l.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

export interface NodeReport {
  node: string;
  last: number | null;
  queued: number;
}

export function healthDocument(
  cfg: Pick<
    ProgrammeConfig,
    "ingestHosts" | "nodeStaleSeconds" | "backlogDegraded" | "statusPageUrl"
  >,
  version: string,
  now: number,
  db: { ok: boolean; nodes: NodeReport[] },
): Record<string, unknown> {
  const stale = cfg.nodeStaleSeconds * 1000;
  const up = (n: NodeReport) => n.last !== null && now - n.last <= stale;
  const nodes = db.nodes.map((n) => ({ node: n.node, status: up(n) ? "ok" : "down" }));
  const known = new Set(db.nodes.filter(up).map((n) => n.node));
  const hosts = cfg.ingestHosts.map((h) => ({
    host: h.host,
    status: h.nodes.some((n) => known.has(n)) ? "ok" : "down",
  }));
  let ingest: Level = "ok";
  if (nodes.length > 0 || hosts.length > 0) {
    const anyUp = known.size > 0 && (hosts.length === 0 || hosts.some((h) => h.status === "ok"));
    if (!anyUp) ingest = "down";
    else if (nodes.some((n) => n.status === "down") || hosts.some((h) => h.status === "down"))
      ingest = "degraded";
  }
  let processing: Level = "ok";
  if (db.nodes.length > 0) {
    const newest = Math.max(...db.nodes.map((n) => n.last ?? 0));
    if (now - newest > 3_600_000) processing = "down";
    else if (db.nodes.some((n) => up(n) && n.queued > cfg.backlogDegraded)) processing = "degraded";
  }
  const dashboards: Level = db.ok ? "ok" : "down";
  if (!db.ok) {
    ingest = "ok";
    processing = "ok";
  }
  const components = { web_ingest: ingest, otlp_ingest: ingest, dashboards, processing };
  return {
    schema: "scf-analytics/health/1",
    status: worst(ingest, dashboards, processing),
    checked_at: isoZ(now),
    version,
    components,
    ingest_hostnames: hosts,
    edge_nodes: nodes,
    freshness_p99_seconds: null,
    ...(cfg.statusPageUrl ? { status_page: cfg.statusPageUrl } : {}),
  };
}

export function healthHandlers(deps: {
  cfg: ProgrammeConfig;
  version: string;
  now?: () => number;
}): Record<string, Handler> {
  const clock = deps.now ?? Date.now;
  const getHealth: Handler = async (ctx) => {
    let ok = true;
    let nodes: NodeReport[] = [];
    try {
      const rows = await Promise.race([
        ctx.tx(
          (tx) =>
            tx.query<{ node_id: string; last: Date | null; queued: string | null }>(
              `SELECT DISTINCT ON (node_id) node_id, last_period_end AS last, queued_end::text AS queued
                 FROM scf.edge_spool_accounting WHERE day >= (now() AT TIME ZONE 'UTC')::date - 7
                ORDER BY node_id, day DESC`,
            ),
          { tenantId: null, actorKind: "system", actorId: "health", requestId: ctx.requestId },
        ),
        new Promise<never>((_r, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);
      nodes = rows.map((r) => ({
        node: r.node_id,
        last: r.last?.getTime() ?? null,
        queued: Number(r.queued ?? 0),
      }));
    } catch {
      ok = false;
    }
    const body = healthDocument(deps.cfg, deps.version, clock(), { ok, nodes });
    return {
      status: body.status === "down" ? 503 : 200,
      body,
      headers: { "cache-control": "no-store" },
    };
  };
  return { getHealth };
}
