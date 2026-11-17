// SPDX-License-Identifier: Apache-2.0
// Runs `onchain-reader protocols` (services/onchain-reader, README "Protocol interactions") as a child process for
// job protocol_usage and parses its JSON lines strictly. Input on stdin: "group <label> <C…>" lines (registry projects
// and tenants) and "protocol <id> <C…>" lines (the curated registry). Line kinds: day, group, protocol, network. Any
// unknown field makes the line invalid — a contract, an account, or the "dev": true label of a development network
// (a local Quickstart): development figures can never be stored as network figures.

import { spawn } from "node:child_process";
import { parseSummary, ReaderError, type StellarNetwork } from "../reader.ts";
import { PROTOCOL_IDS, type ProtocolId } from "./registry.ts";

export interface ProtoDay {
  kind: "day";
  day: string;
  ledgers_in_day: number;
  ledger_first: number;
  ledger_last: number;
  complete: boolean;
  anchor_ledger: number | null;
  anchor_hash: string | null;
}
export interface ProtoGroup {
  kind: "group";
  group: string;
  day: string;
  transactions: number;
  successful_transactions: number;
}
export interface ProtoProtocol {
  kind: "protocol";
  group: string;
  day: string;
  protocol: ProtocolId;
  transactions: number;
  successful_transactions: number;
}
export interface ProtoNetwork {
  kind: "network";
  day: string;
  protocol: ProtocolId;
  transactions: number;
  successful_transactions: number;
}
export type ProtoLine = ProtoDay | ProtoGroup | ProtoProtocol | ProtoNetwork;

export interface ProtoOutput {
  days: ProtoDay[];
  groups: ProtoGroup[];
  protocols: ProtoProtocol[];
  network: ProtoNetwork[];
  summary: Record<string, number>;
}

export interface ProtoRequest {
  network: StellarNetwork;
  fromDay: string;
  toDay: string;
  members: { group: string; contract: string }[];
  protocols: { protocol: ProtocolId; contract: string }[];
}

/** The data source of job protocol_usage (the reader process in production, a stand-in in unit tests). */
export interface ProtoSource {
  read(req: ProtoRequest, signal: AbortSignal): Promise<ProtoOutput>;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const FIELDS: Record<ProtoLine["kind"], readonly string[]> = {
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
  group: ["kind", "group", "day", "transactions", "successful_transactions"],
  protocol: ["kind", "group", "day", "protocol", "transactions", "successful_transactions"],
  network: ["kind", "day", "protocol", "transactions", "successful_transactions"],
};

const n = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Parses one output line against the run's groups and protocols; throws ReaderError("invalid_output"). */
export function parseProtoLine(
  line: string,
  groups: ReadonlySet<string>,
  protocols: ReadonlySet<string>,
): ProtoLine {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    throw new ReaderError("invalid_output");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o))
    throw new ReaderError("invalid_output");
  const r = o as Record<string, unknown>;
  const fields = FIELDS[r.kind as ProtoLine["kind"]];
  if (!fields) throw new ReaderError("invalid_output");
  const keys = Object.keys(r);
  if (keys.length !== fields.length || !fields.every((f) => f in r))
    throw new ReaderError("invalid_output");
  const counts = () =>
    n(r.transactions) &&
    n(r.successful_transactions) &&
    r.successful_transactions <= r.transactions;
  const group = () => typeof r.group === "string" && groups.has(r.group);
  const proto = () =>
    typeof r.protocol === "string" &&
    protocols.has(r.protocol) &&
    (PROTOCOL_IDS as readonly string[]).includes(r.protocol);
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
      ok = group() && isDay(r.day) && counts();
      break;
    case "protocol":
      ok = group() && isDay(r.day) && proto() && counts() && (r.transactions as number) > 0;
      break;
    case "network":
      ok = isDay(r.day) && proto() && counts();
      break;
    default:
      ok = false;
  }
  if (!ok) throw new ReaderError("invalid_output");
  return r as unknown as ProtoLine;
}

export function collectProto(lines: ProtoLine[], summary: Record<string, number>): ProtoOutput {
  const out: ProtoOutput = { days: [], groups: [], protocols: [], network: [], summary };
  for (const l of lines) {
    if (l.kind === "day") out.days.push(l);
    else if (l.kind === "group") out.groups.push(l);
    else if (l.kind === "protocol") out.protocols.push(l);
    else out.network.push(l);
  }
  return out;
}

export function protoArgs(
  network: StellarNetwork,
  fromDay: string,
  toDay: string,
  ledgerDir: string,
): string[] {
  return [
    "protocols",
    "-network",
    network === "public" ? "pubnet" : "testnet",
    "-input",
    "-",
    "-from-day",
    fromDay,
    "-to-day",
    toDay,
    ledgerDir,
  ];
}

/** The reader's stdin: groups, then protocols, sorted (deterministic). */
export function protoInput(req: ProtoRequest): string {
  const g = req.members.map((m) => `group ${m.group} ${m.contract}\n`).sort();
  const p = req.protocols.map((x) => `protocol ${x.protocol} ${x.contract}\n`).sort();
  return [...g, ...p].join("");
}

export interface ProtoReaderOptions {
  bin: string;
  ledgerDir: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}

const STDERR_KEEP = 64 * 1024;

export class LedgerProtocolReader implements ProtoSource {
  readonly #o: Required<ProtoReaderOptions>;

  constructor(o: ProtoReaderOptions) {
    this.#o = { maxOutputBytes: 64 * 1024 * 1024, ...o };
  }

  read(req: ProtoRequest, signal: AbortSignal): Promise<ProtoOutput> {
    const groups = new Set(req.members.map((m) => m.group));
    const protocols = new Set<string>(req.protocols.map((p) => p.protocol));
    return new Promise<ProtoOutput>((resolve, reject) => {
      if (signal.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      const child = spawn(
        this.#o.bin,
        protoArgs(req.network, req.fromDay, req.toDay, this.#o.ledgerDir),
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
            .map((l) => parseProtoLine(l, groups, protocols));
          resolve(
            collectProto(
              lines,
              parseSummary(err.replace(/^onchain-reader protocols: /m, "onchain-reader: ")),
            ),
          );
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(protoInput(req));
    });
  }
}
