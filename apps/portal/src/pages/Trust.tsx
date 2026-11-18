// SPDX-License-Identifier: Apache-2.0
// Trust (approved design; plan D-2; ADR-0015, ADR-0028; decision D6: the project sees its trust score exactly as an
// SCF operator does). One page:
//   - the verification ladder L0–L4 with its evidence and next step, and linking the project's Stellar account (L2);
//   - the trust score per website: the daily score over 30 days and the newest 28-day score;
//   - "How the 28-day score is made": the eight trust/1.0.0 components with the measured value, the methodology's
//     thresholds (docs/methodology/scf-methodology-1.0.0.md), the published weights (setting `trust_weights`) and the
//     points each one lost;
//   - flagged days with their reasons and the notes that explain them, with a form to add one;
//   - "Is the tracker installed correctly?": verdict shares, reasons not counted, limits (installation check);
//   - API assurance per service.
// Scores are advisory: they never delete data. /verification renders the same page.

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useState } from "react";
import { api } from "../api/client.ts";
import { StellarProof } from "../auth/components.tsx";
import { useTitle } from "../components/AppShell.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import {
  AccessNotice,
  Button,
  Card,
  Chart,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  KeyValues,
  Legend,
  LoadingState,
  Note,
  PageHeader,
  partialLast,
  Segmented,
  ShareBar,
  SourceList,
  StatusBadge,
  TableScroll,
  Tag,
} from "../components/ui/index.ts";
import { filteredView } from "../lib/apiFormat.ts";
import { fmtDay, fmtDayTime } from "../lib/format.ts";
import {
  type AnomalyFlag,
  ASSURANCE_REASON_TEXT,
  anomalyFlags,
  latestWindowScore,
  reasonText,
  trustBand,
} from "../lib/usage.ts";
import {
  axisLabel,
  completeDays,
  dayList,
  ProjectFrame,
  useServiceList,
  useSites,
} from "./project/common.tsx";
import { BandBadge } from "./project/Overview.tsx";
import { canManage, useMyRole } from "./Team.tsx";

