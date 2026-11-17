// SPDX-License-Identifier: Apache-2.0
// "Verify this number" (2026-11-19): the checks behind the Verify control of a public project card, in the reader's
// browser, from public data only (wire-formats §i.3, §m.1, §m.2; migration 0077). For a figure on the card it takes
// the project's latest valid signed snapshot and checks, step by step:
//   1. the Ed25519 signature over the RFC 8785 form, with the published key (lib/snapshotVerify.ts);
//   2. the project's public list names that snapshot's hash (lib/snapshotSeries.ts);
//   3. the daily seal: the salted leaf, the inclusion path, the root recomputed from public data (lib/seal.ts);
//   4. the chain of seal days forward to a confirmed transaction (C-137);
//   5. the operator actions log: the day's audit-anchor document (GET /public/v1/audit-anchors/{day}) hashes to the
//      seal's audit_anchor_sha256 and names the head of the operator (platform) chain — so the operator's actions up
//      to that day are fixed by the same Stellar transaction.
// The Horizon look-up and the whole-history walk are separate, on the reader's request (they tell Horizon the reader's
// address). The verdict is plain language; it never says the numbers are genuine or endorsed (C4): the seal is
// tamper-evidence, and a testnet seal is a demonstration (C-135).

import { canonicalize } from "../lib/jcs.ts";
import {
  checkChain,
  checkSealProof,
  type SealDayView,
  type SealProofView,
  sha256,
  toHex,
} from "../lib/seal.ts";
import { snapshotSha256 } from "../lib/snapshotSeries.ts";
import {
  type SignedDocument,
  type SnapshotJwk,
  verifySignedSnapshot,
} from "../lib/snapshotVerify.ts";

export const OPERATOR_CHAIN = "00000000-0000-0000-0000-000000000000";

export type NumberMetric = "visitors" | "pageviews" | "api";

export interface ListEntryLite {
  snapshot_id: string;
  seq: number;
  sha256: string;
  status: "valid" | "revoked";
  signed_at: string;
  period: { start: string; end: string };
}

export interface AnchorDocument {
  schema: string;
  date: string;
  generated_at: string;
  chains: { chain_id: string; seq: number; row_hash: string }[];
  sha256: string;
}

/** The proof as the API serves it (SealProof). */
export type ServedProof = SealProofView & {
  network: SealProofView["network"] & {
    lookup: { horizon: string; explorer: string | null; ledger_files: string | null };
  };
  source_account: string | null;
  tx_hash: string | null;
  ledger: number | null;
  explorer_url: string | null;
};

/** Everything the check reads; the page passes API calls, tests pass fixtures. */
export interface VerifySources {
  list(slug: string): Promise<readonly ListEntryLite[]>;
  snapshot(id: string): Promise<SignedDocument & { status?: string }>;
  keys(): Promise<readonly SnapshotJwk[]>;
  /** null when the snapshot is not sealed (yet) */
  proofs(id: string): Promise<readonly ServedProof[] | null>;
  /** the published seal days from `start` (YYYY-MM-DD) on */
  days(start: string): Promise<readonly SealDayView[]>;
  /** null until the day is sealed and its document published */
  anchor(day: string): Promise<AnchorDocument | null>;
}

export type StepState = "pass" | "fail" | "pending" | "na";
export interface Step {
  state: StepState;
  text: string;
}

export interface NumberVerification {
  snapshot: {
    id: string;
    seq: number;
    signedAt: string;
    period: { start: string; end: string };
    figure: number | null;
    kid: string | null;
  } | null;
  steps: {
    signature: Step;
    listed: Step;
    inclusion: Step;
    chain: Step;
    operatorLog: Step;
  };
  seal: {
    network: "testnet" | "mainnet";
    durable: boolean;
    notice: string | null;
    day: string;
    status: SealProofView["status"];
    horizon: string;
    sourceAccount: string | null;
    root: string;
    /** the transaction that anchors this day: its own when confirmed, else the first confirmed later day's */
    anchor: {
      day: string;
      txHash: string;
      ledger: number;
      root: string;
      explorerUrl: string | null;
    } | null;
  } | null;
  verdict: {
    kind: "sealed" | "seal_pending" | "signed_only" | "failed" | "no_snapshot";
    text: string;
  };
}

