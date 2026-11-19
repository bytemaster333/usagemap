// SPDX-License-Identifier: Apache-2.0
// Onboarding wizard: a guided path from nothing to data on the dashboard.
//   Web: website → domain verification → SRI snippet → installation check (C-39), with the live first-event panel
//        (plan E4) while nothing has arrived.
//   Stellar contracts: the Registered Footprint step (contracts only for now, C-137).
//   API: service → ingest token (shown once) → OpenTelemetry dual-export configuration for the tenant's stack
//        (C-102, C-105; the tenant keeps its own APM) → verification that requests arrive, with the data-quality
//        counters when they do not.
// Every step is a URL (`?step=…&site=…` / `?step=…&service=…&stack=…`) so the person can leave and come back — except
// the token's secret, which only lives in this page's memory and is never put in the URL.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { FirstEventPanel } from "../components/FirstEventPanel.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { SecretOnce } from "../components/SecretOnce.tsx";
import { fmtInt } from "../lib/format.ts";
import { API_STEPS, type ApiStep, type OtelStack, WEB_STEPS, type WebStep } from "../lib/search.ts";
import { DataQualityTable } from "./ApiDashboard.tsx";
import { CreateToken } from "./IngestTokens.tsx";
import { OtelConfigPanel } from "./OtelSetup.tsx";
import { CreateSite } from "./project/Settings.tsx";
import { RegisterService, useServices } from "./Services.tsx";
import { useSite } from "./SiteLayout.tsx";
import { DomainsSection } from "./SiteSettings.tsx";
import { TenantNav } from "./TenantNav.tsx";

const WEB_LABELS: Record<WebStep, string> = {
  site: "Website",
  domain: "Domain verification",
  snippet: "Snippet",
  check: "Installation check",
};
const API_LABELS: Record<ApiStep, string> = {
  service: "Service",
  token: "Ingest token",
  configure: "OpenTelemetry",
  verify: "Check data",
};

function Steps<S extends string>({
  steps,
  labels,
  current,
}: {
  steps: readonly S[];
  labels: Record<S, string>;
  current: S;
}) {
  return (
    <ol className="steps" aria-label="Set-up steps">
      {steps.map((s) => (
        <li key={s} aria-current={s === current ? "step" : undefined}>
          {labels[s]}
        </li>
      ))}
    </ol>
  );
}

export function OnboardingPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/setup" });
  useTitle("Set-up wizard");
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <h1>Set-up wizard</h1>
      <p>
        In a hurry? The{" "}
        <Link to="/t/$tenantId/onboard/kit" params={{ tenantId }} search={{}}>
          integration kit
        </Link>{" "}
        has everything to copy on one page.
      </p>
      <p>What do you want to measure?</p>
      <div className="grid-2">
        <section className="card stack">
          <h2>A website or web app</h2>
          <p>
            Privacy-first page views, visitors, referrers, countries and devices. A small script
            tag, no cookies.
          </p>
          <p>
            <Link
              to="/t/$tenantId/setup/web"
              params={{ tenantId }}
              search={{ step: "site" }}
              className="button"
            >
              Set up a website
            </Link>
          </p>
        </section>
        <section className="card stack">
          <h2>An API</h2>
          <p>
            Request volume, status codes and latency per route from your servers’ OpenTelemetry —
            next to the APM you already use.
          </p>
          <p>
            <Link
              to="/t/$tenantId/setup/api"
              params={{ tenantId }}
              search={{ step: "service", stack: "node" }}
              className="button"
            >
              Set up an API
            </Link>
          </p>
        </section>
        <section className="card stack">
          <h2>Stellar contracts</h2>
          <p>
            Register the contracts your project controls, so their on-chain activity is counted next
            to your web and API figures. Only addresses your project controls.
          </p>
          <p>
            <Link to="/t/$tenantId/setup/footprint" params={{ tenantId }} className="button">
              Register contracts
            </Link>
          </p>
        </section>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ web

