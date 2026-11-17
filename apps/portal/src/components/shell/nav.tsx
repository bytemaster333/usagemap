// SPDX-License-Identifier: Apache-2.0
// Sidebar navigation of the two shells. One entry per existing route; page agents add or rename entries here.
// Active state comes from the router (TanStack Link sets aria-current="page"; the CSS draws the band + yellow bar).

import { useQuery } from "@tanstack/react-query";
import { createLink, useLocation } from "@tanstack/react-router";
import { type AnchorHTMLAttributes, forwardRef, type ReactNode } from "react";
import { api } from "../../api/client.ts";
import { OPERATOR_DEFAULT_SEARCH } from "../../pages/operator/OperatorLayout.tsx";
import { Icon, type IconName } from "../ui/basics.tsx";

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & { icon: IconName; count?: ReactNode };

const NavAnchor = forwardRef<HTMLAnchorElement, AnchorProps>(function NavAnchor(
  // the router's default active className ("active") is not used: aria-current="page" drives the style
  { icon, count, children, className: _routerClass, ...rest },
  ref,
) {
  return (
    <a ref={ref} {...rest} className="um-nav-a">
      <Icon name={icon} />
      {children}
      {count !== undefined && count !== null && count !== "" ? (
        <span className="um-nav-cnt">{count}</span>
      ) : null}
    </a>
  );
});

/** A typed router link drawn as a sidebar item. */
export const NavLink = createLink(NavAnchor);

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <p className="um-nav-g">{title}</p>
      <ul>{children}</ul>
    </>
  );
}

/** Project sidebar. Without a project in the URL it offers the project list and "Find your project". */
export function ProjectNav({ tenantId }: { tenantId: string | undefined }) {
  if (!tenantId) {
    return (
      <nav className="um-nav" aria-label="Stellar ecosystem projects">
        <Group title="Stellar ecosystem projects">
          <li>
            <NavLink to="/tenants" icon="list">
              Your projects
            </NavLink>
          </li>
          <li>
            <NavLink to="/onboard" search={{}} icon="search">
              Find your project
            </NavLink>
          </li>
        </Group>
      </nav>
    );
  }
  return <TenantNavList tenantId={tenantId} />;
}

/** A project section that spans several routes: current when the path is under any of them. */
function sectionOf(path: string, tenantId: string): string {
  const rest = path.slice(`/t/${tenantId}`.length);
  if (rest === "" || rest === "/") return "overview";
  if (/^\/sites\/[^/]+\/wallets/.test(rest) || rest.startsWith("/wallets")) return "wallets";
  if (/^\/sites\/[^/]+\/(settings|snippet)/.test(rest)) return "settings";
  if (/^\/sites\/[^/]+\/installation/.test(rest)) return "trust";
  if (rest.startsWith("/sites") || rest.startsWith("/web")) return "web";
  if (rest.startsWith("/services")) return "api";
  if (rest.startsWith("/apps")) return "apps";
  if (/^\/(onchain|usage-map|protocols|footprint|setup\/footprint)/.test(rest)) return "onchain";
  if (/^\/(trust|verification)/.test(rest)) return "trust";
  if (/^\/(sharing|traction-snapshots)/.test(rest)) return "sharing";
  if (/^\/(integrations|setup)/.test(rest)) return "integrations";
  if (rest.startsWith("/team")) return "team";
  if (rest.startsWith("/ingest-tokens")) return "keys";
  if (/^\/(settings|erasure)/.test(rest)) return "settings";
  return "";
}

function TenantNavList({ tenantId }: { tenantId: string }) {
  const params = { tenantId };
  const path = useLocation({ select: (l) => l.pathname });
  const section = sectionOf(path, tenantId);
  // sections spanning several routes are marked current here (the router marks only exact matches)
  const cur = (s: string) =>
    section === s ? { inactiveProps: { "aria-current": "page" as const } } : {};
  const status = useQuery({
    queryKey: ["integration-status", tenantId],
    queryFn: () => api.call("getIntegrationStatus", { path: { tenantId }, query: {} }),
    staleTime: 60_000,
  });
  const live = status.data?.statuses.filter((x) => x.status === "live_data_seen").length;
  return (
    <nav className="um-nav" aria-label="Project">
      <Group title="Analytics">
        <li>
          <NavLink
            to="/t/$tenantId"
            params={params}
            search={{}}
            activeOptions={{ exact: true, includeSearch: false }}
            icon="home"
          >
            Overview
          </NavLink>
        </li>
        <li>
          <NavLink to="/t/$tenantId/web" params={params} {...cur("web")} icon="globe">
            Web
          </NavLink>
        </li>
        <li>
          <NavLink to="/t/$tenantId/services" params={params} {...cur("api")} icon="server">
            API
          </NavLink>
        </li>
        <li>
          <NavLink to="/t/$tenantId/wallets" params={params} {...cur("wallets")} icon="wallet">
            Wallets
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/t/$tenantId/apps"
            params={params}
            search={{ range: "30d" }}
            activeOptions={{ includeSearch: false }}
            icon="phone"
          >
            Mobile apps
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/t/$tenantId/onchain"
            params={params}
            search={{ range: "30d" }}
            {...cur("onchain")}
            icon="layers"
          >
            On-chain
          </NavLink>
        </li>
      </Group>
      <Group title="Proof">
        <li>
          <NavLink to="/t/$tenantId/trust" params={params} {...cur("trust")} icon="shield">
            Trust
          </NavLink>
        </li>
        <li>
          <NavLink to="/t/$tenantId/sharing" params={params} {...cur("sharing")} icon="share">
            Sharing
          </NavLink>
        </li>
      </Group>
      <Group title="Setup">
        <li>
          <NavLink
            to="/t/$tenantId/integrations"
            params={params}
            search={{}}
            {...cur("integrations")}
            icon="plug"
            count={live ? `${live} live` : undefined}
          >
            Integrations
          </NavLink>
        </li>
        <li>
          <NavLink to="/t/$tenantId/team" params={params} {...cur("team")} icon="users">
            Team
          </NavLink>
        </li>
        <li>
          <NavLink to="/t/$tenantId/ingest-tokens" params={params} {...cur("keys")} icon="key">
            Keys
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/t/$tenantId/settings"
            params={params}
            search={{}}
            {...cur("settings")}
            icon="gear"
          >
            Settings
          </NavLink>
        </li>
      </Group>
    </nav>
  );
}

