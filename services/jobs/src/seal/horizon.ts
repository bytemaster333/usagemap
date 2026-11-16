// SPDX-License-Identifier: Apache-2.0
// The sealing network as job `daily_seal` sees it (wire-formats §m.2): Horizon (`SCF_SEAL_HORIZON_URL`) for the
// network's latest ledger (and its close time), a ledger's close time, the sealing account's sequence and its full
// transaction history (the history walk of the seal verifier), submission and transaction look-up;
// friendbot (`SCF_SEAL_FRIENDBOT_URL`, testnet only) to (re-)fund the sealing account after a testnet reset. Requests
// carry the platform's own public account id, ledger numbers and transaction hashes only — never tenant data (C-10).

export interface NetworkRoot {
  /** Latest ledger Horizon has ingested. */
  latestLedger: number;
  /** Close time of that ledger (`history_latest_ledger_closed_at`), or null when Horizon does not say. */
  latestClosedAt: Date | null;
  /** Oldest ledger in Horizon's history (bounded history: older look-ups answer 404 without meaning "not found"). */
  elderLedger: number | null;
  passphrase: string | null;
}

export interface FoundTransaction {
  ledger: number;
  successful: boolean;
  createdAt: Date;
  memoHashHex: string | null;
  sourceAccount: string | null;
}

/** One transaction of the sealing account's history (Horizon `GET /accounts/{G}/transactions`, ascending). */
export interface HistoryTransaction extends FoundTransaction {
  hash: string;
}

export type SubmitResult =
  | { kind: "confirmed"; ledger: number; createdAt: Date }
  | { kind: "rejected"; code: string }
  /** Unknown outcome (timeout, 5xx): look the hash up later. */
  | { kind: "pending" };

export interface SealLedger {
  root(): Promise<NetworkRoot>;
  /** The account's current sequence number, or null when the account does not exist on the network. */
  account(account: string): Promise<{ sequence: bigint } | null>;
  submit(envelopeB64: string): Promise<SubmitResult>;
  transaction(hashHex: string): Promise<FoundTransaction | null>;
  /** Close time of a ledger; null when this endpoint does not have it (404: outside its history or not yet closed). */
  ledgerClosedAt(sequence: number): Promise<Date | null>;
  /**
   * Every transaction the account is part of, oldest first (successful ones; paged until the end). Empty when the
   * account does not exist on the network.
   */
  transactionsOf(account: string): AsyncIterable<HistoryTransaction>;
  /** Funds the account through friendbot (testnet); "exists" when it is already funded. */
  fund(account: string): Promise<"funded" | "exists">;
}

export class SealLedgerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealLedgerUnavailable";
  }
}

const UA = "scf-analytics-daily-seal/1";
const CODE_RE = /^[a-z_]{1,40}$/;
const PAGE = 200;
/** Upper bound of history pages one walk reads (400,000 transactions: more than a century of daily seals). */
const MAX_HISTORY_PAGES = 2_000;

export class HorizonSealLedger implements SealLedger {
  readonly #horizon: string;
  readonly #friendbot: string | null;
  readonly #timeoutMs: number;
  readonly #page: number;

  constructor(o: {
    horizonUrl: string;
    friendbotUrl: string | null;
    timeoutMs?: number;
    /** History page size (Horizon's maximum and the default: 200). */
    historyPageSize?: number;
  }) {
    this.#horizon = o.horizonUrl.replace(/\/+$/, "");
    this.#friendbot = o.friendbotUrl;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#page = Math.min(Math.max(o.historyPageSize ?? PAGE, 1), PAGE);
  }

