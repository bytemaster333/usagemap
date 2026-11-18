// SPDX-License-Identifier: Apache-2.0
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";

export class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected override async onForceFlush() {}
  protected override async onShutdown() {}
}

export function setup() {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  return { reader, provider, meter: provider.getMeter("@usagemap/stellar-otel", "0.1.0") };
}

export interface Point {
  name: string;
  unit: string;
  attrs: Record<string, unknown>;
  value: number;
}

/** Flatten collected metrics: histograms → count, sums → value. */
export async function points(reader: MetricReader): Promise<Point[]> {
  const { resourceMetrics } = (await reader.collect()) as { resourceMetrics: ResourceMetrics };
  const out: Point[] = [];
  for (const sm of resourceMetrics.scopeMetrics)
    for (const m of sm.metrics)
      for (const dp of m.dataPoints as {
        attributes: Record<string, unknown>;
        value: number | { count: number };
      }[])
        out.push({
          name: m.descriptor.name,
          unit: m.descriptor.unit,
          attrs: dp.attributes,
          value: typeof dp.value === "number" ? dp.value : dp.value.count,
        });
  return out;
}

export const sum = (
  ps: Point[],
  name: string,
  pred: (a: Record<string, unknown>) => boolean = () => true,
) => ps.filter((p) => p.name === name && pred(p.attrs)).reduce((a, p) => a + p.value, 0);

/** Privacy beacon: Stellar G/C/M addresses, seeds, 64-hex hashes, base64 XDR, URLs, loopback hosts, ports. */
export const FORBIDDEN = [
  /[GCM][A-Z2-7]{55}/,
  /S[A-Z2-7]{55}/,
  /\b[0-9a-f]{64}\b/,
  /AAAA[A-Za-z0-9+/]{20,}/,
  /https?:\/\//,
  /127\.0\.0\.1/,
  /localhost/,
  /apikey|secret/i,
];
export const assertClean = (s: string) => {
  for (const re of FORBIDDEN)
    if (re.test(s)) throw new Error(`privacy beacon matched ${re}: ${s.slice(0, 300)}`);
};

/** Every attribute key/value pair must be within the closed sets the Collector accepts. */
export const ALLOWED_KEYS: Record<string, readonly string[]> = {
  "rpc.client.call.duration": [
    "rpc.system.name",
    "rpc.method",
    "rpc.status_code",
    "error.type",
    "stellar.network",
  ],
  "http.client.request.duration": [
    "http.request.method",
    "url.template",
    "http.response.status_code",
    "error.type",
    "stellar.network",
  ],
  "stellar.tx.submissions": [
    "stellar.tx.via",
    "stellar.tx.status",
    "stellar.tx.result_class",
    "stellar.network",
  ],
  "stellar.tx.polls": ["stellar.tx.status", "stellar.tx.result_class", "stellar.network"],
  "stellar.tx.simulations": ["stellar.sim.outcome", "stellar.sim.error_class", "stellar.network"],
};
export const assertKeys = (ps: Point[]) => {
  for (const p of ps) {
    const allowed = ALLOWED_KEYS[p.name];
    if (!allowed) throw new Error(`unexpected metric ${p.name}`);
    for (const k of Object.keys(p.attrs))
      if (!allowed.includes(k)) throw new Error(`${p.name}: attribute ${k} not allow-listed`);
  }
};
