// SPDX-License-Identifier: Apache-2.0
// A small in-process concurrency gate. The SCF-operator console reads (`GET /v1/operator/...`) are the heaviest reads
// of this service, and every one appends to the platform audit chain (op_begin, data-model §5), whose head row is
// locked until commit, so they run one after another in the database anyway. Without a gate a burst of them occupies
// every pooled connection while waiting on that lock, and the session lookup of every other request (sign-in, sign-out,
// tenant pages) then times out waiting for a connection. The gate keeps them to a few connections; a request that
// cannot start within the wait gets 503 with Retry-After instead of a bare 500.

import { ApiError } from "./problem.ts";

export class ConcurrencyGate {
  readonly #limit: number;
  readonly #waitMs: number;
  readonly #retryAfter: number;
  #active = 0;
  readonly #queue: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

  constructor(opts: { limit: number; waitMs: number; retryAfterSeconds?: number }) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error("limit must be ≥ 1");
    this.#limit = opts.limit;
    this.#waitMs = opts.waitMs;
    this.#retryAfter = opts.retryAfterSeconds ?? 5;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /** Runs `fn` once a slot is free; 503 `unavailable` (Retry-After) when none frees up within the wait. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.#queue.indexOf(entry);
          if (i >= 0) this.#queue.splice(i, 1);
          reject(
            new ApiError("unavailable", "the operator console is busy; retry shortly", {
              retryAfter: this.#retryAfter,
            }),
          );
        }, this.#waitMs),
      };
      this.#queue.push(entry);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    // The slot passes straight to the next waiter (active stays the same); otherwise it is freed.
    if (next) next.grant();
    else this.#active--;
  }
}
