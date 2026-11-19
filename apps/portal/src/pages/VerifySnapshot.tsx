// SPDX-License-Identifier: Apache-2.0
// Public verification page for a signed traction snapshot (share.signed-usage-report, C-47, wire-formats §i.3 and §m.2; plan D-5), no
// sign-in, reachable as /verify?snapshot=<id> (the `links.verify` of a v2 snapshot) and /verify/<id>. In this browser:
//   1. the Ed25519 signature over the RFC 8785 form, with the published key (§i.3.1 steps 1–3); the server's
//      valid/revoked status is reported separately;
//   2. the snapshot's place in the project's public list: series number, no gap, hash links (§i.3.2 `series`, §i.3.3);
//   3. the daily seal (when the project opted in): the salted leaf, the inclusion path to the day's root, the root
//      recomputed from public data alone (`head_path`), the chain of days forward with its testnet-reset segment
//      breaks, and — only when the reader asks — the transaction on Horizon, which distinguishes "outside this
//      endpoint's history" from "not found" (§m.2 steps 1–5).
// A testnet seal is labelled a demonstration (C-135). Nothing here says the numbers are genuine or endorsed (C4).

import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ApiError, api } from "../api/client.ts";
import { ExplorerLinks } from "../components/ExplorerLinks.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { apiSources } from "../components/VerifyNumber.tsx";
import { checkOperatorLog, type Step } from "../components/VerifyNumberCheck.tsx";
import { fmtDay, fmtDayTime, fmtInt, fmtRange, fmtShare } from "../lib/format.ts";
import {
  type ChainCheck,
  checkChain,
  checkSealProof,
  compareSealHistory,
  fetchSealHistory,
  HORIZON_ORIGINS,
  ledgerFileKey,
  loadAllSealDays,
  lookupSealTransaction,
  type ProofCheck,
  SEAL_STATEMENT,
  type SealDayView,
  type SealHistoryProblem,
  type SealHistoryResult,
  type SealProofView,
  TESTNET_NOTICE,
  type TxLookup,
} from "../lib/seal.ts";
import {
  checkSeries,
  describeSeriesProblem,
  placeInSeries,
  snapshotSha256,
} from "../lib/snapshotSeries.ts";
import {
  type SignedDocument,
  type SnapshotJwk,
  type VerifyOutcome,
  verifySignedSnapshot,
} from "../lib/snapshotVerify.ts";
import { PublicFrame } from "./PublicStats.tsx";
import { PRESET_TEXT, type Preset } from "./TractionSnapshots.tsx";

const REASON_TEXT: Record<Exclude<VerifyOutcome, { ok: true }>["reason"], string> = {
  unsupported_alg: "The signature uses an algorithm other than Ed25519.",
  no_key: "No published signing key has the snapshot's key id.",
  key_not_valid_at_issue: "The signing key was not valid when the snapshot was issued.",
  malformed: "The key or the signature is not well-formed.",
  bad_signature:
    "The signature does not match the snapshot: it was altered or not signed with the platform's key.",
};

interface SnapshotBody {
  schema?: string;
  snapshot_id?: string;
  issued_at: string;
  issuer?: string;
  project?: { slug?: string; name?: string; verification_level?: string };
  series?: { seq: number; previous_sha256: string | null };
  period?: { start: string; end: string; days?: number };
  preset?: Preset;
  methodology?: { version: string; url: string };
  web?: {
    verified?: { pageviews?: number; visitors_sum?: number };
    raw?: { pageviews?: number; visitors_sum?: number };
    visit_metrics?: { suspect_pageview_share?: number | null };
  };
  api?: { label?: string; requests?: number; assurance_level?: string | null } | null;
  onchain?: {
    network: string;
    verified_contracts: number;
    invocations: number;
    successful_invocations: number;
    distinct_invokers_daily_sum: number;
  } | null;
  coverage?: { days_in_period: number; web_days_with_events: number };
  confidence?: { level: string; reasons: string[] };
  anomaly_flags?: { open_web: number; open_api: number };
  seal?: { enabled: boolean; network: string | null; proof_url: string | null };
  links?: { verify: string; public_list: string; definitions: string };
  text?: string;
}

