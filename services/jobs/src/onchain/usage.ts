// SPDX-License-Identifier: Apache-2.0
// Runs `onchain-reader usage` (services/onchain-reader, README "Usage map") as a child process for job usage_map and
// parses its JSON lines strictly. The reader reads the same local mirror of public ledger files as onchain_correlation;
// the "<group> <contract>" pairs go to its stdin (`-groups -`), groups being registry project ids. Its stderr is
// consumed for the counts-only summary line and otherwise discarded (error text is never logged).
//
// Line kinds (in this order): day, group, contract, function, week. Any unknown field — an account, say — makes the
// line invalid (privacy: the reader never emits invoker identity; distinct values are counted in its memory only).

import { spawn } from "node:child_process";
import { parseSummary, ReaderError, type StellarNetwork } from "./reader.ts";

export interface UsageDay {
  kind: "day";
  day: string;
  ledgers_in_day: number;
  ledger_first: number;
  ledger_last: number;
  complete: boolean;
  anchor_ledger: number | null;
  anchor_hash: string | null;
}
export interface UsageGroup {
  kind: "group";
  group: string;
  day: string;
  invocations: number;
  successful_invocations: number;
  distinct_invokers: number;
  contract_calls: number;
  contracts_invoked: number;
}
export interface UsageContract {
  kind: "contract";
  contract: string;
  day: string;
  invocations: number;
  successful_invocations: number;
  distinct_invokers: number;
  contract_calls: number;
  successful_contract_calls: number;
}
export interface UsageFunction {
  kind: "function";
  contract: string;
  day: string;
  function: string;
  caller_kind: "account" | "contract";
  calls: number;
  successful_calls: number;
}
export interface UsageWeek {
  kind: "week";
  group: string;
  week_start: string;
  active_accounts: number;
  active_accounts_successful: number;
  invocations: number;
  successful_invocations: number;
  contract_calls: number;
}
export type UsageLine = UsageDay | UsageGroup | UsageContract | UsageFunction | UsageWeek;

export interface UsageOutput {
  days: UsageDay[];
  groups: UsageGroup[];
  contracts: UsageContract[];
  functions: UsageFunction[];
  weeks: UsageWeek[];
  summary: Record<string, number>;
}

export interface UsageMember {
  group: string;
  contract: string;
}

export interface UsageRequest {
  network: StellarNetwork;
  fromDay: string;
  toDay: string;
  members: UsageMember[];
}

/** The data source of job usage_map (the reader process in production, a stand-in in unit tests). */
export interface UsageSource {
  read(req: UsageRequest, signal: AbortSignal): Promise<UsageOutput>;
}

const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const GROUP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const FUNCTION_RE = /^([A-Za-z0-9_]{1,32}|\(other\)|\(invalid\))$/;

const FIELDS: Record<UsageLine["kind"], readonly string[]> = {
  day: [
    "kind",
    "day",
    "ledgers_in_day",
    "ledger_first",
    "ledger_last",
    "complete",
    "anchor_ledger",
    "anchor_hash",
  ],
  group: [
    "kind",
    "group",
    "day",
    "invocations",
    "successful_invocations",
    "distinct_invokers",
    "contract_calls",
    "contracts_invoked",
  ],
  contract: [
    "kind",
    "contract",
    "day",
    "invocations",
    "successful_invocations",
    "distinct_invokers",
    "contract_calls",
    "successful_contract_calls",
  ],
  function: ["kind", "contract", "day", "function", "caller_kind", "calls", "successful_calls"],
  week: [
    "kind",
    "group",
    "week_start",
    "active_accounts",
    "active_accounts_successful",
    "invocations",
    "successful_invocations",
    "contract_calls",
  ],
};

