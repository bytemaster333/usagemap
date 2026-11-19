// SPDX-License-Identifier: Apache-2.0
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  AMOUNT_BUCKETS,
  ASSETS,
  ATTRIBUTE_KEYS,
  METRIC_PAYMENT_EVENTS,
  MPP_ERROR_TYPES,
  MPP_INTENTS,
  MPP_METHODS,
  NETWORKS,
  PROTOCOLS,
  REASON_CLASSES,
  STAGES,
  X402_ERROR_TYPES,
  X402_SCHEMES,
} from "../src/index.ts";

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
  return { reader, provider, meter: provider.getMeter("@usagemap/payments-otel", "0.1.0") };
}

export interface Point {
  name: string;
  unit: string;
  attrs: Record<string, unknown>;
  value: number;
}

export async function points(reader: MetricReader): Promise<Point[]> {
  const { resourceMetrics } = (await reader.collect()) as { resourceMetrics: ResourceMetrics };
  const out: Point[] = [];
  for (const sm of resourceMetrics.scopeMetrics)
    for (const m of sm.metrics)
      for (const dp of m.dataPoints as { attributes: Record<string, unknown>; value: number }[])
        out.push({
          name: m.descriptor.name,
          unit: m.descriptor.unit,
          attrs: dp.attributes,
          value: dp.value,
        });
  return out;
}

export const count = (ps: Point[], match: Record<string, unknown>) =>
  ps
    .filter((p) => Object.entries(match).every(([k, v]) => p.attrs[k] === v))
    .reduce((a, p) => a + p.value, 0);

/** Privacy beacon: Stellar G/C/M addresses, seeds, EVM addresses, 64-hex hashes, URLs, loopback hosts, digits-only amounts. */
export const FORBIDDEN = [
  /[GCM][A-Z2-7]{55}/,
  /S[A-Z2-7]{55}/,
  /0x[0-9a-fA-F]{40}/,
  /\b[0-9a-f]{64}\b/,
  /AAAA[A-Za-z0-9+/]{20,}/,
  /https?:\/\//,
  /127\.0\.0\.1/,
  /localhost/,
  /secret|bearer|order-|invoice/i,
  /"\d{3,}"/,
];
export const assertClean = (s: string) => {
  for (const re of FORBIDDEN)
    if (re.test(s)) throw new Error(`privacy beacon matched ${re}: ${s.slice(0, 400)}`);
};

/** Every point: the one metric, allow-listed keys only, every value within its closed set. */
const VALUES: Record<string, readonly string[]> = {
  "payment.protocol": PROTOCOLS,
  "payment.stage": STAGES,
  "payment.scheme": X402_SCHEMES,
  "payment.method": MPP_METHODS,
  "payment.intent": MPP_INTENTS,
  "payment.network": NETWORKS,
  "payment.asset": ASSETS,
  "payment.amount_bucket": AMOUNT_BUCKETS,
  "payment.reason_class": REASON_CLASSES,
  "error.type": [...new Set([...X402_ERROR_TYPES, ...MPP_ERROR_TYPES])],
};
export const assertClosed = (ps: Point[]) => {
  for (const p of ps) {
    if (p.name !== METRIC_PAYMENT_EVENTS) throw new Error(`unexpected metric ${p.name}`);
    if (p.unit !== "{event}") throw new Error(`unit ${p.unit}`);
    for (const [k, v] of Object.entries(p.attrs)) {
      if (!(ATTRIBUTE_KEYS as readonly string[]).includes(k))
        throw new Error(`key ${k} not allow-listed`);
      if (!VALUES[k]?.includes(v as string))
        throw new Error(`${k}=${String(v)} outside its closed set`);
    }
  }
  assertClean(JSON.stringify(ps));
};
