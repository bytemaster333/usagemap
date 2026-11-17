// SPDX-License-Identifier: Apache-2.0
// The network's copy of a ledger hash, for the day-anchor check of job onchain_correlation (register C-144). The
// on-chain reader verifies every ledger against its own header and the chain between consecutive ledgers, so a store
// cannot alter one ledger — but a store serving a whole forged, self-consistent chain would pass. For each complete
// day the reader names an anchor (the first ledger after the day) and its hash; through the verified chain that hash
// commits to every ledger of the day. The job compares it with Horizon's `GET /ledgers/{seq}` `hash` before the day's
// counts are used.
//
// Public data only: the request carries a ledger sequence, never a contract, account or tenant (C-10).

export interface LedgerHashSource {
  /**
   * The hash (64 lower-case hex) of ledger `seq` as the network knows it, or null when this source does not have that
   * ledger (404: outside its retained history, or not closed yet). Throws LedgerHashUnavailableError when the source
   * cannot answer (network error, 5xx, malformed body).
   */
  ledgerHash(seq: number, signal: AbortSignal): Promise<string | null>;
}

export class LedgerHashUnavailableError extends Error {
  override readonly name = "LedgerHashUnavailable";
}

const HASH_RE = /^[0-9a-f]{64}$/;

export interface HorizonLedgerHashesOptions {
  horizonUrl: string;
  timeoutMs?: number;
}

export class HorizonLedgerHashes implements LedgerHashSource {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(o: HorizonLedgerHashesOptions) {
    this.#base = o.horizonUrl.replace(/\/+$/, "");
    this.#timeoutMs = o.timeoutMs ?? 20_000;
  }

  async ledgerHash(seq: number, signal: AbortSignal): Promise<string | null> {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > 0xffff_ffff)
      throw new RangeError("ledger sequence out of range");
    let res: Response;
    try {
      res = await fetch(`${this.#base}/ledgers/${seq}`, {
        headers: { accept: "application/json", "user-agent": "scf-analytics-onchain/1" },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new LedgerHashUnavailableError("horizon unreachable");
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new LedgerHashUnavailableError(`horizon answered ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new LedgerHashUnavailableError("horizon body is not JSON");
    }
    const b = body as { sequence?: unknown; hash?: unknown } | null;
    // The record must be the ledger asked for; a hash of another ledger is no evidence either way.
    if (b?.sequence !== seq || typeof b.hash !== "string" || !HASH_RE.test(b.hash.toLowerCase()))
      throw new LedgerHashUnavailableError("horizon ledger record malformed");
    return b.hash.toLowerCase();
  }
}
