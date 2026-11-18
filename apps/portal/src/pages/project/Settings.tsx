// SPDX-License-Identifier: Apache-2.0
// Project settings (approved design): tabs Project · Websites · API services · Erasure and removal. Project: name,
// description, on-chain matching, daily seal, limits set by SCF operators (getTenant / updateTenant). Websites:
// visitor counting and consent mode (tracker profile, visitor identifier, countries), reports (path folding,
// anonymous reports, retention), testing origins, opt-out page, domains and the tracker snippet (updateSite,
// setSiteAnonymousReports), and adding a website. API services: the registered services and registering one.
// Erasure and removal live on /erasure with the same tabs. Writes refused for a viewer show the read-only notice.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import {
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  KeyValues,
  LoadingState,
  Note,
  PageHeader,
  Segmented,
  StatusBadge,
  Switch,
  TableScroll,
  Tag,
} from "../../components/ui/index.ts";
import { fmtDay } from "../../lib/format.ts";
import { RegisterService, STREAM_KIND_TEXT } from "../Services.tsx";
import { ProjectFrame, useServiceList, useSites, useTenant } from "./common.tsx";

export type SettingsTab = "project" | "sites" | "services";

export function parseSettingsSearch(s: Record<string, unknown>): {
  tab?: SettingsTab;
  site?: string;
} {
  const out: { tab?: SettingsTab; site?: string } = {};
  if (s.tab === "project" || s.tab === "sites" || s.tab === "services") out.tab = s.tab;
  if (typeof s.site === "string" && /^[0-9a-f-]{36}$/i.test(s.site)) out.site = s.site;
  return out;
}

/** Header and tabs shared by the settings tabs and the erasure pages. */
export function SettingsHeader({
  tenantId,
  current,
}: {
  tenantId: string;
  current: SettingsTab | "danger";
}) {
  const tenant = useTenant(tenantId);
  const cur = (t: string) => (t === current ? { "aria-current": "page" as const } : {});
  return (
    <>
      <PageHeader
        title="Settings"
        sub={tenant.data ? `${tenant.data.name} · ${tenant.data.slug}` : "Project settings"}
      />
      <nav aria-label="Settings sections">
        <ul className="um-tabs">
          <li>
            <Link
              to="/t/$tenantId/settings"
              params={{ tenantId }}
              search={{ tab: "project" }}
              {...cur("project")}
            >
              <Icon name="gear" size="sm" />
              Project
            </Link>
          </li>
          <li>
            <Link
              to="/t/$tenantId/settings"
              params={{ tenantId }}
              search={{ tab: "sites" }}
              {...cur("sites")}
            >
              <Icon name="globe" size="sm" />
              Websites
            </Link>
          </li>
          <li>
            <Link
              to="/t/$tenantId/settings"
              params={{ tenantId }}
              search={{ tab: "services" }}
              {...cur("services")}
            >
              <Icon name="server" size="sm" />
              API services
            </Link>
          </li>
          <li>
            <Link to="/t/$tenantId/erasure" params={{ tenantId }} {...cur("danger")}>
              <Icon name="trash" size="sm" />
              Erasure and removal
            </Link>
          </li>
        </ul>
      </nav>
    </>
  );
}

export function SettingsPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/settings" });
  const search = useSearch({ from: "/app/t/$tenantId/settings" });
  const tab = search.tab ?? "project";
  useTitle("Settings");
  return (
    <ProjectFrame tenantId={tenantId}>
      <SettingsHeader tenantId={tenantId} current={tab} />
      {tab === "project" ? <ProjectTab tenantId={tenantId} /> : null}
      {tab === "sites" ? <SitesTab tenantId={tenantId} siteId={search.site} /> : null}
      {tab === "services" ? <ServicesTab tenantId={tenantId} /> : null}
    </ProjectFrame>
  );
}

// ------------------------------------------------------------------ project

function useTenantUpdate(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ControlPlane.TenantUpdate) =>
      api.call("updateTenant", { path: { tenantId }, body }),
    onSuccess: (t) => {
      qc.setQueryData(["tenant", tenantId], t);
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
}

function SetRow({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="um-p-setrow">
      <div>
        <b>{title}</b>
        <small>{sub}</small>
      </div>
      {children}
    </div>
  );
}

