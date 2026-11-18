// SPDX-License-Identifier: Apache-2.0
// Frame of one API service, drawn as the project's "API" page (approved design): the header with the Self-reported
// chip, the service switcher and the assurance level, and the API sections as tabs (search parameter `tab` on the
// dashboard route). The OpenTelemetry set-up route renders below the same header.

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
import {
  buttonClass,
  Chip,
  ErrorState,
  Note,
  PageHeader,
  Segmented,
  StatusBadge,
  Tabs,
  tabPanelProps,
} from "../components/ui/index.ts";
import type { ApiTab } from "../lib/search.ts";
import { ProjectFrame, useServiceList } from "./project/common.tsx";

export function useService(tenantId: string, serviceId: string) {
  return useQuery({
    queryKey: ["service", tenantId, serviceId],
    queryFn: () => api.call("getService", { path: { tenantId, serviceId } }),
  });
}

const TABS: { id: ApiTab; label: string }[] = [
  { id: "traffic", label: "Traffic" },
  { id: "surfaces", label: "Stellar surfaces" },
  { id: "sdk", label: "Stellar SDK calls" },
  { id: "partners", label: "Partner calls" },
  { id: "payments", label: "Payments" },
  { id: "anchors", label: "Anchor funnel" },
  { id: "quality", label: "Data quality" },
];

const RANGE_TEXT: Record<string, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  "12m": "last 12 months",
  all: "all time",
  custom: "custom days",
};

export function ServiceLayout() {
  const { tenantId, serviceId } = useParams({ from: "/app/t/$tenantId/services/$serviceId" });
  const svc = useService(tenantId, serviceId);
  const services = useServiceList(tenantId);
  const path = useLocation({ select: (l) => l.pathname });
  const setup = path.endsWith("/setup");
  const search = useSearch({ strict: false }) as { range?: string; tab?: ApiTab };
  const navigate = useNavigate();
  const params = { tenantId, serviceId };
  const tab = search.tab ?? "traffic";
  const assurance = useQuery({
    queryKey: ["api-summary-head", tenantId, serviceId],
    queryFn: () => api.call("getApiSummary", { path: params, query: { range: "7d" } }),
    enabled: !setup,
  });
  const level = assurance.data?.assurance_level;
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader
        title="API"
        sub={
          setup
            ? `OpenTelemetry set-up · ${svc.data?.service_name ?? ""}`
            : `${RANGE_TEXT[search.range ?? "7d"] ?? "last 7 days"} · numbers your servers report`
        }
        badges={<Chip kind="self" />}
      />
      <div className="um-p-tools">
        {(services.data?.length ?? 0) > 0 ? (
          <Segmented
            label="Service"
            value={serviceId}
            onChange={(id) =>
              void navigate({
                to: "/t/$tenantId/services/$serviceId",
                params: { tenantId, serviceId: id },
                search: { range: "7d", compare: false, sort: "-requests" },
              })
            }
            options={(services.data ?? []).map((s) => ({
              value: s.service_id,
              label: s.display_name ?? s.service_name,
              icon: "server" as const,
            }))}
          />
        ) : null}
        <Link
          to={setup ? "/t/$tenantId/services/$serviceId" : "/t/$tenantId/services/$serviceId/setup"}
          params={params}
          search={
            (setup
              ? { range: "7d", compare: false, sort: "-requests" }
              : { stack: "node" }) as never
          }
          className={buttonClass("ghost", { size: "sm" })}
        >
          {setup ? "Back to the numbers" : "OpenTelemetry set-up"}
        </Link>
        {level ? (
          <span data-testid="api-assurance" title="How far UsageMap's checks go for this service">
            <StatusBadge status="set">Assurance {level}</StatusBadge>
          </span>
        ) : null}
      </div>
      {svc.error ? <ErrorState error={svc.error} onRetry={() => void svc.refetch()} /> : null}
      {svc.data?.status === "archived" ? (
        <Note tone="warn">This service is archived; new data for it is not stored.</Note>
      ) : null}
      {setup ? null : (
        <Tabs
          label="API sections"
          idBase="api"
          items={TABS}
          value={tab}
          onChange={(t) =>
            void navigate({
              to: "/t/$tenantId/services/$serviceId",
              params,
              search: (prev: Record<string, unknown>) =>
                ({ ...prev, tab: t === "traffic" ? undefined : t }) as never,
              replace: true,
            })
          }
        />
      )}
      {setup ? (
        <Outlet />
      ) : (
        <div {...tabPanelProps("api", tab)} className="um-p-stack">
          <Outlet />
        </div>
      )}
    </ProjectFrame>
  );
}