export const VERIFY_SCRIPT = `// Node.js ≥ 22: node verify.mjs <snapshot.json> <scf-snapshot-keys.json>
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
const jcs = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? \`[\${v.map(jcs).join(",")}]\`
  : \`{\${Object.keys(v).sort().map((k) => \`\${JSON.stringify(k)}:\${jcs(v[k])}\`).join(",")}}\`;
const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { keys } = JSON.parse(readFileSync(process.argv[3], "utf8"));
const jwk = keys.find((k) => k.kid === doc.signature.kid);
const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
const ok = verify(null, Buffer.from(jcs(doc.snapshot)), key, Buffer.from(doc.signature.sig, "base64url"));
console.log(ok ? "signature valid" : "SIGNATURE INVALID", "· status:", doc.status ?? "(not from the public copy)");`;

const DAY_MS = 86_400_000;
const dayIso = (d: string) => `${d}T00:00:00Z`;

export function parseVerifySearch(s: Record<string, unknown>): { snapshot?: string } {
  return typeof s.snapshot === "string" && /^[0-9a-fA-F-]{36}$/.test(s.snapshot)
    ? { snapshot: s.snapshot.toLowerCase() }
    : {};
}

function Check({ ok, children, testId }: { ok: boolean; children: ReactNode; testId?: string }) {
  return (
    <li className={ok ? "pass" : "fail"} data-testid={testId}>
      {children}
    </li>
  );
}

