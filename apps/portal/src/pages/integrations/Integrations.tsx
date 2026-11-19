// SPDX-License-Identifier: Apache-2.0
// The Integrations page (integration plan I1.0): every integration follows the same four steps —
//   1. pick it from the catalogue (filtered by kind and stack; recommended ones first),
//   2. copy the generated configuration (the project's public site key and service name filled in; ingest tokens
//      stay placeholders or are read from $SCF_OTLP_TOKEN — they are shown once at creation and never here),
//   3. run the test command (web: one page view from the dev origin localhost; OTLP: one cumulative baseline point
//      from a fresh process id — neither is ever counted),
//   4. watch it arrive: the live first-event panel for web cards (FirstEventPanel, polling every 5 s), the
//      service's baseline-point counter for API cards and the website's stale app-event drops for app cards
//      (getIntegrationStatus, polling every 5 s), the public-stats switch for badges.
// Status per card comes from the control plane (listIntegrations / getIntegrationStatus) and is per website or
// service: UsageMap cannot tell which of two integrations of one website sent an event, and says so.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { CopyButton } from "../../components/CopyButton.tsx";
import { FIRST_EVENT_POLL_MS, FirstEventPanel } from "../../components/FirstEventPanel.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  StatusBadge as KitStatus,
  LoadingState,
  Note,
  PageHeader,
  type StatusKind,
  Steps,
  Tag,
  type Tone,
} from "../../components/ui/index.ts";
import { fmtDayTime } from "../../lib/format.ts";
import { ProjectFrame } from "../project/common.tsx";
import {
  AVAILABILITY_TEXT,
  appTestArrived,
  GROUPS,
  type Integration,
  type IntegrationsSearch,
  LIVE_POLL_MS,
  matches,
  needsLocalhost,
  ordered,
  otlpTestArrived,
  STATUS_TEXT,
  webTestArrived,
} from "./model.ts";

const FROM = "/app/t/$tenantId/integrations";
type Block = ControlPlane.IntegrationBlock;
type StatusReport = ControlPlane.IntegrationStatusReport;

function CodeBlock({ b, testId }: { b: Block; testId?: string | undefined }) {
  return (
    <div className="um-codeblock">
      <div className="um-codeblock-h">
        <span>{b.filename && b.filename !== b.title ? `${b.title} · ${b.filename}` : b.title}</span>
        <CopyButton text={b.code} />
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a wide code block scrolls sideways; keyboard users must reach it */}
      <pre data-testid={testId} data-language={b.language} tabIndex={0}>
        <code>{b.code}</code>
      </pre>
    </div>
  );
}

const STATUS_KIND: Record<ControlPlane.IntegrationStatus, StatusKind> = {
  not_started: "off",
  configured: "set",
  test_received: "wait",
  live_data_seen: "live",
  not_observable: "off",
};

function StatusBadge({ status }: { status: ControlPlane.IntegrationStatus }) {
  return (
    <span data-testid="integration-status" className="um-p-igst">
      <KitStatus status={STATUS_KIND[status]}>{STATUS_TEXT[status]}</KitStatus>
    </span>
  );
}

function useStatuses(
  tenantId: string,
  siteId: string | undefined,
  serviceId: string | undefined,
  live: boolean,
) {
  return useQuery({
    queryKey: ["integration-status", tenantId, siteId ?? null, serviceId ?? null],
    queryFn: () =>
      api.call("getIntegrationStatus", {
        path: { tenantId },
        query: {
          ...(siteId ? { site_id: siteId } : {}),
          ...(serviceId ? { service_id: serviceId } : {}),
        },
      }),
    refetchInterval: live ? LIVE_POLL_MS : 30_000,
  });
}

// ------------------------------------------------------------------------------------------------ step 4

/** Once a test has arrived, the catalogue's statuses are refreshed at once (not at the next poll). */
function useRefreshOnArrival(tenantId: string, arrived: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (arrived) void qc.invalidateQueries({ queryKey: ["integration-status", tenantId] });
  }, [arrived, qc, tenantId]);
}