function SnippetStep({ tenantId, siteId }: { tenantId: string; siteId: string }) {
  const snippet = useQuery({
    queryKey: ["snippet", tenantId, siteId, "html", undefined],
    queryFn: () =>
      api.call("getSnippet", { path: { tenantId, siteId }, query: { format: "html" } }),
  });
  return (
    <section className="card stack" aria-labelledby="wz-snip">
      <h2 id="wz-snip">Add the snippet to every page</h2>
      <ProblemAlert error={snippet.error} />
      {snippet.data ? (
        <>
          <pre className="code" data-testid="wizard-snippet">
            <code>{snippet.data.code}</code>
          </pre>
          <CopyButton text={snippet.data.code} label="Copy snippet" />
          <p className="small">
            The <code>integrity</code> value pins the exact tracker file (Subresource Integrity).
            For npm, Next.js, Vite, Astro, Angular or consent mode, see the{" "}
            <Link
              to="/t/$tenantId/sites/$siteId/snippet"
              params={{ tenantId, siteId }}
              search={{ format: "nextjs" }}
            >
              snippet page
            </Link>
            .
          </p>
        </>
      ) : null}
    </section>
  );
}

function CheckStep({ tenantId, siteId }: { tenantId: string; siteId: string }) {
  const check = useQuery({
    queryKey: ["installation", tenantId, siteId, "24h"],
    queryFn: () =>
      api.call("getInstallationCheck", { path: { tenantId, siteId }, query: { range: "24h" } }),
    refetchInterval: 15_000,
  });
  const site = useSite(tenantId, siteId);
  const c = check.data;
  const total = c ? c.verdicts.verified + c.verdicts.suspect + c.verdicts.rejected : 0;
  return (
    <section className="card stack" aria-labelledby="wz-check">
      <h2 id="wz-check">Check the installation</h2>
      <p>Open a page of your website in a browser, then check here (it refreshes by itself).</p>
      <ProblemAlert error={check.error} />
      {c ? (
        total > 0 ? (
          <div className="alert ok" role="status" data-testid="wizard-check-ok">
            <p>
              <strong>Events are arriving.</strong> Last 24 hours: {fmtInt(c.verdicts.verified)}{" "}
              verified, {fmtInt(c.verdicts.suspect)} suspect, {fmtInt(c.verdicts.rejected)} rejected
              {c.tracker_version_seen ? ` · tracker ${c.tracker_version_seen}` : ""}.
            </p>
          </div>
        ) : (
          <>
            <p className="alert warn" role="status" data-testid="wizard-check-none">
              No events in the last 24 hours yet.
            </p>
            {site.data ? <FirstEventPanel tenantId={tenantId} site={site.data} /> : null}
          </>
        )
      ) : null}
      <div className="row">
        <button type="button" className="secondary" onClick={() => void check.refetch()}>
          Check again
        </button>
        <Link
          to="/t/$tenantId/sites/$siteId/installation"
          params={{ tenantId, siteId }}
          search={{ range: "24h" }}
        >
          Full installation check with reasons
        </Link>
        <Link
          to="/t/$tenantId/sites/$siteId"
          params={{ tenantId, siteId }}
          search={{ range: "7d", variant: "verified", compare: false }}
          className="button"
        >
          Open the dashboard
        </Link>
      </div>
    </section>
  );
}

