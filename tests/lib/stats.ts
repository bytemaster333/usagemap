// SPDX-License-Identifier: Apache-2.0
// Latency recording for the load and chaos runners: exact samples (the runs are minutes, not days), nearest-rank
// percentiles, per-second outcome buckets.

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (p <= 0) return sorted[0] as number;
  if (p >= 100) return sorted[sorted.length - 1] as number;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] as number;
}

export interface Summary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function summarise(samples: number[]): Summary {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    min: s[0] ?? Number.NaN,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? Number.NaN,
    mean: s.length ? sum / s.length : Number.NaN,
  };
}

/** Per-second buckets of outcomes, e.g. {"202": 40, "error": 1}. */
export class Timeline {
  readonly start = Date.now();
  readonly buckets: Map<number, Map<string, number>> = new Map();
  add(outcome: string, at = Date.now()): void {
    const sec = Math.floor((at - this.start) / 1000);
    let b = this.buckets.get(sec);
    if (!b) {
      b = new Map();
      this.buckets.set(sec, b);
    }
    b.set(outcome, (b.get(outcome) ?? 0) + 1);
  }
  /** Seconds in [from, to) in which at least one request failed (non-2xx or transport error). */
  failingSeconds(from = 0, to = Number.POSITIVE_INFINITY): number[] {
    const out: number[] = [];
    for (const [sec, b] of [...this.buckets.entries()].sort((x, y) => x[0] - y[0])) {
      if (sec < from || sec >= to) continue;
      for (const [k, n] of b)
        if (n > 0 && !/^2\d\d$/.test(k) && !k.startsWith("no_")) out.push(sec);
    }
    return [...new Set(out)];
  }
  totals(): Record<string, number> {
    const t: Record<string, number> = {};
    for (const b of this.buckets.values()) for (const [k, n] of b) t[k] = (t[k] ?? 0) + n;
    return t;
  }
}

/** Requests per day equivalent of a sustained rate. */
export function perDay(ratePerSecond: number): number {
  return ratePerSecond * 86_400;
}
