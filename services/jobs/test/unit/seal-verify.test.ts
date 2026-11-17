// SPDX-License-Identifier: Apache-2.0
// Seal history walk and the reset proof, without a database or a network.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/schedule.ts";
import {
  networkInstanceOf,
  RESET_CONFIRM_AFTER_MS,
  ResetConfirmations,
} from "../../src/seal/daily-seal.ts";
import type { HistoryTransaction, NetworkRoot, SealLedger } from "../../src/seal/horizon.ts";
import { buildDayTree, ZERO_ROOT } from "../../src/seal/merkle.ts";
import { compareSealHistory, type SealDay } from "../../src/seal/verify.ts";

const ACCT = `G${"A".repeat(55)}`;
const OTHER = `G${"B".repeat(55)}`;

/** A chain of `n` confirmed days with one seal transaction each, as the job leaves it. */
function chain(n: number, first = "2031-01-01") {
  const days: SealDay[] = [];
  const txs: HistoryTransaction[] = [];
  let prev = ZERO_ROOT;
  for (let i = 0; i < n; i++) {
    const day = addDays(first, i);
    const anchor = randomBytes(32);
    const t = buildDayTree({
      network: "testnet",
      day,
      prevRoot: prev,
      auditAnchorSha256: anchor,
      snapshots: [],
    });
    const hash = randomBytes(32);
    days.push({
      day,
      prev_root: prev,
      audit_anchor_sha256: anchor,
      head_path: t.headPath,
      root: t.root,
      status: "confirmed",
      tx_hash: hash,
      ledger: 100 + i * 10,
      source_account: ACCT,
    });
    txs.push({
      hash: hash.toString("hex"),
      ledger: 100 + i * 10,
      successful: true,
      createdAt: new Date(),
      memoHashHex: t.root.toString("hex"),
      sourceAccount: ACCT,
    });
    prev = t.root;
  }
  return { days, txs };
}

const cmp = (days: SealDay[], txs: HistoryTransaction[], elder: number | null = null) =>
  compareSealHistory("testnet", days, new Map([[ACCT, txs]]), elder);
const codes = (r: ReturnType<typeof cmp>) => r.problems.map((p) => `${p.problem}:${p.day ?? "-"}`);

describe("compareSealHistory", () => {
  it("a clean chain has no problem; a funding transaction of another source is ignored", () => {
    const { days, txs } = chain(4);
    const funding: HistoryTransaction = {
      hash: "ff".repeat(32),
      ledger: 50,
      successful: true,
      createdAt: new Date(),
      memoHashHex: null,
      sourceAccount: OTHER,
    };
    const r = cmp(days, [funding, ...txs]);
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ daysChecked: 4, notCheckable: 0, transactions: 5 });
  });

  it("detects a rewritten root (memo, root and the next day's chain link)", () => {
    const { days, txs } = chain(3);
    (days[1] as SealDay).root = randomBytes(32);
    expect(codes(cmp(days, txs)).sort()).toEqual(
      ["chain_break:2031-01-03", "memo_mismatch:2031-01-02", "root_mismatch:2031-01-02"].sort(),
    );
  });

  it("detects a deleted and rebuilt day: its original transaction is an unknown seal", () => {
    const { days, txs } = chain(3);
    const rebuilt = chain(1, "2031-01-03").days[0] as SealDay; // a different root for the last day
    const r = cmp(
      [
        days[0] as SealDay,
        days[1] as SealDay,
        {
          ...rebuilt,
          prev_root: days[1]?.root as Buffer,
          tx_hash: null,
          status: "built",
          ledger: null,
        },
      ],
      txs,
    );
    expect(r.problems.map((p) => p.problem)).toContain("unknown_seal_tx");
    expect(r.problems.find((p) => p.problem === "unknown_seal_tx")?.tx_hash).toBe(txs[2]?.hash);
  });

  it("detects a confirmed day whose transaction is not in the history, unless the history does not reach it", () => {
    const { days, txs } = chain(3);
    expect(codes(cmp(days, [txs[0], txs[2]] as HistoryTransaction[]))).toEqual([
      "confirmed_tx_missing:2031-01-02",
    ]);
    const bounded = cmp(days, [txs[2]] as HistoryTransaction[], 120);
    expect(bounded.problems).toEqual([]);
    expect(bounded).toMatchObject({ daysChecked: 1, notCheckable: 2 });
  });

  it("detects a ledger mismatch and seals out of day order", () => {
    const { days, txs } = chain(3);
    (days[0] as SealDay).ledger = 99;
    (txs[1] as HistoryTransaction).ledger = 125; // day 2's transaction after day 3's
    expect(codes(cmp(days, txs)).sort()).toEqual(
      [
        "ledger_mismatch:2031-01-01",
        "ledger_mismatch:2031-01-02",
        "out_of_order:2031-01-02",
      ].sort(),
    );
  });

  it("counts network_reset days as not checkable", () => {
    const { days } = chain(2);
    for (const d of days) d.status = "network_reset";
    expect(cmp(days, [])).toMatchObject({ problems: [], notCheckable: 2, daysChecked: 0 });
  });
});