const n = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Parses one output line against the run's groups and contracts; throws ReaderError("invalid_output"). */
export function parseUsageLine(
  line: string,
  groups: ReadonlySet<string>,
  contracts: ReadonlySet<string>,
): UsageLine {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    throw new ReaderError("invalid_output");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o))
    throw new ReaderError("invalid_output");
  const r = o as Record<string, unknown>;
  const fields = FIELDS[r.kind as UsageLine["kind"]];
  if (!fields) throw new ReaderError("invalid_output");
  const keys = Object.keys(r);
  if (keys.length !== fields.length || !fields.every((f) => f in r))
    throw new ReaderError("invalid_output");
  const group = () => typeof r.group === "string" && GROUP_RE.test(r.group) && groups.has(r.group);
  const contract = () =>
    typeof r.contract === "string" && CONTRACT_RE.test(r.contract) && contracts.has(r.contract);
  let ok: boolean;
  switch (r.kind) {
    case "day":
      ok =
        isDay(r.day) &&
        n(r.ledgers_in_day) &&
        n(r.ledger_first) &&
        n(r.ledger_last) &&
        r.ledger_first <= r.ledger_last &&
        typeof r.complete === "boolean" &&
        (r.complete
          ? r.ledgers_in_day > 0 &&
            r.anchor_ledger === (r.ledger_last as number) + 1 &&
            typeof r.anchor_hash === "string" &&
            HASH_RE.test(r.anchor_hash)
          : r.anchor_ledger === null && r.anchor_hash === null);
      break;
    case "group":
      ok =
        group() &&
        isDay(r.day) &&
        n(r.invocations) &&
        n(r.successful_invocations) &&
        n(r.distinct_invokers) &&
        n(r.contract_calls) &&
        n(r.contracts_invoked) &&
        r.successful_invocations <= r.invocations &&
        r.distinct_invokers <= r.invocations;
      break;
    case "contract":
      ok =
        contract() &&
        isDay(r.day) &&
        n(r.invocations) &&
        n(r.successful_invocations) &&
        n(r.distinct_invokers) &&
        n(r.contract_calls) &&
        n(r.successful_contract_calls) &&
        r.successful_invocations <= r.invocations &&
        r.distinct_invokers <= r.invocations &&
        r.successful_contract_calls <= r.contract_calls;
      break;
    case "function":
      ok =
        contract() &&
        isDay(r.day) &&
        typeof r.function === "string" &&
        FUNCTION_RE.test(r.function) &&
        (r.caller_kind === "account" || r.caller_kind === "contract") &&
        n(r.calls) &&
        r.calls > 0 &&
        n(r.successful_calls) &&
        r.successful_calls <= r.calls;
      break;
    case "week":
      ok =
        group() &&
        isDay(r.week_start) &&
        new Date(`${r.week_start}T00:00:00Z`).getUTCDay() === 1 &&
        n(r.active_accounts) &&
        n(r.active_accounts_successful) &&
        n(r.invocations) &&
        n(r.successful_invocations) &&
        n(r.contract_calls) &&
        r.active_accounts_successful <= r.active_accounts &&
        r.active_accounts <= r.invocations &&
        r.successful_invocations <= r.invocations;
      break;
    default:
      ok = false;
  }
  if (!ok) throw new ReaderError("invalid_output");
  return r as unknown as UsageLine;
}

/** Splits parsed lines by kind (the reader's order is not relied upon). */
export function collect(lines: UsageLine[], summary: Record<string, number>): UsageOutput {
  const out: UsageOutput = {
    days: [],
    groups: [],
    contracts: [],
    functions: [],
    weeks: [],
    summary,
  };
  for (const l of lines) {
    if (l.kind === "day") out.days.push(l);
    else if (l.kind === "group") out.groups.push(l);
    else if (l.kind === "contract") out.contracts.push(l);
    else if (l.kind === "function") out.functions.push(l);
    else out.weeks.push(l);
  }
  return out;
}

export function usageArgs(
  network: StellarNetwork,
  fromDay: string,
  toDay: string,
  ledgerDir: string,
): string[] {
  return [
    "usage",
    "-network",
    network === "public" ? "pubnet" : "testnet",
    "-groups",
    "-",
    "-from-day",
    fromDay,
    "-to-day",
    toDay,
    ledgerDir,
  ];
}

export interface UsageReaderOptions {
  bin: string;
  ledgerDir: string;
  timeoutMs: number;
  /** Bound on stdout (default 256 MiB). */
  maxOutputBytes?: number;
}

const STDERR_KEEP = 64 * 1024;

export class LedgerUsageReader implements UsageSource {
  readonly #o: Required<UsageReaderOptions>;

  constructor(o: UsageReaderOptions) {
    this.#o = { maxOutputBytes: 256 * 1024 * 1024, ...o };
  }

  read(req: UsageRequest, signal: AbortSignal): Promise<UsageOutput> {
    const groups = new Set(req.members.map((m) => m.group));
    const contracts = new Set(req.members.map((m) => m.contract));
    return new Promise<UsageOutput>((resolve, reject) => {
      if (signal.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      const child = spawn(
        this.#o.bin,
        usageArgs(req.network, req.fromDay, req.toDay, this.#o.ledgerDir),
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
      child.stdin.on("error", () => {});
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
          const lines = Buffer.concat(out)
            .toString("utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => parseUsageLine(l, groups, contracts));
          resolve(
            collect(
              lines,
              parseSummary(err.replace(/^onchain-reader usage: /m, "onchain-reader: ")),
            ),
          );
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(
        req.members
          .map((m) => `${m.group} ${m.contract}\n`)
          .sort()
          .join(""),
      );
    });
  }
}