function ProjectTab({ tenantId }: { tenantId: string }) {
  const tenant = useTenant(tenantId);
  const update = useTenantUpdate(tenantId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (tenant.data) {
      setName(tenant.data.name);
      setDescription(tenant.data.description ?? "");
    }
  }, [tenant.data]);
  if (tenant.isPending) return <LoadingState block />;
  if (tenant.error)
    return <ErrorState error={tenant.error} onRetry={() => void tenant.refetch()} />;
  const t = tenant.data;
  const q = t.quotas ?? {};
  return (
    <>
      <Card title="Project">
        <form
          className="um-p-form"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ name: name.trim(), description: description.trim() || null });
          }}
        >
          <div className="um-grid um-g2">
            <Field label="Name">
              <input
                className="um-inp"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Public address" hint="Set when the project was created">
              <input className="um-inp um-inp--mono" readOnly value={`/p/${t.slug}`} />
            </Field>
          </div>
          <Field label="Description">
            <input
              className="um-inp"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" size="sm" disabled={update.isPending}>
              Save
            </Button>
          </div>
        </form>
      </Card>
      <Card>
        <SetRow
          title="Match on-chain activity"
          sub="Compare web and API numbers with your contracts' ledger activity"
        >
          <Switch
            label="Match on-chain activity"
            checked={t.onchain_correlation_enabled}
            disabled={update.isPending}
            onChange={(v) => update.mutate({ onchain_correlation_enabled: v })}
          />
        </SetRow>
        <SetRow title="Daily seal" sub="Anchor each day's totals so snapshots can't change later">
          <Switch
            label="Daily seal"
            checked={t.seal_enabled === true}
            disabled={update.isPending}
            onChange={(v) => update.mutate({ seal_enabled: v })}
          />
        </SetRow>
      </Card>
      <ProblemAlert error={update.error} />
      <Card
        title="Limits"
        sub="Set by SCF operators"
        headingLevel={3}
        actions={<StatusBadge status="off">Read-only</StatusBadge>}
      >
        <KeyValues
          items={[
            { k: "Status", v: t.status },
            { k: "Verification level", v: t.verification_level },
            { k: "Websites", v: q.max_sites === undefined ? "—" : `up to ${q.max_sites}` },
            {
              k: "API services",
              v: q.max_services === undefined ? "—" : `up to ${q.max_services}`,
            },
            {
              k: "Web events per day",
              v:
                q.web_events_per_day === undefined
                  ? "—"
                  : q.web_events_per_day.toLocaleString("en-US"),
            },
            {
              k: "API routes per day",
              v: q.routes_per_day === undefined ? "—" : q.routes_per_day.toLocaleString("en-US"),
            },
            { k: "Created", v: fmtDay(t.created_at) },
          ]}
        />
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ websites

function SitesTab({ tenantId, siteId }: { tenantId: string; siteId: string | undefined }) {
  const sites = useSites(tenantId);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  if (sites.isPending) return <LoadingState block />;
  if (sites.error) return <ErrorState error={sites.error} onRetry={() => void sites.refetch()} />;
  const site = sites.data.find((s) => s.site_id === siteId) ?? sites.data[0];
  return (
    <>
      <div className="um-p-tools">
        {sites.data.length > 1 && site ? (
          <Segmented
            label="Website"
            value={site.site_id}
            onChange={(v) =>
              void navigate({
                to: "/t/$tenantId/settings",
                params: { tenantId },
                search: { tab: "sites", site: v },
                replace: true,
              })
            }
            options={sites.data.map((s) => ({
              value: s.site_id,
              label: s.domains?.[0]?.host ?? s.name,
              icon: "globe" as const,
            }))}
          />
        ) : null}
        <Button size="sm" icon="plus" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          New website
        </Button>
      </div>
      {adding ? <CreateSite tenantId={tenantId} /> : null}
      {!site ? (
        <EmptyState title="No website yet" icon="globe">
          Add your website to get a snippet with your site key.
        </EmptyState>
      ) : (
        <SiteSettingsCards key={site.site_id} tenantId={tenantId} site={site} />
      )}
    </>
  );
}

