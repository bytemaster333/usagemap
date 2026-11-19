// SPDX-License-Identifier: Apache-2.0
// Signed traction snapshots (C-47, wire-formats §i.3): a project admin records a period; the jobs service computes the
// figures and signs them with the snapshot key, which the internet-facing control plane never holds (review finding
// F16, C-125). Creating answers `201` with the signed snapshot when the signature arrives within the server's wait,
// otherwise `202` with the snapshot pending; the list shows `pending` until the jobs service has signed it, and is
// re-read every few seconds while any snapshot is pending. Anyone can verify a signed snapshot at its verify URL.
// Schema v2 (C-136, plan C1, §i.3.2): presets for the SCF windows (Build tranche, Growth Hack before/during, Public
// Goods renewal quarter — one calendar quarter exactly — or custom); the publication notice before creating (every
// signed snapshot's id, period, preset and hash go into the project's public list, C-137 finding 12); the opt-in daily
// seal on Stellar testnet (a demonstration, C-135); and the signed pasteable text, shown for copying.
// Schema v3 (SCF Evidence Link): every new snapshot is v3 — the signed document adds the usage
// funnel, the Growth Hack / Public Goods block and the cohort position, and gets a public evidence page
// (`/evidence/<id>`): the one link a project pastes into its SCF application, copied here with the text.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { fmtDay, fmtDayTime } from "../lib/format.ts";
import { parseDay } from "../lib/range.ts";
import { TESTNET_NOTICE } from "../lib/seal.ts";
import { SharingHeader } from "./Sharing.tsx";
import { TenantNav } from "./TenantNav.tsx";

type Summary = ControlPlane.TractionSnapshotSummary;
export type Preset = NonNullable<ControlPlane.TractionSnapshotCreate["preset"]>;

/** wire-formats §i.3.4 preset labels. */
export const PRESET_TEXT: Record<Preset, string> = {
  build_tranche: "SCF Build tranche",
  growth_hack_before: "before Growth Hack campaign",
  growth_hack_during: "during Growth Hack campaign",
  pg_renewal_quarter: "Public Goods renewal quarter",
  custom: "custom period",
};
const PRESETS: Preset[] = [
  "build_tranche",
  "growth_hack_before",
  "growth_hack_during",
  "pg_renewal_quarter",
  "custom",
];

/** A calendar quarter as the half-open period the API takes: Q1 2026 → [2026-01-01, 2026-04-01). */
export function quarterPeriod(year: number, q: 1 | 2 | 3 | 4): { start: string; end: string } {
  const z = (y: number, m: number) =>
    new Date(Date.UTC(y, m, 1)).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { start: z(year, (q - 1) * 3), end: z(q === 4 ? year + 1 : year, q === 4 ? 0 : q * 3) };
}

/** The complete calendar quarters that end no later than today (00:00 UTC), newest first. */
export function completeQuarters(
  now = new Date(),
  count = 6,
): { year: number; q: 1 | 2 | 3 | 4 }[] {
  const out: { year: number; q: 1 | 2 | 3 | 4 }[] = [];
  let year = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) as 0 | 1 | 2 | 3; // the current quarter, 0-based: not complete
  while (out.length < count) {
    if (q === 0) {
      year -= 1;
      q = 3;
    } else q = (q - 1) as 0 | 1 | 2 | 3;
    out.push({ year, q: (q + 1) as 1 | 2 | 3 | 4 });
  }
  return out;
}

/** The signed pasteable text (v2 only), as the project would paste it into an SCF form. */
export function SnapshotText({ snapshotId }: { snapshotId: string }) {
  const doc = useQuery({
    queryKey: ["public-snapshot", snapshotId],
    queryFn: () => api.call("getPublicSnapshot", { path: { snapshotId } }),
  });
  const snap = doc.data?.snapshot as { schema?: string; text?: string } | undefined;
  const link = evidenceUrl(snapshotId);
  return (
    <div className="stack" data-testid="snapshot-view">
      <ProblemAlert error={doc.error} />
      {(snap?.schema === "scf-analytics/traction-snapshot/2" ||
        snap?.schema === "scf-analytics/traction-snapshot/3") &&
      typeof snap.text === "string" ? (
        <>
          <p>
            Evidence link:{" "}
            <a href={link} data-testid="snapshot-evidence-link">
              {link}
            </a>{" "}
            <CopyButton text={link} label="Copy link" />
          </p>
          <pre className="code" data-testid="snapshot-text">
            <code>{snap.text}</code>
          </pre>
          <CopyButton text={snap.text} label="Copy text" />
          <p className="small muted">
            This text is part of the signed document: anyone can check it, word for word, with the
            verify link it ends with.
          </p>
        </>
      ) : snap ? (
        <p className="muted">
          Schema version 1 has no pasteable text; share the verify link instead.
        </p>
      ) : null}
    </div>
  );
}

