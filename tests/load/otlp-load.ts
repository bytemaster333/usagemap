// SPDX-License-Identifier: Apache-2.0
// OTLP load generator for the API path (gateway OTLP front door → Collector → writer). Open model like web-load.ts.
// Profile (stated in the evidence): every tenant request is a local-root SERVER span (the worst case — tenants that
// send traces rather than SDK metrics); spans are batched per service as an SDK's BatchSpanProcessor does.

import { randomBytes } from "node:crypto";
import https from "node:https";
import type { GatewayTarget } from "../lib/gateway-client.ts";
import { request } from "../lib/http.ts";
import { type Summary, summarise, Timeline } from "../lib/stats.ts";

export interface OtlpService {
  name: string;
  token: string;
}

export interface OtlpLoadOpts {
  target: GatewayTarget;
  services: OtlpService[];
  /** Spans (= tenant API requests) per second, across all services. */
  spansPerSecond: number;
  /** Spans per OTLP request. */
  batch: number;
  durationS: number;
  signal?: AbortSignal;
  /** Distinct route templates (default the four of ROUTES); more stresses the writer's per-route rows. */
  routes?: number;
}

export interface OtlpLoadResult {
  requests: number;
  spans: number;
  acceptedSpans: Record<string, number>;
  statuses: Record<string, number>;
  latencyMs: Summary;
  achievedSpansPerSecond: number;
  timeline: Timeline;
  durationS: number;
}

const ROUTES = ["/accounts/{id}", "/assets/{code}/{issuer}", "/health", "/ledgers/{seq}"];
const CODES = [200, 200, 200, 200, 200, 200, 200, 200, 404, 500];

/** Route template `i` of a wider set: letters only (pathnorm keeps such words literal), one `{id}` parameter. */
export function wideRoute(i: number): string {
  const L = "ghijklmnopqrstuvwxyz";
  return `/load/${L[i % 20]}${L[Math.floor(i / 20) % 20]}${L[Math.floor(i / 400) % 20]}/{id}`;
}

function spans(n: number, seq: number, routes?: number) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = seq + i;
    const durNs = BigInt(2_000_000 + ((k * 7919) % 200) * 1_000_000); // 2 … 201 ms, deterministic spread
    const route = routes ? wideRoute(k % routes) : (ROUTES[k % ROUTES.length] as string);
    out.push({
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      name: `GET ${route}`,
      kind: 2,
      startTimeUnixNano: String(now - durNs),
      endTimeUnixNano: String(now),
      attributes: [
        { key: "http.request.method", value: { stringValue: "GET" } },
        { key: "http.route", value: { stringValue: route } },
        { key: "http.response.status_code", value: { intValue: String(CODES[k % CODES.length]) } },
      ],
      status: {},
    });
  }
  return out;
}

export async function runOtlpLoad(o: OtlpLoadOpts): Promise<OtlpLoadResult> {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  const reqPerSecond = o.spansPerSecond / o.batch;
  const total = Math.floor(reqPerSecond * o.durationS);
  const timeline = new Timeline();
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const acceptedSpans: Record<string, number> = {};
  const inflight = new Set<Promise<void>>();
  let sent = 0;
  let spanSeq = 0;
  const start = performance.now();
  while (sent < total && !o.signal?.aborted) {
    const due = Math.floor(((performance.now() - start) / 1000) * reqPerSecond);
    while (sent < Math.min(due, total)) {
      const svc = o.services[sent % o.services.length] as OtlpService;
      const body = JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: svc.name } },
                { key: "service.instance.id", value: { stringValue: "load-1" } },
              ],
            },
            scopeSpans: [{ scope: { name: "wsl-load" }, spans: spans(o.batch, spanSeq, o.routes) }],
          },
        ],
      });
      spanSeq += o.batch;
      sent++;
      const p = request(`${o.target.url}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${svc.token}` },
        body,
        servername: o.target.servername,
        caFile: o.target.caFile,
        agent,
        timeoutMs: 15_000,
      })
        .then((r) => {
          latencies.push(r.ms);
          statuses[r.status] = (statuses[r.status] ?? 0) + 1;
          timeline.add(String(r.status));
          if (r.status === 200) acceptedSpans[svc.name] = (acceptedSpans[svc.name] ?? 0) + o.batch;
        })
        .catch(() => {
          statuses.error = (statuses.error ?? 0) + 1;
          timeline.add("error");
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  const elapsed = (performance.now() - start) / 1000;
  await Promise.allSettled([...inflight]);
  agent.destroy();
  return {
    requests: sent,
    spans: sent * o.batch,
    acceptedSpans,
    statuses,
    latencyMs: summarise(latencies),
    achievedSpansPerSecond: (sent * o.batch) / elapsed,
    timeline,
    durationS: elapsed,
  };
}
