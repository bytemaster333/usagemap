// SPDX-License-Identifier: Apache-2.0
// The concurrency gate of the SCF-operator console reads (src/http/concurrency.ts).

import { describe, expect, it } from "vitest";
import { ConcurrencyGate } from "../../src/http/concurrency.ts";
import { ApiError } from "../../src/http/problem.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ConcurrencyGate", () => {
  it("runs at most `limit` at once and hands each freed slot to the next waiter in order", async () => {
    const gate = new ConcurrencyGate({ limit: 2, waitMs: 1_000 });
    const started: number[] = [];
    const blockers = [deferred(), deferred(), deferred(), deferred()];
    const runs = blockers.map((b, i) =>
      gate.run(async () => {
        started.push(i);
        await b.promise;
        return i;
      }),
    );
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual([0, 1]);
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(2);
    blockers[1]?.resolve();
    await runs[1];
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual([0, 1, 2]);
    for (const b of blockers) b.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(gate.active).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("a slot is released when the work throws", async () => {
    const gate = new ConcurrencyGate({ limit: 1, waitMs: 1_000 });
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(gate.active).toBe(0);
    expect(await gate.run(async () => 7)).toBe(7);
  });

  it("a request that cannot start within the wait gets 503 unavailable with Retry-After, and leaves the queue", async () => {
    const gate = new ConcurrencyGate({ limit: 1, waitMs: 20, retryAfterSeconds: 3 });
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const err = await gate.run(async () => "never").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).code).toBe("unavailable");
    expect((err as ApiError).retryAfter).toBe(3);
    expect(gate.waiting).toBe(0);
    hold.resolve();
    await first;
    expect(gate.active).toBe(0);
  });

  it("refuses a limit below 1", () => {
    expect(() => new ConcurrencyGate({ limit: 0, waitMs: 1 })).toThrow();
  });
});