interface OpEntry {
  group: string;
  label: string;
  /** path prefix that marks the entry current (also for its sub-pages) */
  prefix: string;
}

/** Operator nav entries, used for the top bar title (group › page). */
export const OPERATOR_PAGES: OpEntry[] = [
  { group: "Ecosystem", label: "Overview", prefix: "/operator/overview" },
  { group: "Ecosystem", label: "Web", prefix: "/operator/web" },
  { group: "Ecosystem", label: "API", prefix: "/operator/api" },
  { group: "Ecosystem", label: "Cohorts", prefix: "/operator/cohorts" },
  { group: "On-chain", label: "Usage map", prefix: "/operator/usage-map" },
  { group: "On-chain", label: "Protocols", prefix: "/operator/protocols" },
  { group: "Projects", label: "Stellar ecosystem projects", prefix: "/operator/tenants" },
  { group: "Projects", label: "Registry coverage", prefix: "/operator/onboarding" },
  { group: "Projects", label: "Tombstones", prefix: "/operator/tombstones" },
  { group: "Governance", label: "Audit log", prefix: "/operator/audit" },
  { group: "Governance", label: "Erasure requests", prefix: "/operator/erasure" },
  { group: "Governance", label: "API keys", prefix: "/operator/api-keys" },
  { group: "Governance", label: "Operators", prefix: "/operator/operators" },
  { group: "Governance", label: "Settings", prefix: "/operator/settings" },
];

export function useOperatorPage(): OpEntry | undefined {
  const path = useLocation({ select: (l) => l.pathname });
  return OPERATOR_PAGES.find((p) => path === p.prefix || path.startsWith(`${p.prefix}/`));
}

const DEF = OPERATOR_DEFAULT_SEARCH;
const loose = { includeSearch: false } as const;

/** Projects waiting for approval, for the count next to "Projects" (operatorOverview). */
function usePendingCount(): number | undefined {
  const q = useQuery({
    queryKey: ["op-overview"],
    queryFn: () => api.call("operatorOverview", {}),
    staleTime: 60_000,
  });
  const n = q.data?.pending_approval.value;
  return n ? n : undefined;
}

export function OperatorNav() {
  const pending = usePendingCount();
  return (
    <nav className="um-nav" aria-label="Operator">
      <Group title="Ecosystem">
        <li>
          <NavLink to="/operator/overview" search={DEF} activeOptions={loose} icon="home">
            Overview
          </NavLink>
        </li>
        <li>
          <NavLink to="/operator/web" search={DEF} activeOptions={loose} icon="globe">
            Web
          </NavLink>
        </li>
        <li>
          <NavLink to="/operator/api" search={DEF} activeOptions={loose} icon="server">
            API
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/operator/cohorts"
            search={{ by: "round", range: "90d", min_level: "L1" }}
            activeOptions={loose}
            icon="users"
          >
            Cohorts
          </NavLink>
        </li>
      </Group>
      <Group title="On-chain">
        <li>
          <NavLink
            to="/operator/usage-map"
            search={{
              range: "30d",
              sort: "invocations",
              dir: "desc",
              awarded: false,
              active: false,
            }}
            activeOptions={loose}
            icon="map"
          >
            Usage map
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/operator/protocols"
            search={{ range: "30d", active: false }}
            activeOptions={loose}
            icon="coins"
          >
            Protocols
          </NavLink>
        </li>
      </Group>
      <Group title="Projects">
        <li>
          <NavLink
            to="/operator/tenants"
            search={{ status: "active,suspended,pending", sort: "name" }}
            activeOptions={loose}
            icon="list"
            count={pending}
          >
            Ecosystem projects
          </NavLink>
        </li>
        <li>
          <NavLink to="/operator/onboarding" search={{}} activeOptions={loose} icon="userplus">
            Registry coverage
          </NavLink>
        </li>
        <li>
          <NavLink to="/operator/tombstones" icon="ban">
            Tombstones
          </NavLink>
        </li>
      </Group>
      <Group title="Governance">
        <li>
          <NavLink
            to="/operator/audit"
            search={{ prefix: "" }}
            activeOptions={loose}
            icon="filecheck"
          >
            Audit log
          </NavLink>
        </li>
        <li>
          <NavLink to="/operator/erasure" icon="eraser">
            Erasure requests
          </NavLink>
        </li>
        <li>
          <NavLink to="/operator/api-keys" icon="key">
            API keys
          </NavLink>
        </li>
        <li>
          <NavLink to="/operator/operators" icon="badge">
            Operators
          </NavLink>
        </li>
        <li>
          <NavLink to="/operator/settings" icon="gear">
            Settings
          </NavLink>
        </li>
      </Group>
    </nav>
  );
}
