// SPDX-License-Identifier: Apache-2.0
// Frame of one website, drawn as the project's "Web" and "Wallets" pages (approved design): the page header (with
// the verified / all-received switch on the traffic tab), the website switcher when the project has several, and
// the Web tabs (Traffic · Funnels, goals and journeys · Stellar calls from the browser). The installation check,
// snippet and site settings render their own header (they belong to Trust and Settings).

import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { api } from "../api/client.ts";
import { Chip, ErrorState, Icon, Note, PageHeader, Segmented } from "../components/ui/index.ts";
import { ProjectFrame, useSites } from "./project/common.tsx";
import { DEFAULT_REPORTS_SEARCH } from "./WebReports.tsx";

export function useSite(tenantId: string, siteId: string) {
  return useQuery({
    queryKey: ["site", tenantId, siteId],
    queryFn: () => api.call("getSite", { path: { tenantId, siteId } }),
  });
}

type Kind = "traffic" | "reports" | "browser" | "wallets" | "other";

function kindOf(path: string): Kind {
  const tail = path.replace(/^\/t\/[^/]+\/sites\/[^/]+/, "");
  if (tail === "" || tail === "/") return "traffic";
  if (tail.startsWith("/reports")) return "reports";
  if (tail.startsWith("/browser")) return "browser";
  if (tail.startsWith("/wallets")) return "wallets";
  return "other";
}

const RANGE_TEXT: Record<string, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  "12m": "last 12 months",
  all: "all time",
  custom: "custom days",
};

export function SiteLayout() {
  const { tenantId, siteId } = useParams({ from: "/app/t/$tenantId/sites/$siteId" });
  const site = useSite(tenantId, siteId);
  const sites = useSites(tenantId);
  const path = useLocation({ select: (l) => l.pathname });
  const search = useSearch({ strict: false }) as { range?: string; variant?: string };
  const navigate = useNavigate();
  const kind = kindOf(path);
  const params = { tenantId, siteId };
  const host = site.data?.domains?.[0]?.host ?? site.data?.name ?? "";

  // switch to the same page of another website
  const switchSite = (id: string) => {
    if (id === siteId) return;
    const p = { tenantId, siteId: id };
    if (kind === "wallets")
      void navigate({
        to: "/t/$tenantId/sites/$siteId/wallets",
        params: p,
        search: { network: "mainnet", range: "30d", variant: "verified" },
      });
    else if (kind === "reports")
      void navigate({
        to: "/t/$tenantId/sites/$siteId/reports",
        params: p,
        search: DEFAULT_REPORTS_SEARCH,
      });
    else if (kind === "browser")
      void navigate({
        to: "/t/$tenantId/sites/$siteId/browser",
        params: p,
        search: { range: "30d" },
      });
    else
      void navigate({
        to: "/t/$tenantId/sites/$siteId",
        params: p,
        search: { range: "30d", variant: "verified", compare: false },
      });
  };

  const switcher =
    (sites.data?.length ?? 0) > 1 ? (
      <div className="um-p-tools">
        <Segmented
          label="Website"
          value={siteId}
          onChange={switchSite}
          options={(sites.data ?? []).map((s) => ({
            value: s.site_id,
            label: s.domains?.[0]?.host ?? s.name,
            icon: "globe" as const,
          }))}
        />
      </div>
    ) : null;

  const variant = search.variant === "raw" ? "raw" : "verified";
  const header =
    kind === "wallets" ? (
      <PageHeader
        title="Wallets"
        sub={`${RANGE_TEXT[search.range ?? "30d"] ?? "last 30 days"} · counted in the browser, no wallet addresses stored`}
        badges={<Chip kind="verified" />}
      />
    ) : kind === "other" ? null : (
      <PageHeader
        title="Web"
        sub={`${RANGE_TEXT[search.range ?? "30d"] ?? "last 30 days"} · ${host}`}
        badges={
          kind === "traffic" ? (
            <Segmented
              label="Which traffic"
              value={variant}
              onChange={(v) =>
                void navigate({
                  to: "/t/$tenantId/sites/$siteId",
                  params,
                  search: (prev: Record<string, unknown>) => ({ ...prev, variant: v }) as never,
                  replace: true,
                })
              }
              options={[
                { value: "verified", label: "Verified", icon: "shield" },
                { value: "raw", label: "All received" },
              ]}
            />
          ) : (
            <Chip kind="verified" />
          )
        }
      />
    );

  return (
    <ProjectFrame tenantId={tenantId}>
      {header}
      {site.error ? <ErrorState error={site.error} onRetry={() => void site.refetch()} /> : null}
      {site.data?.status === "over_quota" ? (
        <Note tone="warn">
          This website reached its daily quota of verified events; new events are refused until the
          next UTC day.
        </Note>
      ) : null}
      {kind !== "other" ? switcher : null}
      {kind === "traffic" || kind === "reports" || kind === "browser" ? (
        <nav aria-label="Web sections">
          <ul className="um-tabs">
            <li>
              <Link
                to="/t/$tenantId/sites/$siteId"
                params={params}
                search={{ range: "30d", variant: "verified", compare: false }}
                activeOptions={{ exact: true, includeSearch: false }}
                activeProps={{ "aria-current": "page" }}
              >
                <Icon name="activity" size="sm" />
                Traffic
              </Link>
            </li>
            <li>
              <Link
                to="/t/$tenantId/sites/$siteId/reports"
                params={params}
                search={DEFAULT_REPORTS_SEARCH}
                activeOptions={{ includeSearch: false }}
                activeProps={{ "aria-current": "page" }}
              >
                <Icon name="branch" size="sm" />
                Funnels, goals and journeys
              </Link>
            </li>
            <li>
              <Link
                to="/t/$tenantId/sites/$siteId/browser"
                params={params}
                search={{ range: "30d" }}
                activeOptions={{ includeSearch: false }}
                activeProps={{ "aria-current": "page" }}
              >
                <Icon name="network" size="sm" />
                Stellar calls from the browser
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}
      <Outlet />
    </ProjectFrame>
  );
}