function fakeLedger(closed: Record<number, string>): SealLedger {
  return {
    root: async () => {
      throw new Error("unused");
    },
    account: async () => null,
    submit: async () => ({ kind: "pending" }),
    transaction: async () => null,
    ledgerClosedAt: async (n) => (closed[n] ? new Date(closed[n] as string) : null),
    transactionsOf: async function* () {},
    fund: async () => "exists",
  };
}

const root = (o: Partial<NetworkRoot>): NetworkRoot => ({
  latestLedger: 1000,
  latestClosedAt: null,
  elderLedger: 2,
  passphrase: "x",
  ...o,
});

describe("networkInstanceOf", () => {
  const confirmedAt = new Date("2026-11-10T00:30:05Z");

  it("a Horizon behind us whose latest ledger closed before our confirmation proves nothing", async () => {
    const l = fakeLedger({});
    expect(
      await networkInstanceOf(
        l,
        root({ latestLedger: 500, latestClosedAt: new Date("2026-11-09T00:00:00Z") }),
        900,
        confirmedAt,
      ),
    ).toBe("unknown");
  });

  it("a lower ledger number that closed after our confirmation proves a restarted network", async () => {
    expect(
      await networkInstanceOf(
        fakeLedger({}),
        root({ latestLedger: 12, latestClosedAt: new Date("2026-12-01T00:00:00Z") }),
        900,
        confirmedAt,
      ),
    ).toBe("different");
    // without the root's close time, the latest ledger's own record is read
    expect(
      await networkInstanceOf(
        fakeLedger({ 12: "2026-12-01T00:00:00Z" }),
        root({ latestLedger: 12 }),
        900,
        confirmedAt,
      ),
    ).toBe("different");
  });

  it("our own ledger: same close time → same network; another → reset; outside history → unknown", async () => {
    const l = fakeLedger({ 900: "2026-11-10T00:30:05Z", 901: "2027-02-01T00:00:00Z" });
    expect(await networkInstanceOf(l, root({}), 900, confirmedAt)).toBe("same");
    expect(await networkInstanceOf(l, root({}), 901, confirmedAt)).toBe("different");
    expect(await networkInstanceOf(l, root({ elderLedger: 950 }), 900, confirmedAt)).toBe(
      "unknown",
    );
    expect(await networkInstanceOf(l, root({}), 902, confirmedAt)).toBe("unknown");
  });
});

describe("ResetConfirmations", () => {
  it("acts only on a proof seen again at least 50 minutes after the first", () => {
    const c = new ResetConfirmations();
    const t0 = new Date("2031-01-01T01:00:00Z");
    expect(c.confirm("testnet", t0)).toBe(false);
    expect(c.confirm("testnet", new Date(t0.getTime() + RESET_CONFIRM_AFTER_MS - 1))).toBe(false);
    expect(c.confirm("testnet", new Date(t0.getTime() + RESET_CONFIRM_AFTER_MS))).toBe(true);
    c.clear("testnet");
    expect(c.confirm("testnet", new Date(t0.getTime() + 2 * RESET_CONFIRM_AFTER_MS))).toBe(false);
  });
});
