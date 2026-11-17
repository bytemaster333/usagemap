// SPDX-License-Identifier: Apache-2.0
// Runs the on-chain fallback reader (`services/onchain-reader`, C-42, C-128) as a child process and parses its JSON
// lines strictly. The reader reads a local mirror of public Stellar ledger data files (it never downloads); the
// contract list goes to its stdin (`-contracts -`), so nothing is written to disk and the root filesystem can
// stay read-only. Its stderr is consumed for the counts-only summary line and otherwise discarded: error text (paths,
// SDK messages) is never logged — a failure is reported by exit code and a fixed reason word.
//
// Output line (C-128, the reader's README): {"contract","day","invocations","successful_invocations",
// "distinct_invokers","data_source":"ledger_files","ledgers_in_day","ledger_first","ledger_last","complete",
// "anchor_ledger","anchor_hash"}. A complete day names its anchor — the first ledger after the day
// (`ledger_last` + 1) and that ledger's hash (64 hex), which the job compares with Horizon before using the day
// (C-144); an incomplete day has both null.
// Any other field — an account, say — makes the line invalid (privacy: the reader must never emit invoker identity).

import { spawn } from "node:child_process";

export type StellarNetwork = "public" | "testnet";

export interface ReaderRow {
  contract: string;
  day: string;
  invocations: number;
  successful_invocations: number;
  distinct_invokers: number;
  data_source: "ledger_files";
  ledgers_in_day: number;
  ledger_first: number;
  ledger_last: number;
  complete: boolean;
  anchor_ledger: number | null;
  anchor_hash: string | null;
}

export interface ReadRequest {
  network: StellarNetwork;
  fromDay: string;
  toDay: string;
  contracts: string[];
}

export interface ReadResult {
  rows: ReaderRow[];
  summary: Record<string, number>;
}

/** The data source of job onchain_correlation (the reader process in production, a stand-in in tests). */
export interface OnchainSource {
  read(req: ReadRequest, signal: AbortSignal): Promise<ReadResult>;
}

export type ReaderFailure =
  | "spawn_failed"
  | "exit_nonzero"
  | "timeout"
  | "output_too_large"
  | "invalid_output";

export class ReaderError extends Error {
  override readonly name = "ReaderError";
  readonly reason: ReaderFailure;
  readonly exitCode: number | null;
  constructor(reason: ReaderFailure, exitCode: number | null = null) {
    super(`onchain-reader: ${reason}${exitCode === null ? "" : ` (exit ${exitCode})`}`);
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = [
  "contract",
  "day",
  "invocations",
  "successful_invocations",
  "distinct_invokers",
  "data_source",
  "ledgers_in_day",
  "ledger_first",
  "ledger_last",
  "complete",
  "anchor_ledger",
  "anchor_hash",
] as const;

const HASH_RE = /^[0-9a-f]{64}$/;

function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Parses one output line; throws ReaderError("invalid_output") on anything unexpected. */
export function parseReaderLine(line: string, wanted: ReadonlySet<string>): ReaderRow {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    throw new ReaderError("invalid_output");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o))
    throw new ReaderError("invalid_output");
  const r = o as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== FIELDS.length || !FIELDS.every((f) => f in r)) {
    throw new ReaderError("invalid_output");
  }
  const ok =
    typeof r.contract === "string" &&
    CONTRACT_RE.test(r.contract) &&
    wanted.has(r.contract) &&
    isDay(r.day) &&
    count(r.invocations) &&
    count(r.successful_invocations) &&
    count(r.distinct_invokers) &&
    r.successful_invocations <= r.invocations &&
    r.distinct_invokers <= r.invocations &&
    r.data_source === "ledger_files" &&
    count(r.ledgers_in_day) &&
    count(r.ledger_first) &&
    count(r.ledger_last) &&
    r.ledger_first <= r.ledger_last &&
    typeof r.complete === "boolean" &&
    (r.complete
      ? r.anchor_ledger === (r.ledger_last as number) + 1 &&
        typeof r.anchor_hash === "string" &&
        HASH_RE.test(r.anchor_hash)
      : r.anchor_ledger === null && r.anchor_hash === null);
  if (!ok) throw new ReaderError("invalid_output");
  return r as unknown as ReaderRow;
}

const SUMMARY_RE = /^onchain-reader: ((?:[a-z_]+=\d+ ?)+)$/m;

/** The counters of the reader's one-line summary on stderr (counts only); {} when absent. */
export function parseSummary(stderr: string): Record<string, number> {
  const m = SUMMARY_RE.exec(stderr);
  if (!m) return {};
  const out: Record<string, number> = {};
  for (const kv of (m[1] as string).trim().split(" ")) {
    const [k, v] = kv.split("=");
    out[k as string] = Number(v);
  }
  return out;
}

export function readerArgs(
  network: StellarNetwork,
  fromDay: string,
  toDay: string,
  ledgerDir: string,
): string[] {
  return [
    "-network",
    network === "public" ? "pubnet" : "testnet",
    "-contracts",
    "-",
    "-from-day",
    fromDay,
    "-to-day",
    toDay,
    ledgerDir,
  ];
}

export interface LedgerFileReaderOptions {
  bin: string;
  ledgerDir: string;
  timeoutMs: number;
  /** Bound on stdout (default 64 MiB; one line ≈ 250 bytes per contract and day). */
  maxOutputBytes?: number;
}

const STDERR_KEEP = 64 * 1024;

export class LedgerFileReader implements OnchainSource {
  readonly #o: Required<LedgerFileReaderOptions>;

  constructor(o: LedgerFileReaderOptions) {
    this.#o = { maxOutputBytes: 64 * 1024 * 1024, ...o };
  }