/** The public evidence page of a snapshot (absolute, as pasted into an SCF form). */
export function evidenceUrl(snapshotId: string): string {
  return `${window.location.origin}/evidence/${snapshotId}`;
}

/** v3: a Growth Hack preset needs whole ISO weeks (Monday 00:00 UTC to Monday 00:00 UTC). */
export function wholeIsoWeeks(start: Date | null, end: Date | null): boolean {
  if (!start || !end) return false;
  const day = 86_400_000;
  const a = start.getTime();
  const b = end.getTime();
  return a % day === 0 && start.getUTCDay() === 1 && b > a && (b - a) % (7 * day) === 0;
}

/** How often the list is re-read while a snapshot waits for its signature. */
export const PENDING_POLL_MS = 3000;

const toInstant = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The answer of createTractionSnapshot: `202` pending or `201` signed (the signed body carries no status). */
export function isPending(
  r: ControlPlane.PendingTractionSnapshot | ControlPlane.SignedTractionSnapshot,
): r is ControlPlane.PendingTractionSnapshot {
  return (r as { status?: unknown }).status === "pending";
}

function SnapshotRow({ tenantId, s }: { tenantId: string; s: Summary }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [viewing, setViewing] = useState(false);
  const revoke = useMutation({
    mutationFn: () =>
      api.call("revokeTractionSnapshot", {
        path: { tenantId, snapshotId: s.snapshot_id },
        body: { reason: "revoked by the project" },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["traction-snapshots", tenantId] });
    },
  });
  const state = s.revoked_at
    ? `revoked ${fmtDay(s.revoked_at)}`
    : s.status === "pending"
      ? "signing…"
      : "signed";
  return (
    <>
      <tr className={s.revoked_at ? "muted" : undefined} data-testid={`snapshot-${s.snapshot_id}`}>
        <td>
          {fmtDay(s.period_start)} – {fmtDay(s.period_end)}{" "}
          <span className="small muted">(end exclusive)</span>
          <br />
          <span className="small" data-testid="snapshot-preset">
            {s.preset ? PRESET_TEXT[s.preset] : "v1"}
            {s.schema_version ? ` · schema v${s.schema_version}` : ""}
            {s.seal_proof_url ? " · sealed" : ""}
          </span>
        </td>
        <td>{fmtDayTime(s.created_at)}</td>
        <td data-testid="snapshot-state">{state}</td>
        <td>
          {s.status === "signed" ? (
            <>
              {s.schema_version && s.schema_version >= 2 ? (
                <>
                  <Link
                    to="/evidence/$snapshotId"
                    params={{ snapshotId: s.snapshot_id }}
                    data-testid="snapshot-evidence"
                  >
                    Evidence page
                    <span className="sr-only"> of the snapshot from {fmtDay(s.created_at)}</span>
                  </Link>{" "}
                  ·{" "}
                </>
              ) : null}
              <Link to="/verify/$snapshotId" params={{ snapshotId: s.snapshot_id }}>
                Verify<span className="sr-only"> snapshot from {fmtDay(s.created_at)}</span>
              </Link>{" "}
              ·{" "}
              <a href={s.verify_url} target="_blank" rel="noreferrer">
                JSON<span className="sr-only"> of the snapshot from {fmtDay(s.created_at)}</span>
              </a>{" "}
              ·{" "}
              <button
                type="button"
                className="secondary"
                aria-expanded={viewing}
                onClick={() => setViewing(!viewing)}
              >
                {viewing ? "Hide" : "View"}
                <span className="sr-only"> snapshot from {fmtDay(s.created_at)}</span>
              </button>
            </>
          ) : (
            <span className="muted">available once signed</span>
          )}
        </td>
        <td>
          {s.revoked_at ? null : (
            <button type="button" className="secondary" onClick={() => setConfirming(true)}>
              Revoke<span className="sr-only"> snapshot from {fmtDay(s.created_at)}</span>
            </button>
          )}
          <ProblemAlert error={revoke.error} />
          {confirming ? (
            <ConfirmDialog
              title="Revoke this snapshot?"
              confirmLabel="Revoke snapshot"
              danger
              busy={revoke.isPending}
              onConfirm={() => {
                setConfirming(false);
                revoke.mutate();
              }}
              onCancel={() => setConfirming(false)}
            >
              <p>Its verify URL will report it as revoked. This cannot be undone.</p>
            </ConfirmDialog>
          ) : null}
        </td>
      </tr>
      {viewing && s.status === "signed" ? (
        <tr>
          <td colSpan={5}>
            <SnapshotText snapshotId={s.snapshot_id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function TractionSnapshotsPage() {
  const id = useId();
  const { tenantId } = useParams({ from: "/app/t/$tenantId/traction-snapshots" });
  useTitle("Traction snapshots");
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["traction-snapshots", tenantId],
    queryFn: () => api.call("listTractionSnapshots", { path: { tenantId } }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((s) => s.status === "pending" && !s.revoked_at)
        ? PENDING_POLL_MS
        : false,
  });
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [includeApi, setIncludeApi] = useState(true);
  const [preset, setPreset] = useState<Preset>("custom");
  const quarters = completeQuarters();
  const [quarter, setQuarter] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [outcome, setOutcome] = useState<"signed" | "pending" | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const tenant = useQuery({
    queryKey: ["tenant", tenantId],
    queryFn: () => api.call("getTenant", { path: { tenantId } }),
  });
  const seal = useMutation({
    mutationFn: (v: boolean) =>
      api.call("updateTenant", { path: { tenantId }, body: { seal_enabled: v } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tenant", tenantId] });
    },
  });
  const qp = quarters[quarter] ? quarterPeriod(quarters[quarter].year, quarters[quarter].q) : null;
  const startDay =
    preset === "pg_renewal_quarter"
      ? qp
        ? new Date(qp.start)
        : null
      : start
        ? parseDay(start)
        : null;
  const endDay =
    preset === "pg_renewal_quarter" ? (qp ? new Date(qp.end) : null) : end ? parseDay(end) : null;
  const create = useMutation({
    mutationFn: () =>
      api.call("createTractionSnapshot", {
        path: { tenantId },
        body: {
          period_start: toInstant(startDay as Date),
          period_end: toInstant(endDay as Date),
          include_api: includeApi,
          schema_version: 3,
          preset,
        },
      }),
    onSuccess: async (r) => {
      setOutcome(isPending(r) ? "pending" : "signed");
      setCreatedId(
        isPending(r) ? r.snapshot_id : (r.snapshot as { snapshot_id: string }).snapshot_id,
      );
      setAcknowledged(false);
      await qc.invalidateQueries({ queryKey: ["traction-snapshots", tenantId] });
    },
  });
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <SharingHeader tenantId={tenantId} current="snapshots" />
      <h2 className="um-sr">Traction snapshots</h2>
      <p className="muted">
        A signed, verifiable statement of your project's measured web figures (and, if you choose,
        its API and on-chain figures) over a period — for an SCF application or a report. The
        platform signs it with its published snapshot key; anyone can check the signature at its
        verify link. A signature shows the figures were not changed, not that anyone endorses them.
      </p>
      <ProblemAlert error={list.error} />
      {outcome === "pending" ? (
        <p className="alert ok" data-testid="snapshot-pending" role="status">
          Recorded. The snapshot is being signed; it appears as signed below in a few seconds.
        </p>
      ) : outcome === "signed" ? (
        <p className="alert ok" data-testid="snapshot-signed" role="status">
          Snapshot signed.
        </p>
      ) : null}
      {outcome && createdId ? (
        <div className="card stack" data-testid="snapshot-created-link">
          <p>
            <strong>Your SCF Evidence Link</strong> — paste it into your SCF application (the
            analytics field or a progress report). It opens a public page with the funnel, the
            programme figures and how to verify them
            {outcome === "pending" ? "; it works once the snapshot is signed" : ""}.
          </p>
          <p>
            <code data-testid="snapshot-created-url">{evidenceUrl(createdId)}</code>{" "}
            <CopyButton text={evidenceUrl(createdId)} label="Copy evidence link" />
          </p>
          {outcome === "signed" ? <SnapshotText snapshotId={createdId} /> : null}
        </div>
      ) : null}
      <section className="card" aria-labelledby={`${id}-l`}>
        <h2 id={`${id}-l`}>Snapshots</h2>
        {list.data && list.data.length > 0 ? (
          <div className="table-wrap">
            <table data-testid="snapshots">
              <caption className="sr-only">Traction snapshots</caption>
              <thead>
                <tr>
                  <th scope="col">Period (UTC)</th>
                  <th scope="col">Created</th>
                  <th scope="col">State</th>
                  <th scope="col">Verification</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((s) => (
                  <SnapshotRow key={s.snapshot_id} tenantId={tenantId} s={s} />
                ))}
              </tbody>
            </table>
          </div>
        ) : list.data ? (
          <p>No snapshots yet.</p>
        ) : null}
      </section>
      <form
        className="card stack"
        aria-labelledby={`${id}-c`}
        onSubmit={(e) => {
          e.preventDefault();
          setOutcome(null);
          create.mutate();
        }}
      >
        <h2 id={`${id}-c`}>Create a snapshot</h2>
        <div>
          <label htmlFor={`${id}-p`}>Purpose (preset)</label>
          <select
            id={`${id}-p`}
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_TEXT[p].charAt(0).toUpperCase() + PRESET_TEXT[p].slice(1)}
              </option>
            ))}
          </select>
          <p className="small muted">
            The preset is a label a reader can rely on; you give the dates (an SCF award period's
            dates, the weeks before a campaign, the campaign itself). A Growth Hack campaign is
            whole ISO weeks (Monday to Monday) and is compared with the same number of weeks before
            it; a Public Goods renewal quarter is exactly one calendar quarter and is compared with
            the quarter before.
          </p>
        </div>
        {preset === "pg_renewal_quarter" ? (
          <div>
            <label htmlFor={`${id}-q`}>Quarter</label>
            <select
              id={`${id}-q`}
              value={quarter}
              onChange={(e) => setQuarter(Number(e.target.value))}
            >
              {quarters.map((q, i) => (
                <option key={`${q.year}-${q.q}`} value={i}>
                  Q{q.q} {q.year}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="row">
            <div>
              <label htmlFor={`${id}-s`}>First day (UTC)</label>
              <input
                id={`${id}-s`}
                type="date"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${id}-e`}>Day after the last day (UTC)</label>
              <input
                id={`${id}-e`}
                type="date"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
        )}
        <label className="inline">
          <input
            type="checkbox"
            checked={includeApi}
            onChange={(e) => setIncludeApi(e.target.checked)}
          />
          Include API figures (self-attested telemetry)
        </label>
        <p className="small muted">
          At most 400 days, ending today at the latest. Only project admins can create and revoke
          snapshots.
        </p>
        <div className="alert info" data-testid="publication-notice">
          <p>
            <strong>Publication notice.</strong> Creating a snapshot adds its id, period, preset and
            hash to your project's public list of snapshots — whether or not your statistics are
            public — and the signed document is served to anyone who has its id. Snapshots are
            numbered 1, 2, 3, … and can be revoked but never deleted, so every reader can see that
            none was left out.
          </p>
          <label className="inline">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I understand that this snapshot will be listed publicly
          </label>
        </div>
        {(preset === "growth_hack_before" || preset === "growth_hack_during") &&
        startDay &&
        endDay &&
        !wholeIsoWeeks(startDay, endDay) ? (
          <p className="alert warn" data-testid="snapshot-weeks-hint">
            A Growth Hack window must start on a Monday and last whole weeks (the day after the last
            day is also a Monday).
          </p>
        ) : null}
        <ProblemAlert error={create.error} />
        <button
          type="submit"
          disabled={
            create.isPending ||
            !startDay ||
            !endDay ||
            !acknowledged ||
            ((preset === "growth_hack_before" || preset === "growth_hack_during") &&
              !wholeIsoWeeks(startDay, endDay))
          }
        >
          Create snapshot
        </button>
      </form>
      <section className="card stack" aria-labelledby={`${id}-seal`} data-testid="seal-settings">
        <h2 id={`${id}-seal`}>Daily seal</h2>
        <p>
          When the seal is on, each day's new signed snapshots are committed to one Stellar
          transaction (a Merkle root in its memo), so anyone can check later that a snapshot existed
          unchanged on that day. It is tamper-evidence of published numbers; it does not show that
          the numbers are genuine.
        </p>
        <p className="small" data-testid="seal-network-notice">
          The seal currently runs on Stellar testnet: {TESTNET_NOTICE}
        </p>
        <ProblemAlert error={tenant.error ?? seal.error} />
        {tenant.data ? (
          <label className="inline">
            <input
              type="checkbox"
              checked={tenant.data.seal_enabled === true}
              disabled={seal.isPending}
              onChange={(e) => seal.mutate(e.target.checked)}
            />
            Seal my signed snapshots daily
          </label>
        ) : null}
      </section>
    </>
  );
}
