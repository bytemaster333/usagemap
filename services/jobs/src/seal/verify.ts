// SPDX-License-Identifier: Apache-2.0
// Seal history verifier (wire-formats §m.2; C-136, C-137). The database triggers stop the job from
// rewriting a built day, but a superuser can bypass them; the only external reference is the ledger. So the verifier
// walks the FULL transaction history of every sealing account of the network (Horizon `GET /accounts/{G}/transactions`,
// ascending, every page) and compares it with every `seal_days` row of that network:
//
//   chain_break           a day's prev_root is not the previous day's root (the chain was cut or re-linked)
//   root_mismatch         the root does not follow from prev_root, the audit-anchor hash and head_path (§m.2 step 5)
//   memo_mismatch         the day's own transaction carries another root as its memo (the stored root was rewritten)
//   ledger_mismatch       the day's transaction is in another ledger than stored
//   confirmed_tx_missing  a confirmed day's transaction is not in the account's history although the history covers its
//                         ledger (the day or its transaction was replaced)
//   unknown_seal_tx       a seal transaction of the account (successful, MEMO_HASH) whose memo is no stored day's root:
//                         a day that was deleted or whose root was rewritten without a trace in its own row
//   out_of_order          seal transactions on the ledger do not follow day order
//
// Days marked `network_reset` (testnet) and confirmed days older than the endpoint's history (`history_elder_ledger`)
// are counted as not checkable, not as problems. The result is a metric (`scf_seal_history_problems`), a log line with
// counts and problem codes (day and transaction hash only — public data), and a failed run when anything is wrong.

import type { ScfDb } from "../db.ts";
import type { JobContext } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import type { HistoryTransaction, SealLedger } from "./horizon.ts";
import { rootFromHead, type SealNetwork } from "./merkle.ts";

export type SealHistoryProblem =
  | "chain_break"
  | "root_mismatch"
  | "memo_mismatch"
  | "ledger_mismatch"
  | "confirmed_tx_missing"
  | "unknown_seal_tx"
  | "out_of_order";

export interface SealDay {
  day: string;
  prev_root: Buffer;
  audit_anchor_sha256: Buffer;
  head_path: Buffer[];
  root: Buffer;
  status: "built" | "submitted" | "confirmed" | "failed" | "network_reset";
  tx_hash: Buffer | null;
  ledger: number | null;
  source_account: string | null;
}

export interface SealHistoryFinding {
  problem: SealHistoryProblem;
  day: string | null;
  tx_hash: string | null;
}

export interface SealHistoryReport {
  network: SealNetwork;
  accounts: number;
  transactions: number;
  daysChecked: number;
  notCheckable: number;
  problems: SealHistoryFinding[];
}

/** Pure comparison of the stored days with the accounts' transaction histories (exported for unit tests). */
export function compareSealHistory(
  network: SealNetwork,
  days: readonly SealDay[],
  history: ReadonlyMap<string, readonly HistoryTransaction[]>,
  elderLedger: number | null,
): Omit<SealHistoryReport, "network" | "accounts"> {
  const problems: SealHistoryFinding[] = [];
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  // 1. The stored chain on its own.
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i] as SealDay;
    const prev = sorted[i - 1];
    if (prev && !d.prev_root.equals(prev.root))
      problems.push({ problem: "chain_break", day: d.day, tx_hash: null });
    let recomputed: Buffer | null = null;
    try {
      recomputed = rootFromHead(network, d.day, d.prev_root, d.audit_anchor_sha256, d.head_path);
    } catch {
      recomputed = null;
    }
    if (!recomputed?.equals(d.root))
      problems.push({ problem: "root_mismatch", day: d.day, tx_hash: null });
  }
  // 2. The ledger against the stored days.
  const dayByRoot = new Map<string, SealDay>();
  for (const d of sorted) dayByRoot.set(d.root.toString("hex"), d);
  const txByHash = new Map<string, HistoryTransaction>();
  const seals: { tx: HistoryTransaction; account: string }[] = [];
  let transactions = 0;
  for (const [account, txs] of history) {
    for (const t of txs) {
      transactions += 1;
      txByHash.set(t.hash, t);
      if (t.successful && t.sourceAccount === account && t.memoHashHex !== null)
        seals.push({ tx: t, account });
    }
  }
  let daysChecked = 0;
  let notCheckable = 0;
  const explained = new Set<string>();
  for (const d of sorted) {
    if (d.status !== "confirmed" || !d.tx_hash || d.ledger === null) {
      if (d.status === "network_reset") notCheckable += 1;
      continue;
    }
    const hash = d.tx_hash.toString("hex");
    const t = txByHash.get(hash);
    if (!t) {
      if (elderLedger !== null && Number(d.ledger) < elderLedger) {
        notCheckable += 1;
        continue;
      }
      daysChecked += 1;
      problems.push({ problem: "confirmed_tx_missing", day: d.day, tx_hash: hash });
      continue;
    }
    daysChecked += 1;
    explained.add(hash);
    if (t.memoHashHex !== d.root.toString("hex"))
      problems.push({ problem: "memo_mismatch", day: d.day, tx_hash: hash });
    if (t.ledger !== Number(d.ledger))
      problems.push({ problem: "ledger_mismatch", day: d.day, tx_hash: hash });
  }
  let lastDay = "";
  for (const { tx } of [...seals].sort((a, b) => a.tx.ledger - b.tx.ledger)) {
    const d = dayByRoot.get(tx.memoHashHex as string);
    if (!d) {
      if (!explained.has(tx.hash))
        problems.push({ problem: "unknown_seal_tx", day: null, tx_hash: tx.hash });
      continue;
    }
    if (d.day < lastDay) problems.push({ problem: "out_of_order", day: d.day, tx_hash: tx.hash });
    else lastDay = d.day;
  }
  return { transactions, daysChecked, notCheckable, problems };
}

/** Reads the network's days, walks every sealing account's history and compares (see the header). */
export async function verifySealHistory(
  db: ScfDb,
  ledger: SealLedger,
  network: SealNetwork,
  ctx: JobContext,
  extraAccounts: readonly string[] = [],
): Promise<SealHistoryReport> {
  const days = await db.tx("daily_seal", null, (tx) =>
    tx.query<SealDay>(
      `SELECT d.day::text AS day, d.prev_root, d.audit_anchor_sha256, d.head_path, d.root, d.status, d.tx_hash,
              d.ledger, d.source_account
         FROM scf.seal_days d WHERE d.network = $1 ORDER BY d.day`,
      [network],
    ),
  );
  const accounts = [
    ...new Set(
      [...days.map((d) => d.source_account), ...extraAccounts].filter(
        (a): a is string => typeof a === "string" && /^G[A-Z2-7]{55}$/.test(a),
      ),
    ),
  ].sort();
  const root = await ledger.root();
  const history = new Map<string, HistoryTransaction[]>();
  for (const a of accounts) {
    const txs: HistoryTransaction[] = [];
    for await (const t of ledger.transactionsOf(a)) {
      checkAborted(ctx.signal);
      txs.push(t);
    }
    history.set(a, txs);
  }
  const r = compareSealHistory(network, days, history, root.elderLedger);
  return { network, accounts: accounts.length, ...r };
}