function WebLiveCheck({
  tenantId,
  site,
  onLive,
}: {
  tenantId: string;
  site: ControlPlane.Site;
  onLive: (on: boolean) => void;
}) {
  const [since, setSince] = useState<number | null>(null);
  // the same query FirstEventPanel polls: one request every 5 s serves both
  const dev = useQuery({
    queryKey: ["dev-events", tenantId, site.site_id],
    queryFn: () => api.call("listSiteDevEvents", { path: { tenantId, siteId: site.site_id } }),
    refetchInterval: FIRST_EVENT_POLL_MS,
  });
  const arrived = since !== null ? webTestArrived(dev.data?.events ?? [], since) : null;
  useRefreshOnArrival(tenantId, arrived !== null);
  return (
    <div className="um-p-stack um-p-gap10">
      {since === null ? (
        <div className="um-p-tools">
          <button
            className="um-btn um-btn--primary um-btn--sm"
            type="button"
            onClick={() => {
              setSince(Date.now());
              onLive(true);
            }}
          >
            Start live check
          </button>
          <span className="um-p-fine">Start it, then run the test command.</span>
        </div>
      ) : arrived ? (
        <p className="um-note um-note--good" role="status" data-testid="live-arrived">
          Test received at {fmtDayTime(arrived.received_at)}: {arrived.event_name} on{" "}
          <code>{arrived.path}</code> — never counted.
        </p>
      ) : (
        <p className="um-note um-p-wait" role="status" data-testid="live-waiting">
          Waiting for the test to arrive (checked every few seconds)…
        </p>
      )}
      <FirstEventPanel tenantId={tenantId} site={site} />
    </div>
  );
}

function OtlpLiveCheck({
  tenantId,
  status,
  serviceId,
  onLive,
}: {
  tenantId: string;
  status: StatusReport | undefined;
  serviceId: string;
  onLive: (on: boolean) => void;
}) {
  const [baseline, setBaseline] = useState<number | null>(null);
  const current = status?.signals.service?.baseline_points_2d;
  const arrived = otlpTestArrived(baseline, current);
  useRefreshOnArrival(tenantId, arrived);
  return (
    <div className="um-p-stack um-p-gap10">
      {baseline === null ? (
        <div className="um-p-tools">
          <button
            className="um-btn um-btn--primary um-btn--sm"
            type="button"
            disabled={current === undefined}
            onClick={() => {
              setBaseline(current ?? 0);
              onLive(true);
            }}
          >
            Start live check
          </button>
          <span className="um-p-fine">Start it, then run the test command.</span>
        </div>
      ) : arrived ? (
        <p className="um-note um-note--good" role="status" data-testid="live-arrived">
          Test point received for {status?.signals.service?.service_name}: kept as a baseline only,
          never counted. The data-quality table of the service lists it as a baseline point.
        </p>
      ) : (
        <p className="um-note um-p-wait" role="status" data-testid="live-waiting">
          Waiting for the test point (checked every few seconds; the Collector and writer usually
          take under a minute)…
        </p>
      )}
      <p className="um-p-fine">
        Baseline points for this service today and yesterday:{" "}
        <strong data-testid="baseline-count">{current ?? "…"}</strong>
        {baseline !== null ? ` (was ${baseline} when the check started)` : null}.{" "}
        <Link
          to="/t/$tenantId/services/$serviceId"
          params={{ tenantId, serviceId }}
          search={{ range: "24h", compare: false, sort: "-requests" }}
        >
          Open the API dashboard
        </Link>
      </p>
    </div>
  );
}

