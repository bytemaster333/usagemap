// SPDX-License-Identifier: Apache-2.0
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  ATTR_EVENT,
  ATTR_HOME_DOMAIN,
  ATTR_NETWORK,
  ATTR_OUTCOME,
  ATTR_SEP,
  ATTR_STEP,
  EVENTS,
  METRIC_EVENTS,
  METRIC_REQUEST_DURATION,
  NETWORKS,
  OUTCOMES,
  SEPS,
  STEPS,
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
  return { reader, provider, meter: provider.getMeter("@usagemap/anchor-otel", "0.1.0") };
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

/** Count of funnel event `event` (optionally for one SEP). */
export const ev = (ps: Point[], event: string, sep?: string) =>
  sum(
    ps,
    METRIC_EVENTS,
    (a) => a[ATTR_EVENT] === event && (sep === undefined || a[ATTR_SEP] === sep),
  );

/** Count of requests for `sep`/`step` (optionally with one outcome). */
export const req = (ps: Point[], sep: string, step: string, outcome?: string) =>
  sum(
    ps,
    METRIC_REQUEST_DURATION,
    (a) =>
      a[ATTR_SEP] === sep &&
      a[ATTR_STEP] === step &&
      (outcome === undefined || a[ATTR_OUTCOME] === outcome),
  );

/** Privacy beacon: addresses, seeds, hashes, XDR, JWTs, URLs, IPs, ports, amounts, memos, KYC values. */
export const FORBIDDEN = [
  /[GCM][A-Z2-7]{55}/,
  /S[A-Z2-7]{55}/,
  /\b[0-9a-f]{64}\b/,
  /AAAA[A-Za-z0-9+/]{20,}/,
  /eyJ[A-Za-z0-9_-]{5,}/,
  /https?:\/\//,
  /127\.0\.0\.1/,
  /:\d{2,5}\b/,
  /\b\d+\.\d+\b/,
  /memo|secret|Jane|Doe|example@|bank_account/i,
];
export const assertClean = (s: string) => {
  for (const re of FORBIDDEN)
    if (re.test(s)) throw new Error(`privacy beacon matched ${re}: ${s.slice(0, 300)}`);
};

/** Every attribute key/value must be in the closed sets (home domain: a lower-case DNS name or _OTHER). */
export function assertClosed(ps: Point[]) {
  const domain = /^(?:_OTHER|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62})$/;
  for (const p of ps) {
    const keys = Object.keys(p.attrs).sort();
    const want =
      p.name === METRIC_REQUEST_DURATION
        ? [ATTR_HOME_DOMAIN, ATTR_OUTCOME, ATTR_STEP, ATTR_SEP, ATTR_NETWORK].sort()
        : [ATTR_EVENT, ATTR_HOME_DOMAIN, ATTR_SEP, ATTR_NETWORK].sort();
    if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Error(`keys ${keys} on ${p.name}`);
    const a = p.attrs as Record<string, string>;
    if (!domain.test(a[ATTR_HOME_DOMAIN] as string))
      throw new Error(`domain ${a[ATTR_HOME_DOMAIN]}`);
    if (!(SEPS as readonly string[]).includes(a[ATTR_SEP] as string))
      throw new Error(`sep ${a[ATTR_SEP]}`);
    if (!(NETWORKS as readonly string[]).includes(a[ATTR_NETWORK] as string))
      throw new Error("network");
    if (p.name === METRIC_REQUEST_DURATION) {
      if (!(STEPS as readonly string[]).includes(a[ATTR_STEP] as string)) throw new Error("step");
      if (!(OUTCOMES as readonly string[]).includes(a[ATTR_OUTCOME] as string))
        throw new Error("outcome");
    } else if (!(EVENTS as readonly string[]).includes(a[ATTR_EVENT] as string)) {
      throw new Error(`event ${a[ATTR_EVENT]}`);
    }
  }
}
