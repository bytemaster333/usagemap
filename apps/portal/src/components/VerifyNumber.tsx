// SPDX-License-Identifier: Apache-2.0
// "Verify this number" control next to a headline figure of a public project card (2026-11-19). It opens in place
// (no navigation) and shows, from public data and computed in this browser: the signed snapshot the number comes from,
// the signature check with the published key, the Merkle inclusion proof, the seal chain, the operator actions log the
// seal fixes, and the seal transaction on Stellar (explorer link; Horizon look-up and the whole-history walk only on
// request, because they tell Horizon the reader's address). Logic: VerifyNumberCheck.tsx. Wording C4.

import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { ApiError, api } from "../api/client.ts";
import { fmtDay, fmtInt, fmtRange } from "../lib/format.ts";
import {
  compareSealHistory,
  fetchSealHistory,
  loadAllSealDays,
  lookupSealTransaction,
  SEAL_STATEMENT,
  type SealDayView,
  type SealHistoryResult,
  type TxLookup,
} from "../lib/seal.ts";
import type { SignedDocument, SnapshotJwk } from "../lib/snapshotVerify.ts";
import { ExplorerLinks } from "./ExplorerLinks.tsx";
import {
  type AnchorDocument,
  type ListEntryLite,
  type NumberMetric,
  type NumberVerification,
  type ServedProof,
  type Step,
  type VerifySources,
  verifyNumber,
} from "./VerifyNumberCheck.tsx";

const DAY_MS = 86_400_000;
const isoZ = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

const notFoundAs = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return fallback;
    throw e;
  }
};

/** The API as the check's sources. */
export const apiSources: VerifySources = {
  list: async (slug) => {
    const r = await notFoundAs(api.call("getPublicSnapshotList", { path: { slug } }), null);
    return (r?.snapshots ?? []) as ListEntryLite[];
  },
  snapshot: async (id) =>
    (await api.call("getPublicSnapshot", {
      path: { snapshotId: id },
    })) as unknown as SignedDocument,
  keys: async () => ((await api.call("getSnapshotKeys", {})).keys ?? []) as SnapshotJwk[],
  proofs: async (id) => {
    const r = await notFoundAs(
      api.call("getSnapshotSealProof", { path: { snapshotId: id } }),
      null,
    );
    return r ? (r.proofs as unknown as ServedProof[]) : null;
  },
  days: async (start) => {
    const s = Date.parse(`${start}T00:00:00Z`);
    const end = Math.min(s + 400 * DAY_MS, Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS);
    const r = await api.call("listSealDays", { query: { start: isoZ(s), end: isoZ(end) } });
    return r.days as SealDayView[];
  },
  anchor: async (day) =>
    (await notFoundAs(
      api.call("getSealedAuditAnchor", { path: { day } }),
      null,
    )) as AnchorDocument | null,
};

const METRIC_TEXT: Record<NumberMetric, string> = {
  visitors: "verified visitors (sum of daily uniques)",
  pageviews: "verified page views",
  api: "API requests (self-attested)",
};

function StepItem({ step, testId }: { step: Step; testId: string }) {
  if (step.state === "na") return null;
  return (
    <li className={step.state === "pending" ? "info" : step.state} data-testid={testId}>
      {step.text}
    </li>
  );
}

const lookupText = (r: TxLookup): string => {
  switch (r.kind) {
    case "match":
      return `Found on Stellar: a successful transaction from the sealing account in ledger ${fmtInt(r.ledger)} whose memo is the day's root.`;
    case "mismatch":
      return `The transaction does not match: ${r.problems.join("; ")}.`;
    case "outside_history":
      return `Outside this Horizon's history (it keeps ledgers from ${fmtInt(r.elderLedger)} on); check the explorer or the full verification page.`;
    case "not_found":
      return "Not found: this Horizon covers the ledger but has no such transaction.";
    case "not_allowed":
      return `This page may only contact Stellar's public Horizon; check ${r.origin} by hand.`;
    case "unreachable":
      return `Horizon could not be reached (${r.detail}).`;
  }
};