export function WebWizardPage() {
  const id = useId();
  const { tenantId } = useParams({ from: "/app/t/$tenantId/setup/web" });
  const search = useSearch({ from: "/app/t/$tenantId/setup/web" });
  const navigate = useNavigate();
  useTitle("Set up a website");
  const sites = useQuery({
    queryKey: ["sites", tenantId],
    queryFn: () => api.call("listSites", { path: { tenantId } }),
  });
  const [pick, setPick] = useState("");
  const go = (step: WebStep, site = search.site) =>
    void navigate({
      to: "/t/$tenantId/setup/web",
      params: { tenantId },
      search: site ? { step, site } : { step },
    });
  const step = search.site ? search.step : "site";
  const siteId = search.site;
  const idx = WEB_STEPS.indexOf(step);
  const next = WEB_STEPS[idx + 1];
  const prev = WEB_STEPS[idx - 1];
  const siteName = sites.data?.find((s) => s.site_id === siteId)?.name;
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <h1>Set up a website{siteName ? `: ${siteName}` : ""}</h1>
      <Steps steps={WEB_STEPS} labels={WEB_LABELS} current={step} />
      {step === "site" ? (
        <>
          {sites.data && sites.data.length > 0 ? (
            <form
              className="card row"
              onSubmit={(e) => {
                e.preventDefault();
                const s = pick || sites.data?.[0]?.site_id;
                if (s) go("domain", s);
              }}
            >
              <div>
                <label htmlFor={`${id}-p`}>Continue with an existing website</label>
                <select id={`${id}-p`} value={pick} onChange={(e) => setPick(e.target.value)}>
                  {sites.data.map((s) => (
                    <option key={s.site_id} value={s.site_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit">Continue</button>
            </form>
          ) : null}
          <CreateSite tenantId={tenantId} onCreated={(s) => go("domain", s.site_id)} />
        </>
      ) : null}
      {step === "domain" && siteId ? (
        <>
          <p>
            Declare the domains your website runs on and prove you control them (DNS TXT record, a
            file under <code>/.well-known/</code> or a meta tag). You can continue before the check
            passes; events from unverified domains count as suspect until it does.
          </p>
          <DomainsSection tenantId={tenantId} siteId={siteId} />
        </>
      ) : null}
      {step === "snippet" && siteId ? <SnippetStep tenantId={tenantId} siteId={siteId} /> : null}
      {step === "check" && siteId ? <CheckStep tenantId={tenantId} siteId={siteId} /> : null}
      {step !== "site" ? (
        <div className="row">
          {prev ? (
            <button type="button" className="secondary" onClick={() => go(prev)}>
              Back: {WEB_LABELS[prev]}
            </button>
          ) : null}
          {next ? (
            <button type="button" onClick={() => go(next)}>
              Next: {WEB_LABELS[next]}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ API

function VerifyStep({ tenantId, service }: { tenantId: string; service: ControlPlane.Service }) {
  const path = { tenantId, serviceId: service.service_id };
  const summary = useQuery({
    queryKey: ["api-summary", tenantId, service.service_id, { range: "24h" }],
    queryFn: () => api.call("getApiSummary", { path, query: { range: "24h" } }),
    refetchInterval: 15_000,
  });
  const dq = useQuery({
    queryKey: ["api-dq", tenantId, service.service_id, "24h"],
    queryFn: () => api.call("getServiceDataQuality", { path, query: { range: "24h" } }),
  });
  const n = summary.data?.requests ?? 0;
  return (
    <section className="card stack" aria-labelledby="wz-verify">
      <h2 id="wz-verify">Check that data arrives</h2>
      <p>
        Deploy the configuration and send a few requests to your API. Metrics are exported about
        once a minute; this check refreshes by itself.
      </p>
      <ProblemAlert error={summary.error} />
      {summary.data ? (
        n > 0 ? (
          <div className="alert ok" role="status" data-testid="wizard-api-ok">
            <strong>Data is arriving:</strong> {fmtInt(n)} requests in the last 24 hours for{" "}
            <code>{service.service_name}</code>.
          </div>
        ) : (
          <p className="alert warn" role="status" data-testid="wizard-api-none">
            No requests for <code>{service.service_name}</code> in the last 24 hours yet.
          </p>
        )
      ) : null}
      {dq.data && dq.data.reasons.length > 0 ? (
        <details open={n === 0}>
          <summary>What SCF received but did not store (last 24 hours)</summary>
          <DataQualityTable dq={dq.data} />
        </details>
      ) : null}
      <div className="row">
        <button type="button" className="secondary" onClick={() => void summary.refetch()}>
          Check again
        </button>
        <Link
          to="/t/$tenantId/services/$serviceId"
          params={path}
          search={{ range: "24h", compare: false, sort: "-requests" }}
          className="button"
        >
          Open the API dashboard
        </Link>
      </div>
    </section>
  );
}

export function ApiWizardPage() {
  const id = useId();
  const { tenantId } = useParams({ from: "/app/t/$tenantId/setup/api" });
  const search = useSearch({ from: "/app/t/$tenantId/setup/api" });
  const navigate = useNavigate();
  useTitle("Set up an API");
  const services = useServices(tenantId);
  const [pick, setPick] = useState("");
  // The secret lives here only; leaving the page forgets it.
  const [token, setToken] = useState<ControlPlane.IngestTokenCreated | null>(null);
  const go = (step: ApiStep, extra: { service?: string | undefined; stack?: OtelStack } = {}) => {
    const service = extra.service ?? search.service;
    void navigate({
      to: "/t/$tenantId/setup/api",
      params: { tenantId },
      search: { step, stack: extra.stack ?? search.stack, ...(service ? { service } : {}) },
    });
  };
  const step = search.service ? search.step : "service";
  const svc = services.data?.find((s) => s.service_id === search.service);
  const idx = API_STEPS.indexOf(step);
  const next = API_STEPS[idx + 1];
  const prev = API_STEPS[idx - 1];
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <h1>Set up an API{svc ? `: ${svc.service_name}` : ""}</h1>
      <Steps steps={API_STEPS} labels={API_LABELS} current={step} />
      <ProblemAlert error={services.error} />
      {step === "service" ? (
        <>
          {services.data && services.data.length > 0 ? (
            <form
              className="card row"
              onSubmit={(e) => {
                e.preventDefault();
                const s = pick || services.data?.[0]?.service_id;
                if (s) go("token", { service: s });
              }}
            >
              <div>
                <label htmlFor={`${id}-p`}>Continue with an existing service</label>
                <select id={`${id}-p`} value={pick} onChange={(e) => setPick(e.target.value)}>
                  {services.data.map((s) => (
                    <option key={s.service_id} value={s.service_id}>
                      {s.service_name}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit">Continue</button>
            </form>
          ) : null}
          <RegisterService
            tenantId={tenantId}
            onCreated={(s) => go("token", { service: s.service_id })}
          />
        </>
      ) : null}
      {step === "token" && svc ? (
        <>
          <p>
            Your exporter needs an ingest token. Create one for this service, or skip this step if
            you already have one.
          </p>
          {token ? (
            <SecretOnce
              label={`New token “${token.label}”`}
              secret={token.token}
              onDismiss={() => setToken(null)}
            >
              <p>
                Store it as <code>SCF_OTLP_TOKEN</code> in your secret store; the next step’s
                configuration reads it from there.
              </p>
            </SecretOnce>
          ) : (
            <CreateToken
              tenantId={tenantId}
              defaultServices={[svc.service_name]}
              onCreated={setToken}
            />
          )}
        </>
      ) : null}
      {step === "configure" && svc ? (
        <OtelConfigPanel
          tenantId={tenantId}
          serviceId={svc.service_id}
          stack={search.stack}
          onStack={(stack) =>
            void navigate({
              to: "/t/$tenantId/setup/api",
              params: { tenantId },
              search: { step: "configure", service: svc.service_id, stack },
              replace: true,
            })
          }
        />
      ) : null}
      {step === "verify" && svc ? <VerifyStep tenantId={tenantId} service={svc} /> : null}
      {step !== "service" ? (
        <div className="row">
          {prev ? (
            <button type="button" className="secondary" onClick={() => go(prev)}>
              Back: {API_LABELS[prev]}
            </button>
          ) : null}
          {next ? (
            <button type="button" onClick={() => go(next)}>
              Next: {API_LABELS[next]}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