function SeriesSection({
  slug,
  snapshotId,
  sha,
  series,
}: {
  slug: string;
  snapshotId: string;
  sha: string;
  series: { seq: number; previous_sha256: string | null } | null;
}) {
  const list = useQuery({
    queryKey: ["snapshot-list", slug],
    queryFn: () => api.call("getPublicSnapshotList", { path: { slug } }),
    retry: false,
  });
  const entries = list.data?.snapshots ?? [];
  const problems = checkSeries(entries);
  const place = list.data ? placeInSeries(entries, snapshotId, sha, series) : null;
  return (
    <section className="card stack" aria-labelledby="vl-h" data-testid="verify-series">
      <h2 id="vl-h">Place in the project's list of snapshots</h2>
      <ProblemAlert error={list.error} />
      {place?.kind === "not_listed" ? (
        <p className="alert warn" data-testid="series-not-listed">
          {series
            ? "This snapshot carries a series number but is not in the project's public list."
            : "This snapshot was issued before snapshots were numbered and listed; it is verifiable by its id only."}
        </p>
      ) : null}
      {place?.kind === "listed" ? (
        <ul className="check-list">
          <Check ok={place.hashOk} testId="series-hash">
            The list names this snapshot's hash ({sha.slice(0, 12)}…).
          </Check>
          <Check ok={place.seqOk && place.previousOk} testId="series-position">
            Snapshot {place.entry.seq} of {entries.length}
            {series ? " — matches the series number signed into the document" : ""}.
          </Check>
          <Check ok={problems.length === 0} testId="series-gaps">
            {problems.length === 0
              ? `The list runs 1–${entries.length} without a gap and every entry points at the hash of the one before.`
              : problems.map(describeSeriesProblem).join(" ")}
          </Check>
        </ul>
      ) : null}
      {entries.length > 0 ? (
        <details>
          <summary>All {entries.length} snapshots of this project</summary>
          <table data-testid="series-table">
            <thead>
              <tr>
                <th scope="col" className="num">
                  No.
                </th>
                <th scope="col">Period (UTC)</th>
                <th scope="col">Purpose</th>
                <th scope="col">Signed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.snapshot_id}
                  aria-current={e.snapshot_id === snapshotId ? "true" : undefined}
                >
                  <td className="num">{e.seq}</td>
                  <td>{fmtRange(e.period.start, e.period.end)}</td>
                  <td>{e.preset ? PRESET_TEXT[e.preset] : "—"}</td>
                  <td>{fmtDayTime(e.signed_at)}</td>
                  <td>
                    {e.status === "revoked"
                      ? `revoked ${e.revoked_at ? fmtDay(e.revoked_at) : ""}`
                      : "valid"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
}

const LOOKUP_TEXT = (r: TxLookup, ledger: number | null): string => {
  switch (r.kind) {
    case "match":
      return `Found: a successful transaction from the sealing account in ledger ${fmtInt(r.ledger)} whose MEMO_HASH is the day's root.`;
    case "mismatch":
      return `The transaction does not match: ${r.problems.join("; ")}.`;
    case "outside_history":
      return `Outside this endpoint's history: this Horizon keeps ledgers from ${fmtInt(r.elderLedger)} on, and the seal is in ledger ${fmtInt(ledger)}. That is not "not found" — check the public ledger file below.`;
    case "not_found":
      return "Not found: this Horizon covers the ledger but has no such transaction.";
    case "not_allowed":
      return `This page may only contact ${HORIZON_ORIGINS.join(" and ")}; check ${r.origin} by hand with the explorer link.`;
    case "unreachable":
      return `Horizon could not be reached (${r.detail}). Try again or check by hand.`;
  }
};

function ProofSection({
  proof,
  sha,
}: {
  proof: SealProofView & {
    network: SealProofView["network"] & {
      lookup: { horizon: string; explorer: string | null; ledger_files: string | null };
    };
    source_account: string | null;
    tx_hash: string | null;
    ledger: number | null;
    confirmed_at: string | null;
    explorer_url: string | null;
  };
  sha: string;
}) {
  const check = useQuery<ProofCheck>({
    queryKey: ["seal-proof-check", proof.snapshot_id, proof.network.name, proof.root, sha],
    queryFn: () => checkSealProof(proof, sha),
  });
  const end = Math.min(
    Date.parse(dayIso(proof.day)) + 400 * DAY_MS,
    Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS,
  );
  const days = useQuery({
    queryKey: ["seal-days", proof.network.name, proof.day],
    queryFn: () =>
      api.call("listSealDays", {
        query: {
          start: dayIso(proof.day),
          end: new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z"),
        },
      }),
    retry: false,
  });
  const chain = useQuery<ChainCheck>({
    queryKey: ["seal-chain", proof.network.name, proof.day, days.dataUpdatedAt],
    enabled: !!days.data,
    queryFn: () => checkChain((days.data?.days ?? []) as SealDayView[]),
  });
  const [lookup, setLookup] = useState<TxLookup | null>(null);
  const [looking, setLooking] = useState(false);
  const testnet = proof.network.name === "testnet";
  const anchor = chain.data?.anchoredBy ?? null;
  const reset = proof.status === "network_reset";
  const lookupTarget =
    proof.status === "confirmed"
      ? { tx_hash: proof.tx_hash, ledger: proof.ledger }
      : anchor
        ? { tx_hash: anchor.tx_hash, ledger: anchor.ledger }
        : null;
  return (
    <section
      className="card stack"
      aria-labelledby={`seal-${proof.network.name}`}
      data-testid={`seal-${proof.network.name}`}
    >
      <h3 id={`seal-${proof.network.name}`}>
        Seal on Stellar {proof.network.name}{" "}
        {testnet ? (
          <span className="badge warn" data-testid="seal-demo-label">
            demonstration
          </span>
        ) : null}
      </h3>
      {testnet ? (
        <p className="alert warn" data-testid="seal-testnet-notice">
          {proof.network.notice ?? TESTNET_NOTICE}
        </p>
      ) : null}
      <p>
        Sealed in the tree of {fmtDay(dayIso(proof.day))} (leaf {proof.leaf_index + 1} of{" "}
        {proof.leaf_count}, segment {proof.segment}) · status{" "}
        <strong data-testid="seal-status">{proof.status.replace("_", " ")}</strong>
      </p>
      {check.data ? (
        <ul className="check-list" data-testid="seal-checks">
          <Check ok={check.data.snapshotHash} testId="seal-check-hash">
            The proof names this snapshot's hash.
          </Check>
          <Check ok={check.data.leaf} testId="seal-check-leaf">
            The salted leaf recomputes to the proof's leaf hash.
          </Check>
          <Check ok={check.data.inclusion} testId="seal-check-inclusion">
            The inclusion path leads to the day's root {proof.root.slice(0, 12)}….
          </Check>
          <Check ok={check.data.head} testId="seal-check-head">
            The day's root recomputes from public data alone: the previous day's root, the audit-log
            anchor and the head path.
          </Check>
        </ul>
      ) : null}
      <OperatorLogCheck day={proof.day} sealedSha256={proof.audit_anchor_sha256} />
      {check.data?.ok && chain.data?.ok && (proof.status === "confirmed" || anchor) ? (
        <p className="alert ok" data-testid="seal-plain">
          {proof.status === "confirmed" && proof.ledger !== null
            ? `In plain words: this snapshot is exactly what UsageMap published and sealed on Stellar ${proof.network.name} in ledger ${fmtInt(proof.ledger)} (${fmtDay(dayIso(proof.day))}).`
            : `In plain words: this snapshot is exactly what UsageMap published; it was sealed on ${fmtDay(dayIso(proof.day))} and is anchored through the chain by the transaction of ${fmtDay(dayIso((anchor as SealDayView).day))} in ledger ${fmtInt((anchor as SealDayView).ledger)}.`}
        </p>
      ) : null}
      <ProblemAlert error={days.error} />
      {chain.data && days.data ? (
        <>
          <ul className="check-list">
            <Check ok={chain.data.ok} testId="seal-check-chain">
              {chain.data.ok
                ? `Each of the ${chain.data.days.length} published days from ${fmtDay(dayIso(proof.day))} on recomputes and links to the day before.`
                : "The chain of published days is broken: a root does not recompute or does not link."}
            </Check>
            {reset ? (
              <li className="info" data-testid="seal-reset-note">
                The testnet this day was confirmed on has since been reset, so its transaction no
                longer exists.{" "}
                {anchor
                  ? `It is now anchored through the chain by the confirmed transaction of ${fmtDay(dayIso(anchor.day))} (segment ${anchor.segment}).`
                  : "No later confirmed day anchors it yet."}
              </li>
            ) : null}
          </ul>
          <details>
            <summary>The chain of days</summary>
            <table data-testid="seal-chain">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col" className="num">
                    Segment
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Root recomputes</th>
                  <th scope="col">Links to the day before</th>
                </tr>
              </thead>
              <tbody>
                {chain.data.days.map((d) => (
                  <tr key={d.day} className={d.segmentBreak ? "segment-break" : undefined}>
                    <td>
                      {fmtDay(dayIso(d.day))}
                      {d.segmentBreak ? (
                        <span className="badge warn" data-testid="segment-break">
                          testnet reset before this day
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{d.segment}</td>
                    <td>{d.status.replace("_", " ")}</td>
                    <td>{d.rootOk ? "yes" : "NO"}</td>
                    <td>{d.linkOk && d.contiguous ? "yes" : "NO"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              Days before a testnet reset were confirmed on a network that no longer exists; they
              are anchored only through the first transaction of the next segment.
            </p>
          </details>
        </>
      ) : null}
      {lookupTarget?.tx_hash ? (
        <div className="stack">
          <p className="small">
            Last step: the transaction itself. Looking it up sends a request from your browser to{" "}
            {new URL(proof.network.lookup.horizon).host} (Stellar's public Horizon), which sees your
            address.
          </p>
          <div className="row">
            <button
              type="button"
              disabled={looking}
              onClick={async () => {
                setLooking(true);
                setLookup(
                  await lookupSealTransaction(proof.network.lookup.horizon, {
                    tx_hash: lookupTarget.tx_hash as string,
                    source_account: proof.source_account ?? "",
                    root: proof.status === "confirmed" ? proof.root : (anchor as SealDayView).root,
                    ledger: lookupTarget.ledger ?? 0,
                  }),
                );
                setLooking(false);
              }}
            >
              Look up the transaction on Horizon
            </button>
            {proof.explorer_url ? (
              <a href={proof.explorer_url} rel="noopener noreferrer">
                Open in an explorer
              </a>
            ) : null}
          </div>
          <p className="small" data-testid="seal-explorers">
            Seal transaction:{" "}
            <ExplorerLinks
              kind="tx"
              id={lookupTarget.tx_hash}
              network={proof.network.name}
              testId="seal-explorers-tx"
            />
            {proof.source_account ? (
              <>
                {" "}
                · sealing account:{" "}
                <ExplorerLinks
                  kind="account"
                  id={proof.source_account}
                  network={proof.network.name}
                  testId="seal-explorers-account"
                />
              </>
            ) : null}
          </p>
          {lookup ? (
            <p
              className={lookup.kind === "match" ? "alert ok" : "alert warn"}
              role="status"
              data-testid="seal-lookup"
            >
              {LOOKUP_TEXT(lookup, lookupTarget.ledger)}
            </p>
          ) : null}
          {lookup?.kind === "outside_history" &&
          lookupTarget.ledger !== null &&
          proof.network.lookup.ledger_files ? (
            <p className="small" data-testid="seal-ledger-file">
              Ledger file (for a store with 1 ledger per file and 64,000 files per partition — read
              the store's <code>.config.json</code>):{" "}
              <code>
                {proof.network.lookup.ledger_files}/{ledgerFileKey(lookupTarget.ledger, 1, 64000)}
              </code>
              . Decode the LedgerCloseMetaBatch and check the transaction's source, memo and result.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted small">
          {proof.status === "built" || proof.status === "submitted"
            ? "The day's transaction has not been confirmed yet."
            : proof.status === "failed"
              ? "The day's transaction failed; the chain stays intact and a later day anchors it."
              : null}
        </p>
      )}
      <SealHistoryCheck horizon={proof.network.lookup.horizon} />
      <p className="small muted" data-testid="seal-statement">
        {SEAL_STATEMENT}
      </p>
    </section>
  );
}

/**
 * The operator actions log (migration 0077): the day's audit-anchor document, as published, must hash to the seal's
 * audit_anchor_sha256; it names the head of the operator (platform) chain that the seal fixes.
 */
function OperatorLogCheck({ day, sealedSha256 }: { day: string; sealedSha256: string }) {
  const q = useQuery<Step>({
    queryKey: ["sealed-anchor", day, sealedSha256],
    queryFn: async () => checkOperatorLog(await apiSources.anchor(day), day, sealedSha256),
    retry: false,
  });
  if (!q.data) return <ProblemAlert error={q.error} />;
  return (
    <ul className="check-list">
      <li
        className={q.data.state === "pending" ? "info" : q.data.state}
        data-testid="seal-check-operator-log"
      >
        {q.data.text}
      </li>
    </ul>
  );
}

function SealSection({ snapshotId, sha }: { snapshotId: string; sha: string }) {
  const proofs = useQuery({
    queryKey: ["seal-proof", snapshotId],
    queryFn: () => api.call("getSnapshotSealProof", { path: { snapshotId } }),
    retry: false,
  });
  const notYet = proofs.error instanceof ApiError && proofs.error.status === 404;
  return (
    <section className="card stack" aria-labelledby="vseal-h" data-testid="verify-seal">
      <h2 id="vseal-h">Daily seal</h2>
      {notYet ? (
        <p className="alert info" data-testid="seal-not-yet">
          Not sealed yet. A snapshot is sealed in the day it was signed, at most about 25 hours
          later.
        </p>
      ) : (
        <ProblemAlert error={proofs.error} />
      )}
      {(proofs.data?.proofs ?? []).map((p) => (
        <ProofSection key={p.network.name} proof={p} sha={sha} />
      ))}
    </section>
  );
}

export function VerifySnapshotPage() {
  const params = useParams({ strict: false }) as { snapshotId?: string };
  const search = useSearch({ strict: false }) as { snapshot?: string };
  const snapshotId = params.snapshotId ?? search.snapshot ?? "";
  const snap = useQuery({
    queryKey: ["public-snapshot", snapshotId],
    queryFn: () => api.call("getPublicSnapshot", { path: { snapshotId } }),
    enabled: snapshotId !== "",
    retry: false,
  });
  const keys = useQuery({
    queryKey: ["snapshot-keys"],
    queryFn: () => api.call("getSnapshotKeys", {}),
    retry: false,
  });
  const check = useQuery({
    queryKey: ["snapshot-check", snapshotId, snap.dataUpdatedAt, keys.dataUpdatedAt],
    enabled: !!snap.data && !!keys.data,
    retry: false,
    queryFn: async () =>
      verifySignedSnapshot(
        snap.data as unknown as SignedDocument,
        (keys.data?.keys ?? []) as SnapshotJwk[],
      ),
  });
  const sha = useQuery({
    queryKey: ["snapshot-sha", snapshotId, snap.dataUpdatedAt],
    enabled: !!snap.data,
    queryFn: () => snapshotSha256(snap.data?.snapshot),
  });
  const notFound = snap.error instanceof ApiError && snap.error.status === 404;
  const body = snap.data ? (snap.data.snapshot as unknown as SnapshotBody) : null;
  const v2 = body?.schema === "scf-analytics/traction-snapshot/2";
  const sigOk = check.data?.ok === true;
  const revoked = snap.data?.status === "revoked";
  const keysUrl = `${window.location.origin}/.well-known/scf-snapshot-keys.json`;
  const copyUrl = `${window.location.origin}/public/v1/snapshots/${encodeURIComponent(snapshotId)}`;
  return (
    <PublicFrame title="Verify a traction snapshot">
      <h1>Verify a traction snapshot</h1>
      {snapshotId === "" ? (
        <p className="alert info">Open this page from a snapshot's verify link.</p>
      ) : null}
      {notFound ? (
        <p className="alert warn" data-testid="verify-not-found" role="status">
          No snapshot with this id is published. It may never have existed, or its project is no
          longer active.
        </p>
      ) : (
        <ProblemAlert error={snap.error ?? keys.error ?? check.error} />
      )}
      {snap.isLoading || keys.isLoading || check.isLoading ? (
        <p className="muted">Checking…</p>
      ) : null}
      {check.data ? (
        <section className="card stack" aria-labelledby="vr-h">
          <h2 id="vr-h">Result</h2>
          {sigOk && !revoked ? (
            <p className="alert ok" data-testid="verify-result" role="status">
              Valid: signed with the platform's published snapshot key (
              <code>{check.data.ok ? check.data.kid : ""}</code>) and not revoked. The figures are
              exactly as issued.
            </p>
          ) : sigOk && revoked ? (
            <p className="alert warn" data-testid="verify-result" role="status">
              Revoked by the project
              {snap.data?.revoked_at ? ` on ${fmtDay(snap.data.revoked_at)}` : ""}. The signature is
              intact, but the project no longer stands behind these figures.
            </p>
          ) : (
            <p className="alert error" data-testid="verify-result" role="alert">
              Not valid. {check.data.ok ? "" : REASON_TEXT[check.data.reason]}
            </p>
          )}
          <p className="small muted">
            A valid signature shows that the figures were not changed after they were issued. It
            does not show that anyone endorses them.
          </p>
        </section>
      ) : null}
      {body ? (
        <section className="card stack" aria-labelledby="vs-h">
          <h2 id="vs-h">What the snapshot states</h2>
          <dl data-testid="verify-figures">
            <dt>Project</dt>
            <dd>
              {body.project?.name ?? "—"} ({body.project?.slug ?? "—"}), verification level{" "}
              {body.project?.verification_level ?? "—"}
            </dd>
            <dt>Period (UTC, end exclusive)</dt>
            <dd>
              {body.period ? fmtRange(body.period.start, body.period.end) : "—"}
              {body.preset ? ` · ${PRESET_TEXT[body.preset]}` : ""}
            </dd>
            <dt>Issued</dt>
            <dd>
              {fmtDayTime(body.issued_at)}
              {body.issuer ? ` by ${body.issuer}` : ""}
              {body.series ? ` · snapshot ${body.series.seq} of this project` : ""}
            </dd>
            <dt>Verified page views</dt>
            <dd>
              {fmtInt(body.web?.verified?.pageviews)} ({fmtInt(body.web?.raw?.pageviews)} raw)
            </dd>
            <dt>Visitors (sum of daily uniques, verified)</dt>
            <dd>{fmtInt(body.web?.verified?.visitors_sum)}</dd>
            <dt>Suspect page views</dt>
            <dd>{fmtShare(body.web?.visit_metrics?.suspect_pageview_share)}</dd>
            {body.api ? (
              <>
                <dt>API requests ({body.api.label ?? "self-attested telemetry"})</dt>
                <dd>
                  {fmtInt(body.api.requests)}, assurance level {body.api.assurance_level ?? "none"}
                </dd>
              </>
            ) : null}
            {body.onchain ? (
              <>
                <dt>On-chain ({body.onchain.network}, verified contracts only)</dt>
                <dd data-testid="verify-onchain">
                  {fmtInt(body.onchain.invocations)} invocations of{" "}
                  {body.onchain.verified_contracts} contract
                  {body.onchain.verified_contracts === 1 ? "" : "s"},{" "}
                  {fmtInt(body.onchain.distinct_invokers_daily_sum)} daily invokers (sum)
                </dd>
              </>
            ) : null}
            {body.confidence ? (
              <>
                <dt>Confidence ({body.methodology?.version ?? "methodology"})</dt>
                <dd data-testid="verify-confidence">
                  {body.confidence.level}
                  {body.confidence.reasons.length > 0
                    ? ` (${body.confidence.reasons.join(", ").replaceAll("_", " ")})`
                    : ""}
                </dd>
              </>
            ) : null}
            {body.anomaly_flags ? (
              <>
                <dt>Open anomaly flags</dt>
                <dd>
                  web {body.anomaly_flags.open_web}, API {body.anomaly_flags.open_api}
                </dd>
              </>
            ) : null}
          </dl>
          {v2 && body.text ? (
            <details>
              <summary>The signed text, as the project pastes it</summary>
              <pre className="code">
                <code data-testid="verify-text">{body.text}</code>
              </pre>
            </details>
          ) : null}
          <p className="small muted">
            Read these figures together with the result above: they are what the stored copy says,
            whether or not its signature holds.
          </p>
        </section>
      ) : null}
      {body && sha.data && body.project?.slug ? (
        <SeriesSection
          slug={body.project.slug}
          snapshotId={snapshotId}
          sha={sha.data}
          series={v2 && body.series ? body.series : null}
        />
      ) : null}
      {body && sha.data && v2 && body.seal?.enabled ? (
        <SealSection snapshotId={snapshotId} sha={sha.data} />
      ) : body && v2 ? (
        <p className="small muted" data-testid="verify-no-seal">
          The project has not opted in to the daily seal for this snapshot.
        </p>
      ) : null}
      <section className="card stack" aria-labelledby="vm-h">
        <h2 id="vm-h">Check it yourself</h2>
        <ol data-testid="verify-steps">
          <li>
            Fetch the public signing keys: <code>{keysUrl}</code> (a JWKS of Ed25519 keys).
          </li>
          <li>
            Pick the key whose <code>kid</code> equals <code>signature.kid</code> and whose validity
            (<code>not_before</code>, <code>not_after</code>) covers <code>snapshot.issued_at</code>
            .
          </li>
          <li>
            Serialise <code>snapshot</code> with RFC 8785 (JSON Canonicalization Scheme) and verify{" "}
            <code>signature.sig</code> (base64url, 64 bytes) over it with Ed25519. Any change to the
            snapshot breaks the signature.
          </li>
          <li>
            Fetch the stored copy <code>{copyUrl}</code>: it must be identical after
            canonicalisation and its <code>status</code> must be <code>valid</code>. A revoked
            snapshot still verifies cryptographically but reports <code>revoked</code>.
          </li>
          <li>
            Schema 2: check that the project's list (
            <code>/public/v1/projects/&lt;slug&gt;/snapshots</code>) names the SHA-256 of the
            canonical snapshot at position <code>series.seq</code>, runs 1, 2, 3, … without a gap,
            and that every <code>previous_sha256</code> is the hash of the entry before.
          </li>
          <li>
            Seal (<code>/public/v1/snapshots/&lt;id&gt;/seal</code>, RFC 9162 tree, SHA-256): leaf ={" "}
            <code>H(0x00 ‖ "scf-seal/1 snapshot" ‖ 0x00 ‖ salt ‖ id ‖ H(JCS(snapshot)))</code>; fold
            the audit path to the root; recompute the root from <code>prev_root</code>,{" "}
            <code>audit_anchor_sha256</code> and <code>head_path</code>; walk{" "}
            <code>/public/v1/seals</code> forward to a confirmed day; find its transaction (memo
            hash = root) on Horizon or, outside Horizon's history, in the public ledger files.
          </li>
        </ol>
        <p>A self-contained script for step 3 (Node.js, no dependencies):</p>
        <pre className="code">
          <code data-testid="verify-script">{VERIFY_SCRIPT}</code>
        </pre>
      </section>
    </PublicFrame>
  );
}

const HISTORY_PROBLEM_TEXT: Record<SealHistoryProblem, string> = {
  chain_break: "the day does not link to the day before",
  root_mismatch: "the day's root does not recompute from public data",
  memo_mismatch: "the day's transaction carries another root",
  ledger_mismatch: "the day's transaction is in another ledger",
  confirmed_tx_missing: "the day's transaction is not in the sealing account's history",
  unknown_seal_tx: "a seal transaction on the ledger matches no published day",
  out_of_order: "seal transactions on the ledger do not follow day order",
};

/**
 * Plan C1 #10 (C-137): the whole published seal history against the ledger — every sealing account's full transaction
 * history from Horizon compared with every published day, so a past root rewritten together with the rest of the chain
 * is still caught (only the ledger is outside the platform's control).
 */
function SealHistoryCheck({ horizon }: { horizon: string }) {
  const [result, setResult] = useState<SealHistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  let host = horizon;
  try {
    host = new URL(horizon).host;
  } catch {
    /* shown as given */
  }
  return (
    <div className="stack" data-testid="seal-history">
      <p className="small">
        The whole history: every published day against every transaction of the sealing accounts.
        This reads the accounts' full transaction history from {host}, which sees your address.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setResult(null);
            try {
              const days = await loadAllSealDays(async (start, end) => {
                const r = await api.call("listSealDays", { query: { start, end } });
                return r.days as SealDayView[];
              });
              const accounts = days
                .map((d) => d.source_account)
                .filter((a): a is string => typeof a === "string");
              const { history, elderLedger } = await fetchSealHistory(horizon, accounts);
              setResult(await compareSealHistory(days, history, elderLedger));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Check the whole seal history against the ledger
        </button>
      </div>
      {error ? (
        <p className="alert warn" role="status" data-testid="seal-history-result">
          The history could not be checked: {error}
        </p>
      ) : null}
      {result?.ok ? (
        <p className="alert ok" role="status" data-testid="seal-history-result">
          The published seal history matches the ledger: {fmtInt(result.daysChecked)} confirmed days
          checked against {fmtInt(result.transactions)} transactions of {result.accounts} sealing
          account{result.accounts === 1 ? "" : "s"}
          {result.notCheckable > 0
            ? `; ${fmtInt(result.notCheckable)} days are outside this endpoint's history or on a reset testnet`
            : ""}
          .
        </p>
      ) : null}
      {result && !result.ok ? (
        <div className="alert warn" role="status" data-testid="seal-history-result">
          <p>The published seal history does not match the ledger.</p>
          <ul>
            {result.problems.map((p) => (
              <li key={`${p.problem}-${p.day}-${p.tx_hash}`}>
                {p.day ? `${fmtDay(`${p.day}T00:00:00Z`)}: ` : ""}
                {HISTORY_PROBLEM_TEXT[p.problem]}
                {p.tx_hash ? ` (transaction ${p.tx_hash.slice(0, 12)}…)` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
