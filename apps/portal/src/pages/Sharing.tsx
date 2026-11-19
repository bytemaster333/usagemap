// SPDX-License-Identifier: Apache-2.0
// Sharing (approved design; share.signed-usage-report, ADR-0032, wire-formats §i.1): everything stays private until the project shares
// it. Tabs: Public stats (off by default, C-14: when on, anyone can read the hourly-rebuilt metrics document and the
// public page; when off they answer not found and only share-key holders and SCF operators can read), Signed
// snapshots (/traction-snapshots), Badges (self-contained and live badges; they need public stats on) and the
// user-tracking statement for an SCF application. Share keys are managed on the Keys page.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useState } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import {
  buttonClass,
  Card,
  CodeBlock,
  CopyText,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Note,
  PageHeader,
  SourceList,
  StatusBadge,
  Switch,
} from "../components/ui/index.ts";
import { badgeHtml, badgeLines, badgeTextWidth } from "../lib/badge.ts";
import { fmtDay } from "../lib/format.ts";
import { ProjectFrame, useTenant } from "./project/common.tsx";

/** Path of the project's metrics document (the portal proxies /public/* to the control plane). */
export const metricsPath = (slug: string) =>
  `/public/v1/projects/${encodeURIComponent(slug)}/metrics.json`;

export type SharingTab = "public" | "badges" | "statement";

export function parseSharingSearch(s: Record<string, unknown>): { tab?: SharingTab } {
  return s.tab === "badges" || s.tab === "statement" ? { tab: s.tab } : {};
}

/** Header and section tabs, shared with the signed-snapshots page. */
export function SharingHeader({
  tenantId,
  current,
}: {
  tenantId: string;
  current: SharingTab | "snapshots";
}) {
  const cur = (t: string) => (t === current ? { "aria-current": "page" as const } : {});
  return (
    <>
      <PageHeader title="Sharing" sub="Everything here stays private until you share it." />
      <nav aria-label="Sharing sections">
        <ul className="um-tabs">
          <li>
            <Link to="/t/$tenantId/sharing" params={{ tenantId }} search={{}} {...cur("public")}>
              Public stats
            </Link>
          </li>
          <li>
            <Link to="/t/$tenantId/traction-snapshots" params={{ tenantId }} {...cur("snapshots")}>
              Signed snapshots
            </Link>
          </li>
          <li>
            <Link
              to="/t/$tenantId/sharing"
              params={{ tenantId }}
              search={{ tab: "badges" }}
              {...cur("badges")}
            >
              Badges
            </Link>
          </li>
          <li>
            <Link
              to="/t/$tenantId/sharing"
              params={{ tenantId }}
              search={{ tab: "statement" }}
              {...cur("statement")}
            >
              User-tracking statement
            </Link>
          </li>
        </ul>
      </nav>
    </>
  );
}