function SiteSettingsCards({ tenantId, site }: { tenantId: string; site: ControlPlane.Site }) {
  const qc = useQueryClient();
  const path = { tenantId, siteId: site.site_id };
  const update = useMutation({
    mutationFn: (body: ControlPlane.SiteUpdate) => api.call("updateSite", { path, body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sites", tenantId] });
      void qc.invalidateQueries({ queryKey: ["site", tenantId, site.site_id] });
    },
  });
  const anon = useMutation({
    mutationFn: (enabled: boolean) =>
      api.call("setSiteAnonymousReports", { path, body: { anonymous_reports: enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sites", tenantId] }),
  });
  const [countries, setCountries] = useState((site.visitor_id_off_countries ?? []).join(", "));
  const [optOut, setOptOut] = useState(site.opt_out_page_url ?? "");
  const [retention, setRetention] = useState(
    site.event_retention_days ? String(site.event_retention_days) : "",
  );
  const busy = update.isPending || anon.isPending;
  const vid = site.visitor_id;
  return (
    <>
      <ProblemAlert error={update.error ?? anon.error} />
      <section className="um-grid um-g2">
        <Card
          title="Domains"
          headingLevel={3}
          actions={
            <Link
              to="/t/$tenantId/sites/$siteId/settings"
              params={path}
              className={buttonClass("ghost", { size: "sm" })}
            >
              <Icon name="plus" />
              Manage
            </Link>
          }
        >
          {(site.domains ?? []).length === 0 ? (
            <EmptyState plain title="No domain yet">
              Add your production domain and prove it with a DNS record, a file or a meta tag.
            </EmptyState>
          ) : (
            <ul className="um-p-keyrows">
              {(site.domains ?? []).map((d) => (
                <li key={d.domain_id}>
                  <div>
                    <b>{d.host}</b>
                  </div>
                  <StatusBadge status={d.state === "verified" ? "live" : "set"}>
                    {d.state === "verified" ? "Verified" : "Not verified yet"}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Testing"
          sub="Events from these origins show in the first-event panel and are never counted"
          headingLevel={3}
        >
          {(site.dev_origins ?? []).length === 0 ? (
            <p className="um-muted">No dev origins yet.</p>
          ) : (
            <p className="um-p-cc">
              {(site.dev_origins ?? []).map((o) => (
                <Tag key={o}>{o}</Tag>
              ))}
            </p>
          )}
          <p className="um-p-fine">
            Add or remove origins and switch debug mode in the first-event panel of{" "}
            <Link
              className="um-link"
              to="/t/$tenantId/integrations"
              params={{ tenantId }}
              search={{}}
            >
              Integrations
            </Link>
            .
          </p>
        </Card>
      </section>

      <Card
        title="Visitor counting"
        sub={`How unique visitors are counted on ${site.domains?.[0]?.host ?? site.name}`}
      >
        <div className="um-p-opts" role="radiogroup" aria-label="Visitor counting">
          {(
            [
              ["on", "On everywhere", "Daily salted hash, no cookies. Visitors can still opt out."],
              [
                "off_in",
                "Off in some countries",
                "No visitor ID where you choose. Page views are still counted.",
              ],
              ["off", "Off", "Page views and visits only. Unique visitors show as not available."],
            ] as const
          ).map(([v, t, d]) => (
            // biome-ignore lint/a11y/useSemanticElements: a card-sized radio with a title, a description and an icon
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={vid === v}
              className="um-p-opt"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  v === "off_in"
                    ? {
                        visitor_id: v,
                        visitor_id_off_countries: countries
                          .split(/[\s,]+/)
                          .map((c) => c.trim().toUpperCase())
                          .filter(Boolean),
                      }
                    : { visitor_id: v },
                )
              }
            >
              <span className="um-p-rd" aria-hidden="true" />
              <span>
                <b>{t}</b>
                <small>{d}</small>
              </span>
            </button>
          ))}
        </div>
        {vid === "off_in" ? (
          <form
            className="um-p-inlineform"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({
                visitor_id: "off_in",
                visitor_id_off_countries: countries
                  .split(/[\s,]+/)
                  .map((c) => c.trim().toUpperCase())
                  .filter(Boolean),
              });
            }}
          >
            <Field label="Countries without a visitor ID" hint="Two-letter codes, e.g. DE, AT, FR">
              <input
                className="um-inp um-inp--mono"
                value={countries}
                onChange={(e) => setCountries(e.target.value)}
              />
            </Field>
            <Button type="submit" size="sm" disabled={busy}>
              Save countries
            </Button>
          </form>
        ) : null}
      </Card>

      <section className="um-grid um-g2">
        <Card
          title="Consent mode"
          sub="Strict sends fewer fields and needs no consent banner in more places"
          headingLevel={3}
        >
          <Segmented
            label="Consent mode"
            value={site.tracker_profile}
            onChange={(v) => {
              if (!busy) update.mutate({ tracker_profile: v });
            }}
            options={[
              { value: "standard", label: "Standard" },
              { value: "strict", label: "Strict" },
            ]}
          />
          <p className="um-p-fine">
            {site.tracker_profile === "standard"
              ? "Standard: the full metric set (referrer host, screen-width class, language)."
              : "Strict: page path only, no referrer, screen or language."}
          </p>
        </Card>
        <Card
          title="Small numbers"
          sub="Round to 10 and merge rows below 10 into Other"
          headingLevel={3}
        >
          <SetRow title="Anonymous reports" sub="Totals stay exact">
            <Switch
              label="Anonymous reports"
              checked={site.anonymous_reports}
              disabled={busy}
              onChange={(v) => anon.mutate(v)}
            />
          </SetRow>
          <SetRow title="Fold similar paths" sub="/pools/abc and /pools/xyz count as /pools/{id}">
            <Switch
              label="Fold similar paths"
              checked={site.path_folding === "full"}
              disabled={busy}
              onChange={(v) => update.mutate({ path_folding: v ? "full" : "relaxed" })}
            />
          </SetRow>
        </Card>
      </section>

      <Card title="Never stored, whatever you choose" headingLevel={3}>
        <p className="um-p-nochips">
          {[
            "IP addresses",
            "Cookies",
            "Query strings",
            "Page titles",
            "Wallet addresses",
            "User-agent strings",
          ].map((x) => (
            <span key={x}>{x}</span>
          ))}
        </p>
        <form
          className="um-p-inlineform"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({
              opt_out_page_url: optOut.trim() || null,
              event_retention_days: retention.trim() ? Number(retention) : null,
            });
          }}
        >
          <Field label="Opt-out page">
            <input
              className="um-inp um-inp--mono"
              type="url"
              placeholder="https://example.org/privacy#analytics"
              value={optOut}
              onChange={(e) => setOptOut(e.target.value)}
            />
          </Field>
          <Field
            label="Keep raw events for (days)"
            hint={`Platform default: ${site.effective_event_retention_days} days. Shorter only.`}
          >
            <input
              className="um-inp"
              type="number"
              min={1}
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
            />
          </Field>
          <Button type="submit" size="sm" disabled={busy}>
            Save
          </Button>
        </form>
      </Card>

      <Card
        title="Tracker"
        sub="Pinned version with an integrity hash"
        headingLevel={3}
        actions={
          <Link
            to="/t/$tenantId/sites/$siteId/snippet"
            params={path}
            search={{ format: "html" }}
            className={buttonClass("secondary", { size: "sm" })}
          >
            <Icon name="code" />
            Get the snippet
          </Link>
        }
      >
        <KeyValues
          items={[
            { k: "Site key", v: <code>{site.site_key}</code> },
            {
              k: "Rate limit",
              v: `${site.limits.rate_limit_per_min.toLocaleString("en-US")} events per minute`,
            },
            {
              k: "Daily quota",
              v:
                site.limits.daily_quota === null
                  ? "No daily quota"
                  : `${site.limits.verified_events_today.toLocaleString("en-US")} of ${site.limits.daily_quota.toLocaleString("en-US")} verified events today`,
            },
          ]}
        />
      </Card>
    </>
  );
}

/** Add a website: name, consent mode and visitor identifier (C-02, C-53). */
export function CreateSite({
  tenantId,
  onCreated,
}: {
  tenantId: string;
  onCreated?: (site: ControlPlane.Site) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<"standard" | "strict">("standard");
  const [visitorId, setVisitorId] = useState<"on" | "off">("on");
  const create = useMutation({
    mutationFn: () =>
      api.call("createSite", {
        path: { tenantId },
        body: { name: name.trim(), tracker_profile: profile, visitor_id: visitorId },
      }),
    onSuccess: async (site) => {
      await qc.invalidateQueries({ queryKey: ["sites", tenantId] });
      if (onCreated) return onCreated(site);
      void navigate({
        to: "/t/$tenantId/sites/$siteId/snippet",
        params: { tenantId, siteId: site.site_id },
        search: { format: "html" },
      });
    },
  });
  return (
    <Card title="Add a website">
      <form
        className="um-p-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Website name">
          <input
            className="um-inp"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <fieldset className="um-p-fieldset">
          <legend>Tracker profile</legend>
          {(
            [
              ["standard", PROFILE_TEXT.standard],
              ["strict", PROFILE_TEXT.strict],
            ] as const
          ).map(([p, t]) => (
            <label key={p} className="um-p-check">
              <input
                type="radio"
                name={`profile-${tenantId}`}
                checked={profile === p}
                onChange={() => {
                  setProfile(p);
                  setVisitorId(p === "strict" ? "off" : "on");
                }}
              />
              {t}
            </label>
          ))}
        </fieldset>
        <fieldset className="um-p-fieldset">
          <legend>Visitor identifier</legend>
          <label className="um-p-check">
            <input
              type="radio"
              name={`vid-${tenantId}`}
              checked={visitorId === "on"}
              onChange={() => setVisitorId("on")}
            />
            On — unique visitors, visits, bounce rate and visit duration are computed (per UTC day).
          </label>
          <label className="um-p-check">
            <input
              type="radio"
              name={`vid-${tenantId}`}
              checked={visitorId === "off"}
              onChange={() => setVisitorId("off")}
            />
            Off — page views, countries and devices only.
          </label>
        </fieldset>
        <ProblemAlert error={create.error} />
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
            Add website
          </Button>
        </div>
      </form>
    </Card>
  );
}

export const PROFILE_TEXT = {
  standard:
    "standard — the full metric set (referrer host, screen-width class, language); built to the French, Spanish and Italian audience-measurement criteria; visitor identifier on by default.",
  strict:
    "strict — as close to a counter as possible: page path only, no referrer, screen or language; visitor identifier off by default.",
} as const;

// ------------------------------------------------------------------ API services

function ServicesTab({ tenantId }: { tenantId: string }) {
  const services = useServiceList(tenantId);
  const navigate = useNavigate();
  return (
    <>
      <Card
        title="API services"
        sub="Each service sends its own metrics with an ingest token"
        flush
      >
        {services.isPending ? (
          <LoadingState />
        ) : services.error ? (
          <ErrorState error={services.error} plain onRetry={() => void services.refetch()} />
        ) : services.data.length === 0 ? (
          <EmptyState plain title="No API service yet" icon="server">
            Register one below, or let it register itself with its first data point.
          </EmptyState>
        ) : (
          <TableScroll label="API services">
            <table className="um-table">
              <caption className="um-sr">API services</caption>
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Base URL</th>
                  <th scope="col">Stream</th>
                  <th scope="col" className="um-r">
                    Objective
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="um-sr">Links</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {services.data.map((s) => (
                  <tr key={s.service_id}>
                    <td>
                      <Link
                        className="um-link"
                        to="/t/$tenantId/services/$serviceId"
                        params={{ tenantId, serviceId: s.service_id }}
                        search={{ range: "7d", compare: false, sort: "-requests" }}
                      >
                        {s.display_name ?? s.service_name}
                      </Link>
                      {s.display_name ? (
                        <>
                          {" "}
                          <code className="um-muted">{s.service_name}</code>
                        </>
                      ) : null}
                    </td>
                    <td>{s.declared_base_url ? <code>{s.declared_base_url}</code> : "—"}</td>
                    <td>
                      {(s.stream_groups ?? []).length === 0
                        ? "no data yet"
                        : (s.stream_groups ?? []).map((g) => (
                            <Tag key={`${g.kind}${g.metric_name}`}>
                              {STREAM_KIND_TEXT[g.kind] ?? g.kind}
                            </Tag>
                          ))}
                      {s.multiple_groups_warning ? (
                        <span data-testid={`multi-${s.service_name}`}>
                          {" "}
                          <StatusBadge status="wait">more than one stream group</StatusBadge>
                        </span>
                      ) : null}
                    </td>
                    <td className="um-r">{s.slo_target_pct ?? 99.5}%</td>
                    <td>
                      <StatusBadge status={s.status === "active" ? "live" : "off"}>
                        {s.status === "active" ? "Active" : "Archived"}
                      </StatusBadge>
                      {s.registration === "auto" ? <Tag>auto-registered</Tag> : null}
                    </td>
                    <td>
                      <Link
                        className="um-link"
                        to="/t/$tenantId/services/$serviceId/setup"
                        params={{ tenantId, serviceId: s.service_id }}
                        search={{ stack: "node" }}
                      >
                        Set-up<span className="um-sr"> for {s.service_name}</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>
      <Note>
        “More than one stream group” means the service sends request data in two ways (for example
        SDK metrics and spans). One of them is counted per day — the SDK metric when it is there —
        so nothing is counted twice.
      </Note>
      <RegisterService
        tenantId={tenantId}
        onCreated={(s) =>
          void navigate({
            to: "/t/$tenantId/services/$serviceId/setup",
            params: { tenantId, serviceId: s.service_id },
            search: { stack: "node" },
          })
        }
      />
    </>
  );
}