  read(req: ReadRequest, signal: AbortSignal): Promise<ReadResult> {
    const wanted = new Set(req.contracts);
    return new Promise<ReadResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      const child = spawn(
        this.#o.bin,
        readerArgs(req.network, req.fromDay, req.toDay, this.#o.ledgerDir),
        { stdio: ["pipe", "pipe", "pipe"], env: {} },
      );
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = "";
      let failure: Error | null = null;
      const fail = (e: Error): void => {
        if (failure) return;
        failure = e;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => fail(new ReaderError("timeout")), this.#o.timeoutMs);
      const onAbort = (): void => fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (b: Buffer) => {
        outBytes += b.length;
        if (outBytes > this.#o.maxOutputBytes) fail(new ReaderError("output_too_large"));
        else out.push(b);
      });
      child.stderr.on("data", (b: Buffer) => {
        if (err.length < STDERR_KEEP) err += b.toString("utf8");
      });
      child.stdin.on("error", () => {}); // the reader may exit before reading stdin (usage error)
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        return true;
      };
      child.on("error", () => {
        fail(new ReaderError("spawn_failed"));
        if (child.pid === undefined && finish()) reject(failure);
      });
      child.on("close", (code) => {
        if (!finish()) return;
        if (failure) {
          reject(failure);
          return;
        }
        if (code !== 0) {
          reject(new ReaderError("exit_nonzero", code));
          return;
        }
        try {
          const rows = Buffer.concat(out)
            .toString("utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => parseReaderLine(l, wanted));
          resolve({ rows, summary: parseSummary(err) });
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(
        [...wanted]
          .sort()
          .map((c) => `${c}\n`)
          .join(""),
      );
    });
  }
}

// ------------------------------------------------------------------------------------------------ fetch step (§p.1)

export interface FetchRequest {
  /** Network passphrase (the fetcher checks it against the store's `.config.json`). */
  passphrase: string;
  fromDay: string;
  toDay: string;
}

export interface FetchResult {
  /** true: exit 0, every requested day is in the mirror; false: exit 1, some day could not be fetched or decoded. */
  complete: boolean;
  summary: Record<string, number>;
}

/** The fill step of job onchain_correlation (C-136, plan A1): `onchain-reader fetch` into the local mirror. */
export interface LedgerMirrorFetcher {
  fetch(req: FetchRequest, signal: AbortSignal): Promise<FetchResult>;
}

export function fetchArgs(sourceUrl: string, dest: string, req: FetchRequest): string[] {
  return [
    "fetch",
    "-source",
    sourceUrl,
    "-dest",
    dest,
    "-from-day",
    req.fromDay,
    "-to-day",
    req.toDay,
    "-network",
    req.passphrase,
  ];
}

export interface LedgerFetchOptions {
  bin: string;
  sourceUrl: string;
  ledgerDir: string;
  timeoutMs: number;
}

/**
 * Runs `onchain-reader fetch` (wire-formats §p.1): exit 0 → complete, exit 1 → incomplete (the counting run then stores
 * nothing for the incomplete days), anything else → ReaderError. The fetcher never sees contract ids or tenant data;
 * its output is discarded except for the counts-only summary line on stderr.
 */
export class LedgerFileFetcher implements LedgerMirrorFetcher {
  readonly #o: LedgerFetchOptions;

  constructor(o: LedgerFetchOptions) {
    if (!o.sourceUrl.startsWith("https://")) throw new Error("ledger source must be https");
    this.#o = o;
  }

  fetch(req: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
    return new Promise<FetchResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      // HTTPS proxy settings are the only environment the fetcher inherits (egress per C-10).
      const env: Record<string, string> = {};
      for (const k of [
        "HTTPS_PROXY",
        "https_proxy",
        "NO_PROXY",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
      ]) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
      const child = spawn(this.#o.bin, fetchArgs(this.#o.sourceUrl, this.#o.ledgerDir, req), {
        stdio: ["ignore", "ignore", "pipe"],
        env,
      });
      let err = "";
      let failure: Error | null = null;
      const fail = (e: Error): void => {
        if (failure) return;
        failure = e;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => fail(new ReaderError("timeout")), this.#o.timeoutMs);
      const onAbort = (): void => fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
      signal.addEventListener("abort", onAbort, { once: true });
      child.stderr.on("data", (b: Buffer) => {
        if (err.length < STDERR_KEEP) err += b.toString("utf8");
      });
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        return true;
      };
      child.on("error", () => {
        fail(new ReaderError("spawn_failed"));
        if (child.pid === undefined && finish()) reject(failure);
      });
      child.on("close", (code) => {
        if (!finish()) return;
        if (failure) reject(failure);
        else if (code === 0) resolve({ complete: true, summary: parseFetchSummary(err) });
        else if (code === 1) resolve({ complete: false, summary: parseFetchSummary(err) });
        else reject(new ReaderError("exit_nonzero", code));
      });
    });
  }
}

const FETCH_SUMMARY_RE = /^onchain-reader(?: fetch)?: ((?:[a-z_]+=\d+ ?)+)$/m;

/** Counts of the fetcher's summary line (`onchain-reader fetch: files=… bytes=…`); {} when absent. */
export function parseFetchSummary(stderr: string): Record<string, number> {
  const m = FETCH_SUMMARY_RE.exec(stderr);
  if (!m) return {};
  const out: Record<string, number> = {};
  for (const kv of (m[1] as string).trim().split(" ")) {
    const [k, v] = kv.split("=");
    out[k as string] = Number(v);
  }
  return out;
}