function PublicStatsCard({ tenant }: { tenant: ControlPlane.Tenant }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const update = useMutation({
    mutationFn: (on: boolean) =>
      api.call("updateTenant", {
        path: { tenantId: tenant.tenant_id },
        body: { public_stats_enabled: on },
      }),
    onSuccess: (t) => qc.setQueryData(["tenant", tenant.tenant_id], t),
  });
  const on = tenant.public_stats_enabled;
  const page = `${window.location.origin}/p/${encodeURIComponent(tenant.slug)}`;
  const doc = `${window.location.origin}${metricsPath(tenant.slug)}`;
  return (
    <Card tone={on ? "web" : "neutral"}>
      <div className="um-p-pubcard">
        <span className={`um-tile um-tile--lg ${on ? "um-tone-web" : "um-tone-neutral"}`}>
          <Icon name={on ? "globe" : "lock"} />
        </span>
        <div className="um-p-stack um-p-gap6">
          <h2 className="um-h2">Public stats</h2>
          <p data-testid="public-state">
            {on ? (
              <>
                <b>On.</b> Anyone can read your project's metrics document and its public page.
                Visitors are never listed.
              </>
            ) : (
              <>
                <b>Off.</b> Only holders of a share key (and SCF operators) can read your metrics
                document; the public page answers not found.
              </>
            )}
          </p>
          <div className="um-grid um-g2 um-p-urls">
            <div className={on ? "um-p-url" : "um-p-url um-p-url--off"}>
              <Icon name="link" size="sm" />
              <span>{page.replace(/^https?:\/\//, "")}</span>
              {on ? <CopyText text={page} label="Copy" /> : null}
            </div>
            <div className={on ? "um-p-url" : "um-p-url um-p-url--off"}>
              <Icon name="code" size="sm" />
              <span data-testid="metrics-path">{metricsPath(tenant.slug)}</span>
              {on ? <CopyText text={doc} label="Copy URL" /> : null}
            </div>
          </div>
          <p className="um-p-fine">
            The document holds the last 30 complete UTC days: verified and raw page views, the sum
            of daily unique visitors, visit metrics, a daily series, and your API figures labelled
            “self-attested telemetry”. It never contains your trust score, routes, referrers or
            anything about individual visitors.{" "}
            {on ? (
              <Link className="um-link" to="/p/$slug" params={{ slug: tenant.slug }}>
                Open the public page
              </Link>
            ) : null}
          </p>
        </div>
        <Switch
          label={on ? "Make statistics private" : "Make statistics public"}
          checked={on}
          disabled={update.isPending}
          onChange={(v) => (v ? setConfirming(true) : update.mutate(false))}
        />
      </div>
      <ProblemAlert error={update.error} />
      {confirming ? (
        <ConfirmDialog
          title="Make your statistics public?"
          confirmLabel="Make public"
          busy={update.isPending}
          onConfirm={() => {
            setConfirming(false);
            update.mutate(true);
          }}
          onCancel={() => setConfirming(false)}
        >
          <p>
            Anyone will be able to read your project's metrics document. Cached copies may stay
            readable for up to an hour after you switch it off again.
          </p>
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}

interface MetricsDocLite {
  project: { name: string; slug: string };
  window: { end: string; days: number };
  web: { verified: { visitors_sum: number } };
}

function BadgesCard({ tenant }: { tenant: ControlPlane.Tenant }) {
  const on = tenant.public_stats_enabled;
  const doc = useQuery({
    queryKey: ["metrics-doc", tenant.slug],
    enabled: on,
    queryFn: () =>
      api.call("getMetricsEndpoint", { path: { slug: tenant.slug } }) as Promise<unknown>,
  });
  const base = `${window.location.origin}/public/v1/projects/${encodeURIComponent(tenant.slug)}`;
  const shields = `https://img.shields.io/endpoint?url=${encodeURIComponent(`${base}/badge.json`)}`;
  const markdown = `[![Measured by UsageMap](${shields})](${window.location.origin}/p/${encodeURIComponent(tenant.slug)})`;
  const d = doc.data as MetricsDocLite | undefined;
  const input = d
    ? {
        name: d.project.name,
        verifiedVisitors: d.web.verified.visitors_sum,
        days: d.window.days,
        asOf: new Date(Date.parse(d.window.end) - 86_400_000).toISOString().slice(0, 10),
        cardUrl: `${window.location.origin}/p/${encodeURIComponent(d.project.slug)}`,
      }
    : null;
  const lines = input ? badgeLines(input) : null;
  const lw = lines ? badgeTextWidth(lines.left) : 0;
  const rw = lines ? badgeTextWidth(lines.right) : 0;
  return (
    <Card
      title="Badges"
      sub={
        on
          ? "Live numbers for your README and docs"
          : "Live numbers for your README and docs. Badges need public stats on."
      }
      data-testid="badge"
    >
      {!on ? (
        <EmptyState
          plain
          title="Public stats are off"
          icon="lock"
          action={
            <Link
              to="/t/$tenantId/sharing"
              params={{ tenantId: tenant.tenant_id }}
              search={{}}
              className={buttonClass("secondary", { size: "sm" })}
            >
              Turn on public stats
            </Link>
          }
        >
          Badges show your verified totals, so they work only while your statistics are public.
        </EmptyState>
      ) : doc.error ? (
        <ErrorState error={doc.error} plain onRetry={() => void doc.refetch()} />
      ) : !input || !lines ? (
        <LoadingState />
      ) : (
        <>
          <p className="um-p-badges">
            <svg
              width={lw + rw}
              height={20}
              viewBox={`0 0 ${lw + rw} 20`}
              role="img"
              aria-label={`${lines.left}: ${lines.right}`}
            >
              <rect width={lw} height={20} rx={3} className="um-p-bdg-l" />
              <rect x={lw} width={rw} height={20} className="um-p-bdg-r" />
              <g className="um-p-bdg-t">
                <text x={6} y={14}>
                  {lines.left}
                </text>
                <text x={lw + 6} y={14}>
                  {lines.right}
                </text>
              </g>
            </svg>
          </p>
          <CodeBlock
            title="Self-contained badge (HTML)"
            code={badgeHtml(input)}
            copyLabel="Copy badge HTML"
            testId="badge-code"
          />
          <CodeBlock
            title="README.md (live, updated hourly)"
            code={markdown}
            copyLabel="Copy README badge"
          />
          <p className="um-p-fine" data-testid="server-badges">
            Live SVG: <code>{base}/badge.svg</code> (add <code>?metric=api</code> for API requests).
            The self-contained badge is as of {fmtDay(`${input.asOf}T00:00:00Z`)} and the page that
            embeds it never contacts UsageMap.
          </p>
        </>
      )}
    </Card>
  );
}

const SOURCE_TEXT: Record<string, string> = {
  web: "Website page views",
  wallet: "Wallet events",
  passkey: "Passkey and smart-wallet events",
  api: "API request metrics",
  stellar_client: "Stellar RPC / Horizon client metrics",
  onchain: "On-chain activity of registered contracts",
};
const SOURCE_ICON: Record<
  string,
  [
    "globe" | "wallet" | "key" | "server" | "network" | "layers",
    "web" | "wallet" | "neutral" | "api" | "chain",
  ]
> = {
  web: ["globe", "web"],
  wallet: ["wallet", "wallet"],
  passkey: ["key", "neutral"],
  api: ["server", "api"],
  stellar_client: ["network", "api"],
  onchain: ["layers", "chain"],
};

export function UserTrackingCard({ tenantId, name }: { tenantId: string; name: string }) {
  const q = useQuery({
    queryKey: ["user-tracking", tenantId],
    queryFn: () => api.call("getUserTrackingStatement", { path: { tenantId } }),
  });
  const s = q.data;
  return (
    <Card
      title={`How ${name} measures usage`}
      sub="A ready paragraph for your SCF application, generated from what is really connected. Review it before you paste it."
      actions={
        s ? <CopyText text={s.paragraph} label="Copy paragraph" variant="secondary" /> : null
      }
      data-testid="user-tracking"
    >
      {q.error ? (
        <ErrorState error={q.error} plain onRetry={() => void q.refetch()} />
      ) : !s ? (
        <LoadingState />
      ) : (
        <>
          <blockquote className="um-p-quote" data-testid="user-tracking-paragraph">
            <p>{s.paragraph}</p>
          </blockquote>
          <p className="um-p-fine">
            Generated from what UsageMap received between {fmtDay(s.window.start)} and{" "}
            {fmtDay(s.window.end)} (UTC). Only sources that delivered data are named.
          </p>
          <section className="um-grid um-g2">
            {s.sources.length > 0 ? (
              <div data-testid="user-tracking-sources">
                <SourceList
                  label="Sources"
                  items={s.sources.map((src) => ({
                    key: src.source,
                    icon: SOURCE_ICON[src.source]?.[0] ?? "plug",
                    tone: SOURCE_ICON[src.source]?.[1] ?? "neutral",
                    title: SOURCE_TEXT[src.source] ?? src.source,
                    sub: src.detail,
                    status:
                      src.status === "measured" ? (
                        <StatusBadge status="live">Measured</StatusBadge>
                      ) : (
                        <StatusBadge status="set">Set up, no data yet</StatusBadge>
                      ),
                  }))}
                />
              </div>
            ) : (
              <EmptyState plain title="No source has delivered data yet" />
            )}
            <div className="um-p-stack um-p-gap6">
              <span className="um-label">Never collected</span>
              <p className="um-p-nochips">
                {s.never_collected.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </p>
            </div>
          </section>
          <details className="um-p-details">
            <summary>Data-flow diagram (Mermaid)</summary>
            <CodeBlock
              title="mermaid"
              code={s.mermaid}
              copyLabel="Copy diagram"
              testId="user-tracking-mermaid"
            />
          </details>
          <p className="um-p-fine">
            Details for readers:{" "}
            <a className="um-link" href={s.links.privacy}>
              what is collected and for how long
            </a>
            {s.links.public_stats ? (
              <>
                {" · "}
                <a className="um-link" href={s.links.public_stats}>
                  public statistics
                </a>
              </>
            ) : null}
            {s.links.snapshot ? (
              <>
                {" · "}
                <a className="um-link" href={s.links.snapshot}>
                  latest signed snapshot
                </a>
              </>
            ) : null}
          </p>
        </>
      )}
    </Card>
  );
}

export function SharingPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/sharing" });
  const search = useSearch({ from: "/app/t/$tenantId/sharing" });
  const tab = search.tab ?? "public";
  useTitle("Sharing");
  const tenant = useTenant(tenantId);
  return (
    <ProjectFrame tenantId={tenantId}>
      <SharingHeader tenantId={tenantId} current={tab} />
      {tenant.error ? (
        <ErrorState error={tenant.error} onRetry={() => void tenant.refetch()} />
      ) : null}
      {tenant.isPending ? <LoadingState block /> : null}
      {tenant.data && tab === "public" ? (
        <>
          <PublicStatsCard tenant={tenant.data} />
          <Note icon="key">
            <p>
              Anyone with a share key, AI assistants included, can read the metrics document, even
              while public stats are off.{" "}
              <Link className="um-link" to="/t/$tenantId/ingest-tokens" params={{ tenantId }}>
                Manage share keys in Keys
              </Link>
            </p>
          </Note>
        </>
      ) : null}
      {tenant.data && tab === "badges" ? <BadgesCard tenant={tenant.data} /> : null}
      {tenant.data && tab === "statement" ? (
        <UserTrackingCard tenantId={tenantId} name={tenant.data.name} />
      ) : null}
    </ProjectFrame>
  );
}