  async #get(url: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": UA },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new SealLedgerUnavailable("horizon unreachable");
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return { status: 404, body: null };
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new SealLedgerUnavailable(`horizon answered ${res.status}`);
    }
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async root(): Promise<NetworkRoot> {
    const { body } = await this.#get(`${this.#horizon}/`);
    const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
    const latest = n(body?.history_latest_ledger) ?? n(body?.core_latest_ledger);
    if (latest === null) throw new SealLedgerUnavailable("horizon root without a latest ledger");
    const closed =
      typeof body?.history_latest_ledger_closed_at === "string"
        ? new Date(body.history_latest_ledger_closed_at)
        : null;
    return {
      latestLedger: latest,
      latestClosedAt: closed && !Number.isNaN(closed.getTime()) ? closed : null,
      elderLedger: n(body?.history_elder_ledger),
      passphrase: typeof body?.network_passphrase === "string" ? body.network_passphrase : null,
    };
  }

  async account(account: string): Promise<{ sequence: bigint } | null> {
    if (!/^G[A-Z2-7]{55}$/.test(account)) throw new Error("account");
    const { status, body } = await this.#get(`${this.#horizon}/accounts/${account}`);
    if (status === 404) return null;
    const seq = body?.sequence;
    if (typeof seq !== "string" || !/^\d{1,19}$/.test(seq))
      throw new SealLedgerUnavailable("horizon account without a sequence");
    return { sequence: BigInt(seq) };
  }

  async submit(envelopeB64: string): Promise<SubmitResult> {
    let res: Response;
    try {
      res = await fetch(`${this.#horizon}/transactions`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
        body: new URLSearchParams({ tx: envelopeB64 }).toString(),
        signal: AbortSignal.timeout(Math.max(this.#timeoutMs, 60_000)),
      });
    } catch {
      return { kind: "pending" };
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // keep {}
    }
    if (res.ok) {
      const ledger = body.ledger;
      if (typeof ledger !== "number" || body.successful === false) return { kind: "pending" };
      const at = typeof body.created_at === "string" ? new Date(body.created_at) : new Date();
      return { kind: "confirmed", ledger, createdAt: Number.isNaN(at.getTime()) ? new Date() : at };
    }
    if (res.status === 400) {
      const codes = (body.extras as { result_codes?: { transaction?: unknown } } | undefined)
        ?.result_codes;
      const code = typeof codes?.transaction === "string" ? codes.transaction : "tx_malformed";
      return { kind: "rejected", code: CODE_RE.test(code) ? code : "tx_malformed" };
    }
    return { kind: "pending" };
  }

  async transaction(hashHex: string): Promise<FoundTransaction | null> {
    if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new Error("hash");
    const { status, body } = await this.#get(`${this.#horizon}/transactions/${hashHex}`);
    if (status === 404 || !body) return null;
    return parseTransaction(body);
  }

  async ledgerClosedAt(sequence: number): Promise<Date | null> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("ledger");
    const { status, body } = await this.#get(`${this.#horizon}/ledgers/${sequence}`);
    if (status === 404 || !body) return null;
    const at = typeof body.closed_at === "string" ? new Date(body.closed_at) : null;
    if (!at || Number.isNaN(at.getTime()))
      throw new SealLedgerUnavailable("horizon ledger without a close time");
    return at;
  }

  async *transactionsOf(account: string): AsyncIterable<HistoryTransaction> {
    if (!/^G[A-Z2-7]{55}$/.test(account)) throw new Error("account");
    let url: string | null =
      `${this.#horizon}/accounts/${account}/transactions?order=asc&limit=${this.#page}&include_failed=false`;
    for (let page = 0; url !== null; page++) {
      if (page >= MAX_HISTORY_PAGES)
        throw new SealLedgerUnavailable("seal account history longer than the walk's bound");
      const { status, body } = await this.#get(url);
      if (status === 404 || !body) return; // no such account on this network
      const b = body as {
        _embedded?: { records?: Array<Record<string, unknown>> };
        _links?: { next?: { href?: unknown } };
      };
      const records = b._embedded?.records ?? [];
      for (const r of records) {
        const hash = r.hash;
        if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
          throw new SealLedgerUnavailable("horizon transaction without a hash");
        yield { hash, ...parseTransaction(r) };
      }
      if (records.length < this.#page) return;
      const next = b._links?.next?.href;
      // Follow only links on the same Horizon (never an arbitrary host from a response).
      url = typeof next === "string" && next.startsWith(`${this.#horizon}/`) ? next : null;
      if (url === null) throw new SealLedgerUnavailable("horizon history page without a next link");
    }
  }

  async fund(account: string): Promise<"funded" | "exists"> {
    if (!this.#friendbot) throw new SealLedgerUnavailable("no friendbot configured");
    if (!/^G[A-Z2-7]{55}$/.test(account)) throw new Error("account");
    let res: Response;
    try {
      res = await fetch(`${this.#friendbot}/?addr=${account}`, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(Math.max(this.#timeoutMs, 60_000)),
      });
    } catch {
      throw new SealLedgerUnavailable("friendbot unreachable");
    }
    const text = await res.text();
    if (res.ok) return "funded";
    // Friendbot answers 400 when the account exists already.
    if (res.status === 400 && /already|exist/i.test(text)) return "exists";
    throw new SealLedgerUnavailable(`friendbot answered ${res.status}`);
  }
}

function parseTransaction(body: Record<string, unknown>): FoundTransaction {
  const ledger = body.ledger;
  if (typeof ledger !== "number")
    throw new SealLedgerUnavailable("horizon transaction without ledger");
  const at = typeof body.created_at === "string" ? new Date(body.created_at) : new Date(Number.NaN);
  const memo =
    body.memo_type === "hash" && typeof body.memo === "string"
      ? Buffer.from(body.memo, "base64").toString("hex")
      : null;
  return {
    ledger,
    successful: body.successful === true,
    createdAt: Number.isNaN(at.getTime()) ? new Date() : at,
    memoHashHex: memo,
    sourceAccount: typeof body.source_account === "string" ? body.source_account : null,
  };
}
