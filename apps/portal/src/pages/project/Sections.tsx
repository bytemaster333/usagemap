// SPDX-License-Identifier: Apache-2.0
// Entry points of the project sections that live on a website's routes: "Web" and "Wallets" open the first website
// (or say how to add one), and the Web page's "Stellar calls from the browser" tab.

import { Link, Navigate, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTitle } from "../../components/AppShell.tsx";
import { BrowserRpcPanel } from "../../components/BrowserRpcPanel.tsx";
import {
  buttonClass,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  PageHeader,
} from "../../components/ui/index.ts";
import {
  completeDays,
  ProjectFrame,
  type ProjectRange,
  parseProjectRange,
  RangePicker,
  rangeDays,
  useSites,
} from "./common.tsx";

function NoWebsite({ tenantId, title, sub }: { tenantId: string; title: string; sub: string }) {
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader title={title} sub={sub} badges={<Chip kind="verified" />} />
      <EmptyState
        title="No website yet"
        icon="globe"
        action={
          <Link
            to="/t/$tenantId/integrations"
            params={{ tenantId }}
            search={{ group: "web" }}
            className={buttonClass("primary", { size: "sm" })}
          >
            <Icon name="plug" />
            Add your website
          </Link>
        }
      >
        Pick your framework in Integrations: you get a ready snippet with your site key, a test, and
        the first event as it arrives.
      </EmptyState>
    </ProjectFrame>
  );
}

/** /t/:id/web — the first website's traffic. */
export function WebIndexPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/web" });
  const sites = useSites(tenantId);
  useTitle("Web");
  if (sites.isPending) return <LoadingState block label="Loading your websites…" />;
  if (sites.error) return <ErrorState error={sites.error} onRetry={() => void sites.refetch()} />;
  const first = sites.data[0];
  if (!first)
    return (
      <NoWebsite
        tenantId={tenantId}
        title="Web"
        sub="Verified page views and visitors of your websites"
      />
    );
  return (
    <Navigate
      to="/t/$tenantId/sites/$siteId"
      params={{ tenantId, siteId: first.site_id }}
      search={{ range: "30d", variant: "verified", compare: false }}
      replace
    />
  );
}

/** /t/:id/wallets — the first website's wallet funnel. */
export function WalletsIndexPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/wallets" });
  const sites = useSites(tenantId);
  useTitle("Wallets");
  if (sites.isPending) return <LoadingState block label="Loading your websites…" />;
  if (sites.error) return <ErrorState error={sites.error} onRetry={() => void sites.refetch()} />;
  const first = sites.data[0];
  if (!first)
    return (
      <NoWebsite
        tenantId={tenantId}
        title="Wallets"
        sub="Wallet connects and signatures, counted in the browser"
      />
    );
  return (
    <Navigate
      to="/t/$tenantId/sites/$siteId/wallets"
      params={{ tenantId, siteId: first.site_id }}
      search={{ network: "mainnet", range: "30d", variant: "verified" }}
      replace
    />
  );
}

export function parseBrowserSearch(s: Record<string, unknown>): {
  range: ProjectRange;
  variant?: "verified" | "raw";
} {
  return s.variant === "raw"
    ? { range: parseProjectRange(s.range), variant: "raw" }
    : { range: parseProjectRange(s.range) };
}

/** /t/:id/sites/:siteId/browser — Stellar RPC and Horizon calls made from visitors' browsers. */
export function BrowserCallsPage() {
  const { tenantId, siteId } = useParams({ from: "/app/t/$tenantId/sites/$siteId/browser" });
  const search = useSearch({ from: "/app/t/$tenantId/sites/$siteId/browser" });
  const navigate = useNavigate();
  useTitle("Stellar calls from the browser");
  const span = completeDays(rangeDays(search.range) === 1 ? 1 : rangeDays(search.range));
  // the panel widens to whole UTC days; for 24h include today
  const range =
    search.range === "24h"
      ? { start: span.end, end: new Date(Date.parse(span.end) + 86_400_000).toISOString() }
      : span;
  return (
    <>
      <RangePicker
        value={search.range}
        onChange={(r) =>
          void navigate({
            to: "/t/$tenantId/sites/$siteId/browser",
            params: { tenantId, siteId },
            search: { ...search, range: r },
            replace: true,
          })
        }
      />
      <BrowserRpcPanel
        tenantId={tenantId}
        siteId={siteId}
        range={range}
        variant={search.variant ?? "verified"}
      />
    </>
  );
}
