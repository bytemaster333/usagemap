// SPDX-License-Identifier: Apache-2.0
// Polite HTTP access to a public registry (PG Atlas has
// answered 429 to every per-project request job registry_sync made right after its list). One `PoliteClient` per
// source and run:
//   - one request at a time (requests are queued, never parallel) and at least `minIntervalMs` between the start of
//     one request and the next;
//   - 429 and 503 are retried: after the server's `Retry-After` (seconds or an HTTP date) when it sends one, else after
//     an exponential backoff with full jitter (base·2^n, capped); at most `maxAttempts` attempts per request;
//   - a `Retry-After` longer than `maxRetryAfterMs`, or a request that is still limited after its last attempt, opens
//     the client's breaker (`RateLimitedError`): the caller stops asking for this run and resumes on the next one;
//   - at most `maxRequests` requests per run (`BudgetExhaustedError` afterwards), so a run's load on the source is
//     bounded whatever the number of changed projects.
// Every wait honours the run's abort signal.

/** A registry source failed for this run (job registry_sync records `failed`, nothing else changes). */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrySourceError";
  }
}

export interface PoliteOptions {
  /** Minimum time between two request starts (default 1000 ms). */
  minIntervalMs?: number;
  /** Attempts per request for 429 / 503 answers and network errors (default 4). */
  maxAttempts?: number;
  /** First backoff without Retry-After (default 2000 ms); doubles per attempt with full jitter. */
  backoffBaseMs?: number;
  /** Upper bound of one backoff (default 60 s). */
  backoffCapMs?: number;
  /** A Retry-After above this stops the run's requests instead of waiting (default 300 s). */
  maxRetryAfterMs?: number;
  /** Requests per run (default unlimited). */
  maxRequests?: number;
  /** Per-request timeout (default 30 s). */
  timeoutMs?: number;
  /** Test seams. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/**
 * The source keeps limiting (429) or stays unavailable (503), or asked for a pause longer than we wait: stop for this
 * run, resume next run. The name (recorded as the run's error code) tells the two apart.
 */
export class RateLimitedError extends SourceError {
  readonly status: 429 | 503;
  constructor(status: 429 | 503, message?: string) {
    super(
      message ??
        (status === 429
          ? "registry source keeps rate-limiting"
          : "registry source stays unavailable"),
    );
    this.name = status === 429 ? "RegistryRateLimited" : "RegistryUnavailable";
    this.status = status;
  }
}

/** The run's request budget is spent: stop for this run, resume next run. */
export class BudgetExhaustedError extends SourceError {
  constructor() {
    super("registry request budget of this run spent");
    this.name = "RegistryBudgetExhausted";
  }
}

/** An answer other than 2xx / 429 / 503 (e.g. 404 for one project): not retried. */
export class HttpStatusError extends SourceError {
  readonly status: number;
  constructor(status: number) {
    super(`registry source answered ${status}`);
    this.name = "RegistrySourceError";
    this.status = status;
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After as milliseconds from `now` (delta-seconds or an HTTP date); null when absent or unparsable. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (!Number.isFinite(at) || !/[a-z]/i.test(v)) return null;
  return Math.max(0, at - now);
}

const RETRY_STATUS = new Set([429, 503]);

export class PoliteClient {
  readonly #o: Required<Omit<PoliteOptions, "maxRequests">> & { maxRequests: number };
  #queue: Promise<unknown> = Promise.resolve();
  #lastStart = Number.NEGATIVE_INFINITY;
  #requests = 0;
  #broken: RateLimitedError | null = null;

  constructor(opts: PoliteOptions = {}) {
    this.#o = {
      minIntervalMs: opts.minIntervalMs ?? 1000,
      maxAttempts: Math.max(1, opts.maxAttempts ?? 4),
      backoffBaseMs: opts.backoffBaseMs ?? 2000,
      backoffCapMs: opts.backoffCapMs ?? 60_000,
      maxRetryAfterMs: opts.maxRetryAfterMs ?? 300_000,
      maxRequests: opts.maxRequests ?? Number.POSITIVE_INFINITY,
      timeoutMs: opts.timeoutMs ?? 30_000,
      sleep: opts.sleep ?? abortableSleep,
      random: opts.random ?? Math.random,
      now: opts.now ?? Date.now,
    };
  }

  /** Requests made so far (every attempt counts). */
  get requests(): number {
    return this.#requests;
  }

  /** GET `url`, serialised with every other request of this client; resolves with a 2xx response. */
  get(url: string, signal: AbortSignal): Promise<Response> {
    const run = this.#queue.then(() => this.#get(url, signal));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #get(url: string, signal: AbortSignal): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      if (this.#broken) throw this.#broken;
      if (this.#requests >= this.#o.maxRequests) throw new BudgetExhaustedError();
      await this.#o.sleep(this.#lastStart + this.#o.minIntervalMs - this.#o.now(), signal);
      this.#lastStart = this.#o.now();
      this.#requests += 1;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { accept: "application/json", "user-agent": "scf-analytics-registry-sync/1" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.#o.timeoutMs)]),
        });
      } catch (err) {
        if (signal.aborted || attempt >= this.#o.maxAttempts) throw err;
        await this.#o.sleep(this.#backoff(attempt), signal);
        continue;
      }
      if (res.ok) return res;
      await res.body?.cancel().catch(() => {});
      if (!RETRY_STATUS.has(res.status)) throw new HttpStatusError(res.status);
      const after = retryAfterMs(res.headers.get("retry-after"), this.#o.now());
      if (after !== null && after > this.#o.maxRetryAfterMs) {
        this.#broken = new RateLimitedError(
          res.status === 429 ? 429 : 503,
          "registry source asked for a pause longer than one run waits",
        );
        throw this.#broken;
      }
      if (attempt >= this.#o.maxAttempts) {
        this.#broken = new RateLimitedError(res.status === 429 ? 429 : 503);
        throw this.#broken;
      }
      await this.#o.sleep(after ?? this.#backoff(attempt), signal);
    }
  }

  /** Full jitter: uniform in [0, min(cap, base·2^(attempt−1))]. */
  #backoff(attempt: number): number {
    const ceil = Math.min(this.#o.backoffCapMs, this.#o.backoffBaseMs * 2 ** (attempt - 1));
    return Math.floor(this.#o.random() * ceil);
  }
}