const NA: Step = { state: "na", text: "" };

/** The card figure a snapshot states for `metric` (null when the snapshot has no such figure). */
export function figureOf(body: Record<string, unknown>, metric: NumberMetric): number | null {
  const web = body.web as { verified?: { pageviews?: number; visitors_sum?: number } } | undefined;
  const api = body.api as { requests?: number } | null | undefined;
  const v =
    metric === "visitors"
      ? web?.verified?.visitors_sum
      : metric === "pageviews"
        ? web?.verified?.pageviews
        : api?.requests;
  return typeof v === "number" ? v : null;
}

/** The latest valid snapshot of the list (highest series number). */
export function latestValid(list: readonly ListEntryLite[]): ListEntryLite | null {
  return [...list].filter((e) => e.status === "valid").sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/** §m.1: sha256 of the JCS of the document without `sha256`. */
export async function anchorHash(doc: AnchorDocument): Promise<string> {
  const { sha256: _s, ...body } = doc;
  return toHex(
    await sha256(new TextEncoder().encode(canonicalize(body)) as Uint8Array<ArrayBuffer>),
  );
}

/** Step 5: the day's sealed audit anchor fixes the operator chain's head. */
export async function checkOperatorLog(
  doc: AnchorDocument | null,
  day: string,
  sealedSha256: string,
): Promise<Step> {
  if (doc === null)
    return {
      state: "pending",
      text: "The operator actions log of this day is not published yet; the seal still commits to its hash.",
    };
  const h = await anchorHash(doc);
  if (doc.date !== day || h !== doc.sha256 || h !== sealedSha256)
    return {
      state: "fail",
      text: "The published operator actions log does not match what the seal committed to: it was changed after sealing.",
    };
  const op = doc.chains.find((c) => c.chain_id === OPERATOR_CHAIN);
  return {
    state: "pass",
    text: op
      ? `Operator actions log: sealed. The seal fixes the operator log at entry ${op.seq.toLocaleString("en-US")} (head ${op.row_hash.slice(0, 12)}…); a rewritten operator action would no longer match.`
      : "Operator actions log: sealed. The seal fixes every audit chain's head as of this day (no operator actions yet).",
  };
}

export async function verifyNumber(
  src: VerifySources,
  slug: string,
  metric: NumberMetric,
  fmt: { day(iso: string): string; int(n: number): string },
): Promise<NumberVerification> {
  const steps = { signature: NA, listed: NA, inclusion: NA, chain: NA, operatorLog: NA };
  const list = await src.list(slug);
  const entry = latestValid(list);
  if (!entry)
    return {
      snapshot: null,
      steps,
      seal: null,
      verdict: {
        kind: "no_snapshot",
        text: "This project has not issued a signed snapshot yet, so this figure is a live measurement that nobody can check against a signature or a seal.",
      },
    };
  const [doc, keys] = await Promise.all([src.snapshot(entry.snapshot_id), src.keys()]);
  const sig = await verifySignedSnapshot(doc, keys);
  const sha = await snapshotSha256(doc.snapshot);
  const body = doc.snapshot as Record<string, unknown>;
  const snapshot = {
    id: entry.snapshot_id,
    seq: entry.seq,
    signedAt: entry.signed_at,
    period: entry.period,
    figure: figureOf(body, metric),
    kid: sig.ok ? sig.kid : null,
  };
  steps.signature = sig.ok
    ? { state: "pass", text: `Signed with UsageMap's published snapshot key ${sig.kid}.` }
    : {
        state: "fail",
        text: "The signature does not hold: the snapshot was altered or not signed with UsageMap's key.",
      };
  steps.listed =
    sha === entry.sha256
      ? {
          state: "pass",
          text: `Snapshot ${entry.seq} of the project's public list names exactly this document's hash.`,
        }
      : { state: "fail", text: "The project's public list names another hash for this snapshot." };
  const signedOk = steps.signature.state === "pass" && steps.listed.state === "pass";
  const sealOn = (body.seal as { enabled?: boolean } | undefined)?.enabled === true;
  const proofs = sealOn ? await src.proofs(entry.snapshot_id) : null;
  const proof = proofs?.[0] ?? null;
  if (!proof) {
    const pending = sealOn;
    return {
      snapshot,
      steps,
      seal: null,
      verdict: signedOk
        ? {
            kind: pending ? "seal_pending" : "signed_only",
            text: pending
              ? `This number is exactly what UsageMap signed on ${fmt.day(entry.signed_at)}. Its seal on Stellar is not built yet (at most about 25 hours after signing).`
              : `This number is exactly what UsageMap signed on ${fmt.day(entry.signed_at)}. The project has not opted in to the daily seal on Stellar.`,
          }
        : { kind: "failed", text: "This number cannot be verified: see the failed check." },
    };
  }
  const pc = await checkSealProof(proof, sha);
  steps.inclusion = pc.ok
    ? {
        state: "pass",
        text: `Included in the seal of ${fmt.day(`${proof.day}T00:00:00Z`)}: the salted leaf and its path recompute to that day's root ${proof.root.slice(0, 12)}…, and the root recomputes from public data.`,
      }
    : { state: "fail", text: "The seal proof does not recompute to the day's root." };
  const days = await src.days(proof.day);
  const chain = await checkChain(days);
  const anchorDay = proof.status === "confirmed" ? null : chain.anchoredBy;
  steps.chain = chain.ok
    ? {
        state: "pass",
        text: `Each of the ${days.length} published seal days from then on recomputes and links to the day before.`,
      }
    : {
        state: "fail",
        text: "The chain of seal days is broken: a root does not recompute or does not link.",
      };
  steps.operatorLog = await checkOperatorLog(
    await src.anchor(proof.day),
    proof.day,
    proof.audit_anchor_sha256,
  );
  const anchor =
    proof.status === "confirmed" && proof.tx_hash && proof.ledger !== null
      ? {
          day: proof.day,
          txHash: proof.tx_hash,
          ledger: proof.ledger,
          root: proof.root,
          explorerUrl: proof.explorer_url,
        }
      : anchorDay?.tx_hash && anchorDay.ledger !== null
        ? {
            day: anchorDay.day,
            txHash: anchorDay.tx_hash,
            ledger: anchorDay.ledger,
            root: anchorDay.root,
            explorerUrl: proof.network.lookup.explorer
              ? proof.network.lookup.explorer.replace("{tx_hash}", anchorDay.tx_hash)
              : null,
          }
        : null;
  const seal = {
    network: proof.network.name,
    durable: proof.network.durable,
    notice: proof.network.notice,
    day: proof.day,
    status: proof.status,
    horizon: proof.network.lookup.horizon,
    sourceAccount: proof.source_account,
    root: proof.root,
    anchor,
  };
  const allOk = signedOk && pc.ok && chain.ok && steps.operatorLog.state !== "fail";
  const net = `Stellar ${proof.network.name}`;
  let verdict: NumberVerification["verdict"];
  if (!allOk)
    verdict = { kind: "failed", text: "This number cannot be verified: see the failed check." };
  else if (anchor && anchor.day === proof.day)
    verdict = {
      kind: "sealed",
      text: `This number is exactly what UsageMap published on ${fmt.day(entry.signed_at)} and sealed on ${net} in ledger ${fmt.int(anchor.ledger)}.`,
    };
  else if (anchor)
    verdict = {
      kind: "sealed",
      text: `This number is exactly what UsageMap published on ${fmt.day(entry.signed_at)} and sealed on ${net}; that day's network was reset, so it is now anchored through the chain by the transaction of ${fmt.day(`${anchor.day}T00:00:00Z`)} in ledger ${fmt.int(anchor.ledger)}.`,
    };
  else
    verdict = {
      kind: "seal_pending",
      text: `This number is exactly what UsageMap published on ${fmt.day(entry.signed_at)}; its seal is built and waits for confirmation on ${net}.`,
    };
  return { snapshot, steps, seal, verdict };
}