function AppLiveCheck({
  tenantId,
  status,
  onLive,
}: {
  tenantId: string;
  status: StatusReport | undefined;
  onLive: (on: boolean) => void;
}) {
  const [baseline, setBaseline] = useState<number | null>(null);
  const current = status?.signals.site?.app_stale_drops_2d;
  const arrived = appTestArrived(baseline, current);
  useRefreshOnArrival(tenantId, arrived);
  return (
    <div className="um-p-stack um-p-gap10">
      {baseline === null ? (
        <div className="um-p-tools">
          <button
            className="um-btn um-btn--primary um-btn--sm"
            type="button"
            disabled={current === undefined}
            onClick={() => {
              setBaseline(current ?? 0);
              onLive(true);
            }}
          >
            Start live check
          </button>
          <span className="um-p-fine">Start it, then run the test command.</span>
        </div>
      ) : arrived ? (
        <p className="um-note um-note--good" role="status" data-testid="live-arrived">
          Test app event received: dropped as stale, as intended — never counted as an event or a
          session.
        </p>
      ) : (
        <p className="um-note um-p-wait" role="status" data-testid="live-waiting">
          Waiting for the test app event (checked every few seconds; the edge reports once a
          minute)…
        </p>
      )}
      <p className="um-p-fine">
        Stale app events of this website today and yesterday:{" "}
        <strong data-testid="app-stale-count">{current ?? "…"}</strong>
        {baseline !== null ? ` (was ${baseline} when the check started)` : null}.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the card detail

const GROUP_LOOK: Record<string, { icon: IconName; tone: Tone }> = {
  web: { icon: "globe", tone: "web" },
  wallets: { icon: "wallet", tone: "wallet" },
  api: { icon: "server", tone: "api" },
  mobile: { icon: "phone", tone: "neutral" },
  onchain: { icon: "layers", tone: "chain" },
  tooling: { icon: "term", tone: "neutral" },
};
const STEP_NAMES = ["Pick", "Configure", "Test", "See it arrive"];
const stepOf = (s: ControlPlane.IntegrationStatus): number =>
  s === "live_data_seen" ? 5 : s === "test_received" ? 4 : s === "configured" ? 3 : 2;

function CardDetail({
  tenantId,
  card,
  site,
  serviceId,
  status,
  onLive,
  onClose,
}: {
  tenantId: string;
  card: Integration;
  site: ControlPlane.Site | undefined;
  serviceId: string | undefined;
  status: StatusReport | undefined;
  onLive: (on: boolean) => void;
  onClose: () => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const closeRef = useRef<HTMLButtonElement>(null);
  const addLocalhost = useMutation({
    mutationFn: (s: ControlPlane.Site) =>
      api.call("updateSite", {
        path: { tenantId, siteId: s.site_id },
        body: { dev_origins: [...(s.dev_origins ?? []), "localhost"] },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sites", tenantId] });
      await qc.invalidateQueries({ queryKey: ["integrations", tenantId] });
      await qc.invalidateQueries({ queryKey: ["dev-events", tenantId] });
    },
  });
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const t = card.test;
  const webTest = t.kind === "web_dev_event" || t.kind === "browser";
  const look = GROUP_LOOK[card.group] ?? { icon: "plug" as IconName, tone: "neutral" as Tone };
  const target =
    card.group === "api"
      ? `Service: ${status?.signals.service?.service_name ?? "—"}`
      : site
        ? `Website: ${site.name}`
        : null;
  return (
    <>
      <button
        type="button"
        className="um-p-scrim"
        tabIndex={-1}
        aria-label="Close"
        onClick={onClose}
      />
      <aside
        className="um-p-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-h`}
        data-testid="integration-detail"
      >
        <div className="um-p-dr-h">
          <span className={`um-tile um-tile--lg um-tone-${look.tone}`}>
            <Icon name={look.icon} />
          </span>
          <div className="um-p-dr-t">
            <h2 id={`${id}-h`} className="um-h2">
              {card.title}
            </h2>
            <small>
              {GROUPS.find((g) => g.id === card.group)?.label} ·{" "}
              <span>{AVAILABILITY_TEXT[card.availability]}</span>
              {card.example_path ? (
                <span data-testid="integration-example">
                  {" "}
                  · Example app: <code>{card.example_path}</code>
                </span>
              ) : null}
            </small>
          </div>
          <StatusBadge status={card.status} />
          <button
            ref={closeRef}
            type="button"
            className="um-btn um-btn--ghost um-btn--sm"
            onClick={onClose}
          >
            <Icon name="x" />
            <span className="um-sr">Close</span>
          </button>
        </div>
        <div className="um-p-dr-b">
          <Steps
            items={STEP_NAMES}
            current={stepOf(card.status)}
            allDone={card.status === "live_data_seen"}
            label="Set-up steps"
          />
          <section className="um-p-step" aria-labelledby={`${id}-s1`}>
            <h3 id={`${id}-s1`} className="um-h3">
              1 · Pick
            </h3>
            <p>{card.summary}</p>
            {card.availability_note ? (
              <Note>
                <p>{card.availability_note}</p>
              </Note>
            ) : null}
            <div className="um-grid um-g2">
              <div className="um-p-box">
                <span className="um-label">What it measures</span>
                <ul className="um-p-mlist">
                  {card.measures.map((m) => (
                    <li key={m}>
                      <Icon name="check" size="sm" />
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="um-p-box">
                <span className="um-label">What it never sends</span>
                <ul className="um-p-mlist um-p-mlist--no">
                  {card.privacy.map((m) => (
                    <li key={m}>
                      <Icon name="x" size="sm" />
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {target ? <p className="um-p-fine">Sends to · {target}</p> : null}
          </section>
          <section className="um-p-step" aria-labelledby={`${id}-s2`}>
            <h3 id={`${id}-s2`} className="um-h3">
              2 · Configure
            </h3>
            {card.needs ? (
              <Note tone="warn">
                <p role="status" data-testid="integration-needs">
                  {card.needs}
                </p>
              </Note>
            ) : card.setup.length === 0 ? (
              <p>Nothing to copy: this step happens in the portal.</p>
            ) : (
              <>
                <p className="um-p-fine">
                  Generated for this project. Your site key is already filled in.
                </p>
                {card.setup.map((b) => (
                  <CodeBlock
                    key={`${b.title}|${b.filename ?? ""}`}
                    b={b}
                    testId={b === card.setup[0] ? "setup-0" : undefined}
                  />
                ))}
              </>
            )}
            {card.guide_path ? (
              <p className="um-p-fine">
                Guide: <code>{card.guide_path}</code>
              </p>
            ) : null}
          </section>
          <section className="um-p-step" aria-labelledby={`${id}-s3`}>
            <h3 id={`${id}-s3`} className="um-h3">
              3 · Test
            </h3>
            {t.instructions ? <p>{t.instructions}</p> : null}
            {t.requires.length > 0 ? (
              <ul className="um-p-mlist">
                {t.requires.map((r) => (
                  <li key={r}>
                    <Icon name="check" size="sm" />
                    <span>Needs: {r}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {webTest && site && needsLocalhost(site.dev_origins ?? []) ? (
              <div className="um-p-tools">
                <Button
                  size="sm"
                  onClick={() => addLocalhost.mutate(site)}
                  disabled={addLocalhost.isPending}
                >
                  Add localhost as a dev origin
                </Button>
                <ProblemAlert error={addLocalhost.error} />
              </div>
            ) : webTest && site ? (
              <p className="um-p-fine" data-testid="localhost-ok">
                <code>localhost</code> is a dev origin of {site.name}.
              </p>
            ) : null}
            {t.command ? <CodeBlock b={t.command} testId="test-command" /> : null}
            {t.expect.length > 0 ? (
              <>
                <span className="um-label">You should see</span>
                <ul className="um-p-mlist">
                  {t.expect.map((e) => (
                    <li key={e}>
                      <Icon name="arrow" size="sm" />
                      <span>{e}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
          <section className="um-p-step" aria-labelledby={`${id}-s4`}>
            <h3 id={`${id}-s4`} className="um-h3">
              4 · See it arrive
            </h3>
            {card.live_check === "dev_events" && site ? (
              <WebLiveCheck tenantId={tenantId} site={site} onLive={onLive} />
            ) : card.live_check === "otlp_baseline" && serviceId ? (
              <OtlpLiveCheck
                tenantId={tenantId}
                status={status}
                serviceId={serviceId}
                onLive={onLive}
              />
            ) : card.live_check === "app_events" && site ? (
              <AppLiveCheck tenantId={tenantId} status={status} onLive={onLive} />
            ) : card.live_check === "public_badge" ? (
              <p>
                <Link
                  className="um-link"
                  to="/t/$tenantId/sharing"
                  params={{ tenantId }}
                  search={{ tab: "badges" }}
                >
                  Open Sharing
                </Link>{" "}
                — {card.status_detail}
              </p>
            ) : card.live_check === "footprint" ? (
              <p>
                <Link className="um-link" to="/t/$tenantId/footprint" params={{ tenantId }}>
                  Open the footprint
                </Link>{" "}
                — {card.status_detail}
              </p>
            ) : card.live_check === "none" ? (
              <p>This tool runs on your machine; there is nothing to see arrive.</p>
            ) : (
              <Note tone="warn">
                <p>{card.needs ?? "Complete the configuration first."}</p>
              </Note>
            )}
          </section>
        </div>
        <div className="um-p-dr-f">
          <Button variant="ghost" icon="back" onClick={onClose}>
            Back to all integrations
          </Button>
        </div>
      </aside>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ the page

export function IntegrationsPage() {
  const { tenantId } = useParams({ from: FROM });
  const search = useSearch({ from: FROM });
  const navigate = useNavigate();
  const [live, setLive] = useState(false);
  useTitle("Integrations");
  const go = (patch: { [K in keyof IntegrationsSearch]?: IntegrationsSearch[K] | undefined }) =>
    void navigate({
      to: "/t/$tenantId/integrations",
      params: { tenantId },
      search: (prev: IntegrationsSearch) => {
        const merged: Record<string, unknown> = { ...prev, ...patch };
        for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
        return merged as IntegrationsSearch;
      },
      replace: true,
    });
  const sites = useQuery({
    queryKey: ["sites", tenantId],
    queryFn: () => api.call("listSites", { path: { tenantId } }),
  });
  const services = useQuery({
    queryKey: ["services", tenantId],
    queryFn: () => api.call("listServices", { path: { tenantId } }),
  });
  const cat = useQuery({
    queryKey: ["integrations", tenantId, search.site ?? null, search.service ?? null],
    queryFn: () =>
      api.call("listIntegrations", {
        path: { tenantId },
        query: {
          ...(search.site ? { site_id: search.site } : {}),
          ...(search.service ? { service_id: search.service } : {}),
        },
      }),
  });
  const siteId = cat.data?.site?.site_id;
  const serviceId = cat.data?.service?.service_id;
  const status = useStatuses(tenantId, siteId, serviceId, live);
  const statusOf = new Map((status.data?.statuses ?? []).map((s) => [s.id, s]));
  const all = (cat.data?.integrations ?? []).map((c) => {
    const s = statusOf.get(c.id);
    return s ? { ...c, status: s.status, status_detail: s.detail } : c;
  });
  const cards = ordered(
    all
      .filter((c) => !search.group || c.group === search.group)
      .filter((c) => matches(c, search.q)),
  );
  const selected = all.find((c) => c.id === search.card);
  const site = (sites.data ?? []).find((s) => s.site_id === siteId);
  const count = (st: ControlPlane.IntegrationStatus) => all.filter((c) => c.status === st).length;
  const close = () => {
    setLive(false);
    go({ card: undefined });
  };
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader
        title="Integrations"
        sub="Pick what you use. Each one gives you a ready config, a test you can run, and shows the first event as it arrives. Test events are never counted."
      />
      {cat.error || sites.error || services.error ? (
        <ErrorState
          error={cat.error ?? sites.error ?? services.error}
          onRetry={() => void cat.refetch()}
        />
      ) : null}
      <form
        className="um-p-filters"
        aria-label="Integration filters"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="um-p-search">
          <Icon name="search" size="sm" />
          <span className="um-sr">Stack or name</span>
          <input
            type="search"
            value={search.q ?? ""}
            placeholder={`Search ${all.length || ""} integrations: nextjs, python, workers…`}
            onChange={(e) => go({ q: e.target.value || undefined })}
          />
        </label>
        <label className="um-p-inline">
          <span>Kind</span>
          <select
            className="um-inp"
            value={search.group ?? ""}
            onChange={(e) =>
              go({ group: (e.target.value || undefined) as IntegrationsSearch["group"] })
            }
          >
            <option value="">All</option>
            {GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="um-p-inline">
          <span>Website</span>
          <select
            className="um-inp"
            value={siteId ?? ""}
            onChange={(e) => go({ site: e.target.value || undefined, card: search.card })}
          >
            {(sites.data ?? []).length === 0 ? <option value="">No website yet</option> : null}
            {(sites.data ?? []).map((s) => (
              <option key={s.site_id} value={s.site_id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="um-p-inline">
          <span>API service</span>
          <select
            className="um-inp"
            value={serviceId ?? ""}
            onChange={(e) => go({ service: e.target.value || undefined })}
          >
            {(services.data ?? []).length === 0 ? <option value="">No service yet</option> : null}
            {(services.data ?? []).map((s) => (
              <option key={s.service_id} value={s.service_id}>
                {s.service_name}
              </option>
            ))}
          </select>
        </label>
        {cat.data ? (
          <p className="um-p-igsum">
            <KitStatus status="live">Live</KitStatus> <b>{count("live_data_seen")}</b>
            <KitStatus status="wait">Test received</KitStatus> <b>{count("test_received")}</b>
            <KitStatus status="set">Configured</KitStatus> <b>{count("configured")}</b>
          </p>
        ) : null}
      </form>
      <p className="um-p-fine">
        Status is per website and per API service: when two integrations feed the same website, both
        show the status of that website.
      </p>
      {cat.isPending ? (
        <LoadingState block label="Loading the catalogue…" />
      ) : cards.length === 0 ? (
        <EmptyState title="No integration matches these filters" icon="search">
          Try “wallet”, “python” or “badge”.
        </EmptyState>
      ) : (
        <div className="um-p-iggroups" data-testid="integrations">
          {GROUPS.filter((g) => cards.some((c) => c.group === g.id)).map((g) => {
            const items = cards.filter((c) => c.group === g.id);
            const look = GROUP_LOOK[g.id] ?? { icon: "plug" as IconName, tone: "neutral" as Tone };
            return (
              <section key={g.id} className="um-p-igg" aria-labelledby={`ig-${g.id}`}>
                <h2 className="um-p-igh" id={`ig-${g.id}`}>
                  <span className={`um-tile um-tile--sm um-tone-${look.tone}`}>
                    <Icon name={look.icon} size="sm" />
                  </span>
                  {g.label}
                  <span className="um-p-cnt">{items.length}</span>
                </h2>
                <ul className="um-p-iggrid">
                  {items.map((c) => (
                    <li key={c.id} data-testid={`integration-${c.id}`}>
                      <button type="button" className="um-p-ig" onClick={() => go({ card: c.id })}>
                        <span className={`um-tile um-tone-${look.tone}`}>
                          <Icon name={look.icon} />
                        </span>
                        <span className="um-p-ig-t">
                          <b>{c.title}</b>
                          <span className="um-sr"> — Set up {c.title}</span>
                        </span>
                        <span className="um-p-ig-s">
                          <StatusBadge status={c.status} />
                          {c.availability !== "ready" ? (
                            <Tag>{AVAILABILITY_TEXT[c.availability]}</Tag>
                          ) : null}
                        </span>
                        <span className="um-p-ig-p">{c.summary}</span>
                        {c.recommended ? (
                          <span className="um-p-ig-r" data-testid="integration-recommended">
                            {c.recommended}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {selected ? (
        <CardDetail
          key={selected.id}
          tenantId={tenantId}
          card={selected}
          site={site}
          serviceId={serviceId}
          status={status.data}
          onLive={setLive}
          onClose={close}
        />
      ) : null}
    </ProjectFrame>
  );
}