const DAY_MS = 86_400_000;
const dayStart = (day: string) => `${day}T00:00:00Z`;
const dayAfter = (day: string) =>
  new Date(Date.parse(dayStart(day)) + DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");

// ------------------------------------------------------------------ verification

type Status = ControlPlane.VerificationStatus;
type NextStep = NonNullable<Status["next_steps"]>[number];

export const LEVEL_TEXT: Record<ControlPlane.VerificationLevel, string> = {
  L0: "L0 — registered: nothing verified yet",
  L1: "L1 — a website domain is verified",
  L2: "L2 — the project's Stellar account is linked",
  L3: "L3 — matched to an ecosystem registry entry",
  L4: "L4 — approved by an SCF operator",
};
const LADDER: { level: ControlPlane.VerificationLevel; name: string }[] = [
  { level: "L0", name: "Signed up" },
  { level: "L1", name: "Domain verified" },
  { level: "L2", name: "Stellar account linked" },
  { level: "L3", name: "Registry match" },
  { level: "L4", name: "Operator approved" },
];

export const NEXT_STEP_TEXT: Record<NextStep, string> = {
  verify_domain:
    "Verify a website domain (Settings → Websites → Domains): DNS TXT record or a file on the site.",
  link_stellar_account: "Link the project's Stellar account below (L2).",
  await_registry_match:
    "Nothing to do: we match verified domains and contracts against the ecosystem registries automatically (L3).",
  await_operator_approval: "Nothing to do: an SCF operator reviews the project (L4).",
};

export const EVIDENCE_KIND_TEXT: Record<ControlPlane.Evidence["kind"], string> = {
  domain: "Domain",
  stellar_account: "Stellar account",
  registry_match: "Registry match",
  operator_approval: "Operator approval",
};
const EVIDENCE_ICON = {
  domain: ["globe", "web"],
  stellar_account: ["wallet", "wallet"],
  registry_match: ["landmark", "chain"],
  operator_approval: ["shield", "neutral"],
} as const;

function VerificationCard({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const role = useMyRole(tenantId);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["verification", tenantId],
    queryFn: () => api.call("getVerification", { path: { tenantId } }),
  });
  const s = status.data;
  const idx = s ? LADDER.findIndex((l) => l.level === s.level) : -1;
  const hasAccount = (s?.evidence ?? []).some(
    (e) => e.kind === "stellar_account" && e.status === "valid",
  );
  return (
    <Card
      title="Verification level"
      sub="Higher levels make your public numbers carry more weight. It never changes how your analytics are counted."
      actions={s ? <Chip kind="verified">Level {s.level}</Chip> : null}
    >
      {status.error ? (
        <ErrorState error={status.error} plain onRetry={() => void status.refetch()} />
      ) : null}
      {status.isPending ? <LoadingState /> : null}
      {s ? (
        <>
          <p className="um-sr" data-testid="verification-level">
            {s.level} — {LEVEL_TEXT[s.level].split(" — ")[1]}
          </p>
          <ol className="um-p-ladder" aria-label="Verification ladder">
            {LADDER.map((l, i) => (
              <li
                key={l.level}
                className={
                  i <= idx ? "um-p-ladder-done" : i === idx + 1 ? "um-p-ladder-next" : undefined
                }
                aria-current={i === idx ? "step" : undefined}
              >
                <b>{l.level}</b>
                <span>{l.name}</span>
              </li>
            ))}
          </ol>
          <section className="um-grid um-g2">
            <div className="um-p-stack um-p-gap6">
              <span className="um-label">Evidence</span>
              {s.evidence.length === 0 ? (
                <p className="um-muted">No evidence yet.</p>
              ) : (
                <SourceList
                  label="Evidence"
                  items={s.evidence.map((e) => ({
                    key: e.evidence_id,
                    icon: EVIDENCE_ICON[e.kind][0],
                    tone: EVIDENCE_ICON[e.kind][1],
                    title: (
                      <span data-testid={`evidence-${e.kind}`}>
                        {e.kind === "stellar_account"
                          ? e.subject
                          : e.kind === "registry_match"
                            ? (s.registry_links.find((r) => r.registry_project_id === e.subject)
                                ?.name ?? "Registry entry")
                            : e.subject}
                      </span>
                    ),
                    sub: `${EVIDENCE_KIND_TEXT[e.kind]} · verified ${fmtDay(e.verified_at)}${
                      e.last_checked_at ? ` · checked ${fmtDayTime(e.last_checked_at)}` : ""
                    }`,
                    status: (
                      <StatusBadge status={e.status === "valid" ? "live" : "wait"}>
                        {e.status === "valid"
                          ? "Valid"
                          : e.status === "lapsed"
                            ? "Lapsed"
                            : "Revoked"}
                      </StatusBadge>
                    ),
                  }))}
                />
              )}
              {s.registry_links.length > 0 ? (
                <p className="um-p-fine">
                  Registry entries:{" "}
                  {s.registry_links
                    .map(
                      (r) =>
                        `${r.name} (${r.source}, ${r.status}${r.scf_awarded ? ", SCF-awarded" : ""})`,
                    )
                    .join(" · ")}
                </p>
              ) : null}
            </div>
            <div className="um-p-stack um-p-gap6">
              <span className="um-label">Next step</span>
              {s.next_steps && s.next_steps.length > 0 ? (
                <ul className="um-p-mlist" data-testid="next-steps">
                  {s.next_steps.map((n) => (
                    <li key={n}>
                      <span aria-hidden="true">→</span>
                      <span>{NEXT_STEP_TEXT[n]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Note tone="good">
                  <p>The highest level is reached.</p>
                </Note>
              )}
              {linked ? (
                <Note tone="good">
                  <p data-testid="linked">
                    Stellar account <code>{linked}</code> linked.
                  </p>
                </Note>
              ) : null}
              <div>
                <Button
                  size="sm"
                  icon="wallet"
                  aria-expanded={linking}
                  onClick={() => setLinking((v) => !v)}
                >
                  {hasAccount
                    ? "Link another Stellar account"
                    : "Link the project's Stellar account (L2)"}
                </Button>
              </div>
            </div>
          </section>
          {linking ? (
            <div className="um-p-link">
              <h3 className="um-h3">
                {hasAccount
                  ? "Link another Stellar account"
                  : "Link the project's Stellar account (L2)"}
              </h3>
              <ol className="um-p-fine">
                <li>
                  The account's <code>home_domain</code> is one of this project's <b>verified</b>{" "}
                  domains.
                </li>
                <li>
                  <code>https://&lt;that domain&gt;/.well-known/stellar.toml</code> lists the
                  account under <code>ACCOUNTS</code>.
                </li>
                <li>
                  You can sign with keys that reach the account's <b>medium threshold</b> (for a
                  multisig account use the SEP-10 transaction and collect enough signatures).
                </li>
              </ol>
              {canManage(role) ? (
                <StellarProof
                  accountLabel="Project's Stellar account"
                  walletLabel="Link with"
                  submitLabel="Link account"
                  requestChallenge={(account, method) =>
                    api.call("verificationStellarChallenge", {
                      path: { tenantId },
                      body: { account, method },
                    })
                  }
                  submit={async (body, account) => {
                    const next = await api.call("verificationStellarVerify", {
                      path: { tenantId },
                      body,
                    });
                    qc.setQueryData(["verification", tenantId], next);
                    setLinked(account);
                    await qc.invalidateQueries({ queryKey: ["tenant", tenantId] });
                    await qc.invalidateQueries({ queryKey: ["tenants"] });
                  }}
                />
              ) : (
                <AccessNotice kind="read-only">
                  Only the project's owner and admins can link its Stellar account. Ask one of them,
                  or ask for a role that can.
                </AccessNotice>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ trust score

/** trust/1.0.0 (docs/methodology/scf-methodology-1.0.0.md): label, what the input measures and the thresholds. */
const METHOD: { key: string; label: string; what: string; range: string; codes: string }[] = [
  {
    key: "proof_coverage",
    label: "Proof of work",
    what: "Share of page views without a valid proof from the tracker",
    range: "10% → 60%",
    codes: "proof_coverage_low",
  },
  {
    key: "network_quality",
    label: "Network mix",
    what: "Share of traffic from data centres, VPNs and Tor",
    range: "10% → 50%",
    codes: "network_datacenter_share_high",
  },
  {
    key: "multiplicity",
    label: "Many visitors, one network",
    what: "Share of traffic from networks with unusually many visitors",
    range: "5% → 30%",
    codes: "multiplicity_share_high",
  },
  {
    key: "engagement",
    label: "Real engagement",
    what: "Share of visits from automated browsers, hidden tabs or no interaction",
    range: "20% → 70%",
    codes: "engagement_low",
  },
  {
    key: "mix",
    label: "Device and country mix",
    what: "How far a day's mix drifts from the previous 28 days",
    range: "0.10 → 0.50",
    codes: "mix_divergent_device / mix_divergent_country",
  },
  {
    key: "temporal",
    label: "Sudden spikes",
    what: "Day vs. 28-day median (3× → 10×) and the busiest hour's share (25% → 75%)",
    range: "3× → 10×",
    codes: "step_change / burstiness_high",
  },
  {
    key: "pow_latency",
    label: "Proof speed",
    what: "Share of proofs solved implausibly fast (under 100 ms)",
    range: "5% → 50%",
    codes: "pow_latency_implausible",
  },
  {
    key: "cross_signal",
    label: "Matches other signals",
    what: "Agreement with wallet and API activity. Neutral in this version.",
    range: "–",
    codes: "cross_signal_inconsistent",
  },
];
const SHARE_KEYS = new Set([
  "proof_coverage",
  "network_quality",
  "multiplicity",
  "engagement",
  "pow_latency",
]);

function fmtComponent(key: string, v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  return SHARE_KEYS.has(key) ? `${Math.round(v * 100)}%` : v.toFixed(2);
}

export function ComponentsTable({
  score,
  weights,
}: {
  score: ControlPlane.TrustScore;
  weights: Record<string, number> | null;
}) {
  const comps = score.components ?? {};
  let lostTotal = 0;
  const rows = METHOD.map((m) => {
    const c = comps[m.key];
    const w = weights?.[m.key] ?? null;
    const lost = c && w !== null ? w * c.p : null;
    if (lost !== null) lostTotal += lost;
    return { m, c, w, lost };
  });
  const known = new Set(METHOD.map((m) => m.key));
  const extra = Object.entries(comps).filter(([k]) => !known.has(k));
  return (
    <TableScroll label="Score components">
      <table className="um-table um-p-tc" data-testid="trust-components">
        <caption className="um-sr">
          Score components ({score.window_days}-day window ending {fmtDay(dayStart(score.day))})
        </caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col" className="um-r">
              Measured
            </th>
            <th scope="col" className="um-r">
              Counts from → full loss
            </th>
            <th scope="col" className="um-r">
              Weight
            </th>
            <th scope="col">Points lost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, c, w, lost }) => (
            <tr key={m.key}>
              <td>
                <b>{m.label}</b>{" "}
                <code className="um-p-key" title={`API: components.${m.key} · code ${m.codes}`}>
                  {m.key}
                </code>
                <br />
                <small className="um-muted">{c?.explanation ?? m.what}</small>
              </td>
              <td className="um-r">{fmtComponent(m.key, c?.value)}</td>
              <td className="um-r um-muted">{m.range}</td>
              <td className="um-r">{w ?? "–"}</td>
              <td>
                {lost === null ? (
                  <span className="um-p-fine">
                    {c ? "Weight not published" : "Not measured in this window"}
                  </span>
                ) : (
                  <span className="um-p-lost">
                    <svg className="um-p-lostbar" aria-hidden="true" preserveAspectRatio="none">
                      <rect className="um-p-lostbg" width="100%" height="100%" rx="4" />
                      <rect
                        className="um-p-lostfill"
                        width={`${w ? (lost / w) * 100 : 0}%`}
                        height="100%"
                        rx="4"
                      />
                    </svg>
                    <span className="um-num">{lost.toFixed(1)}</span>
                  </span>
                )}
              </td>
            </tr>
          ))}
          {extra.map(([k, c]) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
                <br />
                <small className="um-muted">{c.explanation ?? reasonText(k)}</small>
              </td>
              <td className="um-r">{fmtComponent(k, c.value)}</td>
              <td className="um-r um-muted">–</td>
              <td className="um-r">–</td>
              <td className="um-p-fine">p = {c.p.toFixed(2)}</td>
            </tr>
          ))}
          <tr className="um-p-tot">
            <td>
              <b>Total</b>
            </td>
            <td />
            <td />
            <td className="um-r">
              <b>{weights ? Object.values(weights).reduce((a, v) => a + v, 0) : "–"}</b>
            </td>
            <td>
              <span className="um-num">
                <b>{lostTotal.toFixed(1)}</b> → score {score.score ?? "–"}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </TableScroll>
  );
}

function TrustScoreCards({
  tenantId,
  sites,
  siteId,
  onSite,
}: {
  tenantId: string;
  sites: ControlPlane.Site[];
  siteId: string;
  onSite: (id: string) => void;
}) {
  const span = completeDays(30);
  const thresholds = useQuery({
    queryKey: ["published-thresholds"],
    queryFn: () => api.call("getPublishedThresholds", {}),
    staleTime: 600_000,
  });
  const weights =
    (thresholds.data?.find((s) => s.key === "trust_weights")?.value as
      | Record<string, number>
      | undefined) ?? null;
  const version = thresholds.data?.find((s) => s.key === "trust_algorithm_version")?.value as
    | string
    | undefined;
  const trust = useQueries({
    queries: sites.map((s) => ({
      queryKey: ["trust-scores", tenantId, s.site_id, span.start, span.end],
      queryFn: () =>
        api.call("listSiteTrustScores", { path: { tenantId, siteId: s.site_id }, query: span }),
    })),
  });
  const annotations = useQuery({
    queryKey: ["annotations", tenantId],
    queryFn: () => api.call("listAnnotations", { path: { tenantId } }),
  });
  const i = Math.max(
    0,
    sites.findIndex((s) => s.site_id === siteId),
  );
  const site = sites[i];
  const q = trust[i];
  const latest = latestWindowScore(q?.data ?? []);
  const days = dayList(span.start, span.end);
  const daily = days.map(
    (d) =>
      (q?.data ?? []).find((s) => s.window_days === 1 && s.day.slice(0, 10) === d)?.score ?? null,
  );
  const notes = (annotations.data ?? [])
    .filter((a) => !a.site_id || a.site_id === site?.site_id)
    .map((a) => ({ index: days.indexOf(a.start.slice(0, 10)), label: a.body }))
    .filter((a) => a.index >= 0);
  const flags = anomalyFlags(
    trust.flatMap((x) => x.data ?? []),
    annotations.data ?? [],
  );
  const nameOf = (id: string) => sites.find((s) => s.site_id === id)?.name;
  if (!site) return null;
  return (
    <>
      {sites.length > 1 ? (
        <div className="um-p-tools">
          <Segmented
            label="Website"
            value={site.site_id}
            onChange={onSite}
            options={sites.map((s) => ({
              value: s.site_id,
              label: s.domains?.[0]?.host ?? s.name,
              icon: "globe" as const,
            }))}
          />
        </div>
      ) : null}
      {/* every website keeps its own block (and test hook); only the chosen one shows the details */}
      {sites.map((s, n) =>
        s.site_id === site.site_id ? null : (
          <span key={s.site_id} className="um-sr" data-testid={`trust-site-${s.site_id}`}>
            {s.name}:{" "}
            {latestWindowScore(trust[n]?.data ?? []) ? (
              <BandBadge
                band={trustBand(latestWindowScore(trust[n]?.data ?? [])?.score)}
                score={latestWindowScore(trust[n]?.data ?? [])?.score ?? null}
              />
            ) : (
              "not scored yet"
            )}
          </span>
        ),
      )}
      <div className="um-p-stack" data-testid={`trust-site-${site.site_id}`}>
        <Card
          title="Trust score"
          sub={`Daily score from 0 to 100 for ${site.domains?.[0]?.host ?? site.name}. A dip means more traffic than usual looked automated.`}
          actions={
            latest ? (
              <div className="um-p-scorebox">
                <BandBadge band={trustBand(latest.score)} score={latest.score} />
                <span className="um-kpi-v">
                  <strong>{latest.score ?? "–"}</strong>
                  <span className="um-kpi-u">/100 · 28-day</span>
                </span>
              </div>
            ) : null
          }
        >
          {q?.error ? (
            <ErrorState error={q.error} plain onRetry={() => void q.refetch()} />
          ) : q?.isPending ? (
            <LoadingState block />
          ) : !latest && daily.every((v) => v === null) ? (
            <EmptyState plain title="Not scored yet" icon="activity">
              A score needs at least 10 raw page views in the window. It appears the day after.
            </EmptyState>
          ) : (
            <>
              <Chart
                partial={partialLast(days)}
                label="Daily trust score"
                labels={days.map((d) => axisLabel(d))}
                series={[{ name: "Trust score", color: "web", data: daily, area: true }]}
                annotations={notes}
                format={(v) => String(Math.round(v))}
                max={100}
                height={190}
              />
              {notes.length > 0 ? (
                <Legend items={[{ label: "Your note", color: "yellow", dot: true }]} />
              ) : null}
            </>
          )}
        </Card>
        <Card
          title="How the 28-day score is made"
          sub="Score = 100 − points lost. Each check loses points between its two thresholds, up to its weight."
          actions={
            <span
              className="um-p-fine"
              title="Thresholds from the published methodology; weights are the published platform setting trust_weights"
            >
              Method {latest?.algorithm_version ?? version ?? "trust/1.0.0"}
            </span>
          }
          flush
        >
          {latest ? (
            <>
              <ComponentsTable score={latest} weights={weights} />
              <div className="um-p-cardfoot">
                <p>
                  {latest.reason_codes.length > 0
                    ? `Reasons: ${latest.reason_codes.map((c) => reasonText(c)).join("; ")}.`
                    : "No reason codes in the newest 28-day window."}{" "}
                  Window ends {fmtDay(dayStart(latest.day))}. A component without input is left out
                  and never lowers the score.
                </p>
              </div>
            </>
          ) : (
            <div className="um-p-cardfoot">
              <p>Not scored yet: a score needs at least 10 raw page views.</p>
            </div>
          )}
        </Card>
      </div>
      <Card
        title="Flagged days"
        sub="Explain a spike so readers see the reason next to it. A note never removes the flag or changes the score."
        data-testid="trust-flags"
      >
        {annotations.error ? <ErrorState error={annotations.error} plain /> : null}
        {flags.length === 0 ? (
          <EmptyState plain title="No flagged days in the last 30 days" icon="check" />
        ) : (
          <ul className="um-p-flags">
            {flags.map((f) => (
              <li key={`${f.site_id}-${f.day}`}>
                <FlagCard
                  tenantId={tenantId}
                  flag={f}
                  siteName={sites.length > 1 ? nameOf(f.site_id) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function AnnotateForm({
  tenantId,
  flag,
  onDone,
}: {
  tenantId: string;
  flag: AnomalyFlag;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [codes, setCodes] = useState<string[]>(flag.codes);
  const create = useMutation({
    mutationFn: () =>
      api.call("createAnnotation", {
        path: { tenantId },
        body: {
          site_id: flag.site_id,
          start: dayStart(flag.day),
          end: dayAfter(flag.day),
          body: body.trim(),
          explains_reason_codes: codes,
        },
      }),
    onSuccess: async () => {
      setBody("");
      await qc.invalidateQueries({ queryKey: ["annotations", tenantId] });
      onDone?.();
    },
  });
  return (
    <form
      className="um-p-annform"
      aria-label={`Annotate ${fmtDay(dayStart(flag.day))}`}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Field label={`What happened on ${fmtDay(dayStart(flag.day))}?`}>
        <textarea
          className="um-inp"
          required
          maxLength={1000}
          rows={2}
          value={body}
          placeholder="e.g. launch announced on social media"
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <fieldset className="um-p-fieldset">
        <legend>Reasons this explains</legend>
        {flag.codes.map((c) => (
          <label key={c} className="um-p-check">
            <input
              type="checkbox"
              checked={codes.includes(c)}
              onChange={(e) =>
                setCodes(e.target.checked ? [...codes, c] : codes.filter((x) => x !== c))
              }
            />
            {reasonText(c)}
          </label>
        ))}
      </fieldset>
      <p className="um-p-fine">
        Your note is shown to SCF operators next to the flag. It explains the flag; it does not
        remove it or change the score — an operator may mark the day explained.
      </p>
      <ProblemAlert error={create.error} />
      <div className="um-p-tools">
        {onDone ? (
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={create.isPending || body.trim() === ""}
        >
          Add annotation
        </Button>
      </div>
    </form>
  );
}

export function FlagCard({
  tenantId,
  flag,
  siteName,
}: {
  tenantId: string;
  flag: AnomalyFlag;
  siteName?: string | undefined;
}) {
  const [annotating, setAnnotating] = useState(false);
  return (
    <article className="um-p-flag" data-testid={`flag-${flag.site_id}-${flag.day}`}>
      <div className="um-p-flag-h">
        <h3 className="um-h3">
          {fmtDay(dayStart(flag.day))}
          {siteName ? ` · ${siteName}` : ""}
        </h3>
        <span className={flag.score !== null && flag.score < 70 ? "um-p-hot" : "um-num"}>
          Daily score {flag.score === null ? "—" : flag.score}
        </span>
        <span data-testid="flag-state">
          <StatusBadge status={flag.explained ? "live" : "bad"}>
            {flag.explained ? "explained" : "open"}
          </StatusBadge>
        </span>
        {annotating ? null : (
          <Button size="sm" icon="pen" onClick={() => setAnnotating(true)}>
            Annotate this day<span className="um-sr"> ({fmtDay(dayStart(flag.day))})</span>
          </Button>
        )}
      </div>
      <ul className="um-p-codes">
        {flag.codes.map((c) => (
          <li key={c}>
            {reasonText(c)} <Tag>{c}</Tag>
          </li>
        ))}
      </ul>
      {flag.annotations.length > 0 ? (
        <ul className="um-p-notes" data-testid="flag-annotations">
          {flag.annotations.map((a) => (
            <li key={a.annotation_id}>
              <b>{a.author_kind === "scf_operator" ? "SCF operator" : "Project"}:</b> {a.body}
              {a.marks_explained ? (
                <>
                  {" "}
                  <StatusBadge status="live">marked explained</StatusBadge>
                </>
              ) : null}{" "}
              <span className="um-p-fine">({fmtDayTime(a.created_at)})</span>
            </li>
          ))}
        </ul>
      ) : null}
      {annotating ? (
        <AnnotateForm tenantId={tenantId} flag={flag} onDone={() => setAnnotating(false)} />
      ) : null}
    </article>
  );
}

// ------------------------------------------------------------------ installation check

function InstallationCard({ tenantId, site }: { tenantId: string; site: ControlPlane.Site }) {
  const check = useQuery({
    queryKey: ["installation", tenantId, site.site_id, "30d"],
    queryFn: () =>
      api.call("getInstallationCheck", {
        path: { tenantId, siteId: site.site_id },
        query: { range: "30d" },
      }),
  });
  const d = check.data;
  const total = d ? d.verdicts.verified + d.verdicts.suspect + d.verdicts.rejected : 0;
  const notCounted = d ? d.reasons.filter((r) => r.verdict !== "counter") : [];
  const reasonTotal = notCounted.reduce((a, r) => a + r.count, 0);
  return (
    <Card
      title="Is the tracker installed correctly?"
      sub={`${site.domains?.[0]?.host ?? site.name} · last 30 days`}
      data-testid={`filtered-${site.site_id}`}
      actions={
        d?.tracker_version_seen ? (
          <StatusBadge status={d.outdated_tracker ? "wait" : "live"}>
            Tracker {d.tracker_version_seen} · {d.outdated_tracker ? "update available" : "current"}
          </StatusBadge>
        ) : null
      }
    >
      {check.error ? (
        <ErrorState error={check.error} plain onRetry={() => void check.refetch()} />
      ) : !d ? (
        <LoadingState />
      ) : total === 0 ? (
        <EmptyState plain title="No events received in this period" icon="clock">
          Add the snippet and open your site; the first event shows up in Integrations.
        </EmptyState>
      ) : (
        <>
          <ShareBar
            label="Verified, suspect and rejected events"
            parts={[
              { label: "Verified", share: (d.verdicts.verified / total) * 100, color: "webmid" },
              { label: "Suspect", share: (d.verdicts.suspect / total) * 100, color: "warn" },
              { label: "Rejected", share: (d.verdicts.rejected / total) * 100, color: "bad" },
            ]}
          />
          <p className="um-p-fine" data-testid="filtered-traffic-headline">
            <b>{(((d.verdicts.suspect + d.verdicts.rejected) / total) * 100).toFixed(1)} %</b> of{" "}
            {total.toLocaleString("en-US")} events were not counted in the verified figures:{" "}
            {((d.verdicts.suspect / total) * 100).toFixed(1)} % suspect (counted in raw figures
            only) and {((d.verdicts.rejected / total) * 100).toFixed(1)} % rejected (never counted).
          </p>
          {notCounted.length === 0 ? (
            <p className="um-muted">Every event passed.</p>
          ) : (
            <TableScroll label="Why events were not counted as verified">
              <table className="um-table" data-testid="filtered-traffic-reasons">
                <caption className="um-sr">Why events were not counted as verified</caption>
                <thead>
                  <tr>
                    <th scope="col">Reason</th>
                    <th scope="col">Effect</th>
                    <th scope="col" className="um-r">
                      Events
                    </th>
                    <th scope="col" className="um-r">
                      Share of events
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredView(d.verdicts, d.reasons).rows.map((r) => (
                    <tr key={`${r.code}-${r.verdict}`}>
                      <th scope="row">
                        <span className="um-p-bdk">
                          <svg
                            className="um-p-bdbar um-p-bdbar--warn"
                            aria-hidden="true"
                            preserveAspectRatio="none"
                          >
                            <rect
                              width={`${Math.max(1, (r.count / Math.max(1, reasonTotal)) * 100)}%`}
                              height="100%"
                              rx="5"
                            />
                          </svg>
                          <span>{r.label}</span> <Tag>{r.code}</Tag>
                        </span>
                      </th>
                      <td>
                        {r.verdict === "rejected"
                          ? "rejected — never counted"
                          : "suspect — raw figures only"}
                      </td>
                      <td className="um-r">{r.count.toLocaleString("en-US")}</td>
                      <td className="um-r um-muted">
                        {r.share === null ? "—" : `${(r.share * 100).toFixed(1)} %`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
          <p className="um-p-fine">
            An event can have several reasons, so the reasons need not add up to the total.
          </p>
          <section className="um-grid um-g2">
            <KeyValues
              items={[
                {
                  k: "Many visitors from one network",
                  v: `${d.multiplicity.mode === "enforce" ? "Enforced" : "Watched only"}${
                    d.multiplicity.source === "site" ? " (set by SCF)" : ""
                  }`,
                },
                {
                  k: "Ingest limit",
                  v: `${site.limits.rate_limit_per_min.toLocaleString("en-US")} events/min`,
                },
                {
                  k: "Pages with the wallet kit",
                  v: `${d.kit_present_pageviews.toLocaleString("en-US")} page views`,
                },
                {
                  k: "Dropped at the edge",
                  v:
                    d.drops.length === 0
                      ? "None"
                      : d.drops
                          .map((x) => `${x.count.toLocaleString("en-US")} (${x.label})`)
                          .join(", "),
                },
              ]}
            />
          </section>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ API assurance

function AssuranceSection({ tenantId }: { tenantId: string }) {
  const span = completeDays(30);
  const services = useServiceList(tenantId);
  const assurance = useQueries({
    queries: (services.data ?? []).map((s) => ({
      queryKey: ["api-assurance", tenantId, s.service_id, span.start],
      queryFn: () =>
        api.call("getApiAssurance", { path: { tenantId, serviceId: s.service_id }, query: span }),
    })),
  });
  if (!services.data || services.data.length === 0) return null;
  return (
    <Card
      title="API assurance"
      sub="API figures are self-reported. A0: no checks passed yet; A1: plausibility checks pass; A2: our probes of the public base URL also pass. The on-chain badge compares API volume with the activity of verified contracts."
      data-testid="assurance"
    >
      <ul className="um-p-keyrows">
        {services.data.map((s, i) => {
          const days = assurance[i]?.data ?? [];
          const last = [...days].sort((a, b) => (a.day < b.day ? 1 : -1))[0];
          return (
            <li key={s.service_id} data-testid={`assurance-${s.service_name}`}>
              <div>
                <b>{s.service_name}</b>
                {assurance[i]?.error ? <ErrorState error={assurance[i]?.error} plain /> : null}
                {last ? (
                  <div className="um-p-meta">
                    <span>as of {fmtDay(dayStart(last.day))}</span>
                    <span>on-chain: {last.onchain_badge.replace("_", " ")}</span>
                    {last.reason_codes.map((c) => (
                      <span key={c}>{ASSURANCE_REASON_TEXT[c] ?? c}</span>
                    ))}
                  </div>
                ) : (
                  <div className="um-p-meta">No assurance day yet.</div>
                )}
              </div>
              {last ? <StatusBadge status="set">assurance {last.level}</StatusBadge> : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ page

export function parseTrustSearch(s: Record<string, unknown>): { site?: string } {
  return typeof s.site === "string" && /^[0-9a-f-]{36}$/i.test(s.site) ? { site: s.site } : {};
}

export function TrustPage() {
  const params = useParams({ strict: false }) as { tenantId: string };
  const tenantId = params.tenantId;
  const search = useSearch({ strict: false }) as { site?: string };
  const navigate = useNavigate();
  useTitle("Trust");
  const sites = useSites(tenantId);
  const [picked, setPicked] = useState<string | undefined>(search.site);
  const site = sites.data?.find((s) => s.site_id === picked) ?? sites.data?.[0];
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader
        title="Trust"
        sub="How sure anyone can be that these numbers are real. The same scores and reasons an SCF operator sees; a score never deletes data."
      />
      <VerificationCard tenantId={tenantId} />
      {sites.error ? <ErrorState error={sites.error} onRetry={() => void sites.refetch()} /> : null}
      {sites.isPending ? <LoadingState block /> : null}
      {sites.data && sites.data.length === 0 ? (
        <EmptyState
          title="No website yet"
          icon="globe"
          action={
            <Link
              to="/t/$tenantId/integrations"
              params={{ tenantId }}
              search={{ group: "web" }}
              className="um-link"
            >
              Add your website
            </Link>
          }
        >
          The trust score is computed for websites, from the checks every page view goes through.
        </EmptyState>
      ) : null}
      {sites.data && site ? (
        <>
          <TrustScoreCards
            tenantId={tenantId}
            sites={sites.data}
            siteId={site.site_id}
            onSite={(id) => {
              setPicked(id);
              void navigate({ to: ".", search: { site: id } as never, replace: true });
            }}
          />
          <InstallationCard tenantId={tenantId} site={site} />
        </>
      ) : null}
      <AssuranceSection tenantId={tenantId} />
    </ProjectFrame>
  );
}

/** /t/:id/verification: the same page (the verification ladder is its first card). */
export const VerificationPage = TrustPage;
