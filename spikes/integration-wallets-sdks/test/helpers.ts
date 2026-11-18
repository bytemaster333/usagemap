// SPDX-License-Identifier: Apache-2.0
import { AggregationTemporality, MeterProvider, MetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";

export class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

export function setup() {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  const meter = provider.getMeter("@usagemap/stellar");
  return { reader, provider, meter };
}

export interface Point {
  name: string;
  attrs: Record<string, unknown>;
  value: number;
}

/** Flatten collected metrics: histograms → count, sums → value. */
export async function points(reader: MetricReader): Promise<Point[]> {
  const { resourceMetrics } = (await reader.collect()) as { resourceMetrics: ResourceMetrics };
  const out: Point[] = [];
  for (const sm of resourceMetrics.scopeMetrics)
    for (const m of sm.metrics)
      for (const dp of m.dataPoints as { attributes: Record<string, unknown>; value: number | { count: number } }[])
        out.push({
          name: m.descriptor.name,
          attrs: dp.attributes,
          value: typeof dp.value === "number" ? dp.value : dp.value.count,
        });
  return out;
}

/** Privacy beacon: Stellar G/C/M addresses, 64-hex hashes, base64 XDR envelopes, URLs, secret seeds. */
export const FORBIDDEN = [
  /[GCM][A-Z2-7]{55}/,
  /S[A-Z2-7]{55}/,
  /\b[0-9a-f]{64}\b/,
  /AAAA[A-Za-z0-9+/]{40,}/,
  /https?:\/\//,
  /127\.0\.0\.1/,
];
export const assertClean = (s: string) => {
  for (const re of FORBIDDEN) if (re.test(s)) throw new Error(`privacy beacon matched ${re}: ${s.slice(0, 200)}`);
};