export function VerifyNumberPanel({
  result,
  shown,
  measure,
}: {
  result: NumberVerification;
  shown: number | null;
  measure: NumberMetric;
}) {
  const [lookup, setLookup] = useState<TxLookup | null>(null);
  const [history, setHistory] = useState<SealHistoryResult | string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = result.snapshot;
  const seal = result.seal;
  const anchor = seal?.anchor ?? null;
  let host = "";
  try {
    host = seal ? new URL(seal.horizon).host : "";
  } catch {
    host = seal?.horizon ?? "";
  }
  return (
    <div className="stack" data-testid="verify-number-panel">
      <p
        className={
          result.verdict.kind === "sealed"
            ? "alert ok"
            : result.verdict.kind === "failed"
              ? "alert error"
              : "alert info"
        }
        role="status"
        data-testid="verify-number-verdict"
      >
        {result.verdict.text}
      </p>
      {s ? (
        <p className="small" data-testid="verify-number-source">
          From signed snapshot {s.seq} ({fmtRange(s.period.start, s.period.end)}, signed{" "}
          {fmtDay(s.signedAt)}), which states <strong>{fmtInt(s.figure)}</strong>{" "}
          {METRIC_TEXT[measure]}.
          {shown !== null && s.figure !== shown
            ? ` The card shows ${fmtInt(shown)}: it is rebuilt every hour over the last complete days and is not signed itself; the signed figure is the one above.`
            : ""}{" "}
          <Link to="/verify" search={{ snapshot: s.id }}>
            Full verification page
          </Link>
        </p>
      ) : null}
      <ul className="check-list" data-testid="verify-number-steps">
        <StepItem step={result.steps.signature} testId="vn-signature" />
        <StepItem step={result.steps.listed} testId="vn-listed" />
        <StepItem step={result.steps.inclusion} testId="vn-inclusion" />
        <StepItem step={result.steps.chain} testId="vn-chain" />
        <StepItem step={result.steps.operatorLog} testId="vn-operator-log" />
      </ul>
      {seal && !seal.durable ? (
        <p className="small muted" data-testid="vn-testnet-notice">
          {seal.notice}
        </p>
      ) : null}
      {seal && anchor ? (
        <div className="stack">
          <p className="small" data-testid="vn-transaction">
            Seal transaction on Stellar {seal.network}: <code>{anchor.txHash.slice(0, 16)}…</code>{" "}
            in ledger {fmtInt(anchor.ledger)}
            {anchor.explorerUrl ? (
              <>
                {" · "}
                <a href={anchor.explorerUrl} rel="noopener noreferrer" target="_blank">
                  open in a public explorer
                </a>
              </>
            ) : null}
          </p>
          <p className="small" data-testid="vn-explorers">
            Open the transaction:{" "}
            <ExplorerLinks
              kind="tx"
              id={anchor.txHash}
              network={seal.network}
              testId="vn-explorers-tx"
            />
            {seal.sourceAccount ? (
              <>
                {" "}
                · the sealing account:{" "}
                <ExplorerLinks
                  kind="account"
                  id={seal.sourceAccount}
                  network={seal.network}
                  testId="vn-explorers-account"
                />
              </>
            ) : null}
          </p>
          <p className="small muted">
            The two checks below run in your browser against {host} (Stellar's public Horizon),
            which sees your address.
          </p>
          <div className="row">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setLookup(
                  await lookupSealTransaction(seal.horizon, {
                    tx_hash: anchor.txHash,
                    source_account: seal.sourceAccount ?? "",
                    root: anchor.root,
                    ledger: anchor.ledger,
                  }),
                );
                setBusy(false);
              }}
            >
              Check the transaction on Stellar
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const days = await loadAllSealDays(async (start, end) => {
                    const r = await api.call("listSealDays", { query: { start, end } });
                    return r.days as SealDayView[];
                  });
                  const accounts = days
                    .map((d) => d.source_account)
                    .filter((a): a is string => typeof a === "string");
                  const { history: h, elderLedger } = await fetchSealHistory(
                    seal.horizon,
                    accounts,
                  );
                  setHistory(await compareSealHistory(days, h, elderLedger));
                } catch (e) {
                  setHistory(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check the whole seal history
            </button>
          </div>
          {lookup ? (
            <p
              className={lookup.kind === "match" ? "alert ok" : "alert warn"}
              role="status"
              data-testid="vn-lookup"
            >
              {lookupText(lookup)}
            </p>
          ) : null}
          {typeof history === "string" ? (
            <p className="alert warn" role="status" data-testid="vn-history">
              The history could not be checked: {history}
            </p>
          ) : history ? (
            <p
              className={history.ok ? "alert ok" : "alert error"}
              role="status"
              data-testid="vn-history"
            >
              {history.ok
                ? `The whole seal history matches the ledger: ${fmtInt(history.daysChecked)} confirmed days against ${fmtInt(history.transactions)} transactions of the sealing account${history.accounts === 1 ? "" : "s"}.`
                : `The seal history does not match the ledger (${history.problems
                    .map((p) => `${p.problem.replaceAll("_", " ")}${p.day ? ` on ${p.day}` : ""}`)
                    .join("; ")}).`}
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="small muted">
        {SEAL_STATEMENT} Measured by UsageMap; not an endorsement by SCF, SDF or anyone else.
      </p>
    </div>
  );
}

export function VerifyNumber({
  slug,
  measure,
  shown,
  sources = apiSources,
}: {
  slug: string;
  /** which card figure (not a metric-definitions key) */
  measure: NumberMetric;
  /** the figure the card shows next to this control */
  shown: number | null;
  sources?: VerifySources;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; r: NumberVerification }
    | { kind: "error"; m: string }
  >({ kind: "idle" });
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && state.kind !== "done" && state.kind !== "busy") {
      setState({ kind: "busy" });
      try {
        const r = await verifyNumber(sources, slug, measure, {
          day: fmtDay,
          int: (n) => fmtInt(n),
        });
        setState({ kind: "done", r });
      } catch (e) {
        setState({ kind: "error", m: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  return (
    <div className="verify-number" data-testid={`verify-number-${measure}`}>
      <button
        type="button"
        className="secondary small"
        aria-expanded={open}
        aria-controls={`${id}-p`}
        onClick={() => void toggle()}
      >
        Verify this number
      </button>
      {open ? (
        <section
          id={`${id}-p`}
          className="card stack verify-number-card"
          aria-label={`Verification of ${METRIC_TEXT[measure]}`}
        >
          {state.kind === "busy" ? <p className="muted">Checking in your browser…</p> : null}
          {state.kind === "error" ? (
            <p className="alert warn" role="status" data-testid="verify-number-verdict">
              The checks could not run: {state.m}
            </p>
          ) : null}
          {state.kind === "done" ? (
            <VerifyNumberPanel result={state.r} shown={shown} measure={measure} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
