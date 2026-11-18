// SPDX-License-Identifier: Apache-2.0
// Website settings: domains and their verification (a site's events are accepted only from its declared domains;
// unverified ones are `suspect`, wire-formats §h.2) and the anonymous-reports switch (C-51).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { fmtDayTime } from "../lib/format.ts";
import { SettingsHeader } from "./project/Settings.tsx";
import { useSite } from "./SiteLayout.tsx";

type Verification = ControlPlane.DomainVerification;
type Method = Verification["method"];

const METHOD_TEXT: Record<Method, string> = {
  dns_txt: "DNS TXT record",
  well_known: "File under /.well-known/",
  meta_tag: "HTML meta tag",
};

function VerificationSteps({ v }: { v: Verification }) {
  const i = v.instructions;
  return (
    <div className="stack" data-testid="verification-instructions">
      {v.method === "dns_txt" ? (
        <p>
          Add a TXT record <code>{i.dns_name}</code> with the value <code>{i.dns_value}</code>.
        </p>
      ) : null}
      {v.method === "well_known" ? (
        <p>
          Serve <code>{i.url}</code> with the content <code>{i.file_body}</code>.
        </p>
      ) : null}
      {v.method === "meta_tag" ? (
        <p>
          Add <code>{i.meta_tag}</code> to the <code>&lt;head&gt;</code> of your home page.
        </p>
      ) : null}
      <p className="small">
        Status: <strong>{v.status}</strong>
        {v.last_result_code ? ` (last check: ${v.last_result_code})` : ""} · expires{" "}
        {fmtDayTime(v.expires_at)}
      </p>
    </div>
  );
}

function DomainRow({
  tenantId,
  siteId,
  d,
}: {
  tenantId: string;
  siteId: string;
  d: ControlPlane.Domain;
}) {
  const id = useId();
  const qc = useQueryClient();
  const [method, setMethod] = useState<Method>("dns_txt");
  const [verification, setVerification] = useState<Verification | null>(null);
  const path = { tenantId, siteId, domainId: d.domain_id };
  const refresh = () => qc.invalidateQueries({ queryKey: ["domains", tenantId, siteId] });
  const start = useMutation({
    mutationFn: () => api.call("startDomainVerification", { path, body: { method } }),
    onSuccess: setVerification,
  });
  const check = useMutation({
    mutationFn: (v: Verification) =>
      api.call("checkDomainVerification", { path: { ...path, verificationId: v.verification_id } }),
    onSuccess: async (v) => {
      setVerification(v);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.call("removeDomain", { path }),
    onSuccess: refresh,
  });
  return (
    <li className="card">
      <p>
        <strong>{d.host}</strong>
        {d.include_subdomains ? " and its subdomains" : ""} —{" "}
        <span data-testid={`domain-state-${d.host}`}>{d.state}</span>
      </p>
      {d.state !== "verified" ? (
        <div className="row">
          <div>
            <label htmlFor={`${id}-m`}>Verify by</label>
            <select
              id={`${id}-m`}
              value={method}
              onChange={(e) => setMethod(e.target.value as Method)}
            >
              {(Object.keys(METHOD_TEXT) as Method[]).map((m) => (
                <option key={m} value={m}>
                  {METHOD_TEXT[m]}
                </option>
              ))}
            </select>
          </div>
          <button type="button" onClick={() => start.mutate()} disabled={start.isPending}>
            Start verification<span className="sr-only"> of {d.host}</span>
          </button>
        </div>
      ) : null}
      {verification ? (
        <>
          <VerificationSteps v={verification} />
          <button
            type="button"
            onClick={() => check.mutate(verification)}
            disabled={check.isPending}
          >
            Check now
          </button>
        </>
      ) : null}
      <ProblemAlert error={start.error ?? check.error ?? remove.error} />
      <p>
        <button
          type="button"
          className="secondary"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
        >
          Remove {d.host}
        </button>
      </p>
    </li>
  );
}

/** Domains of a website with add, verify and remove (used by the settings page and the set-up wizard). */
export function DomainsSection({ tenantId, siteId }: { tenantId: string; siteId: string }) {
  const id = useId();
  const qc = useQueryClient();
  const domains = useQuery({
    queryKey: ["domains", tenantId, siteId],
    queryFn: () => api.call("listDomains", { path: { tenantId, siteId } }),
  });
  const [host, setHost] = useState("");
  const [subdomains, setSubdomains] = useState(false);
  const add = useMutation({
    mutationFn: () =>
      api.call("addDomain", {
        path: { tenantId, siteId },
        body: { host: host.trim(), include_subdomains: subdomains },
      }),
    onSuccess: async () => {
      setHost("");
      await qc.invalidateQueries({ queryKey: ["domains", tenantId, siteId] });
    },
  });
  return (
    <section className="card" aria-labelledby={`${id}-d`}>
      <h2 id={`${id}-d`}>Domains</h2>
      <p className="muted small">
        Events are accepted only from pages on these domains. Until a domain is verified, its events
        count as suspect.
      </p>
      <ProblemAlert error={domains.error} />
      <ul className="stack" aria-label="Domains">
        {(domains.data ?? []).map((d) => (
          <DomainRow key={d.domain_id} tenantId={tenantId} siteId={siteId} d={d} />
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <label htmlFor={`${id}-host`}>Add a domain</label>
        <div className="row">
          <input
            id={`${id}-host`}
            required
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.org"
            autoComplete="off"
          />
          <label className="inline">
            <input
              type="checkbox"
              checked={subdomains}
              onChange={(e) => setSubdomains(e.target.checked)}
            />
            Include subdomains
          </label>
          <button type="submit" disabled={add.isPending}>
            Add domain
          </button>
        </div>
        <ProblemAlert error={add.error} />
      </form>
    </section>
  );
}

export function SiteSettingsPage() {
  const id = useId();
  const { tenantId, siteId } = useParams({ from: "/app/t/$tenantId/sites/$siteId/settings" });
  const qc = useQueryClient();
  const site = useSite(tenantId, siteId);
  useTitle(site.data ? `${site.data.name} settings` : "Settings");
  const anon = useMutation({
    mutationFn: (on: boolean) =>
      api.call("setSiteAnonymousReports", {
        path: { tenantId, siteId },
        body: { anonymous_reports: on },
      }),
    onSuccess: (s) => qc.setQueryData(["site", tenantId, siteId], s),
  });

  return (
    <>
      <SettingsHeader tenantId={tenantId} current="sites" />
      <p className="um-p-fine">
        <Link
          className="um-link"
          to="/t/$tenantId/settings"
          params={{ tenantId }}
          search={{ tab: "sites", site: siteId }}
        >
          ← {site.data?.name ?? "Website"} settings
        </Link>
      </p>
      <DomainsSection tenantId={tenantId} siteId={siteId} />
      {site.data ? (
        <section className="card" aria-labelledby={`${id}-a`}>
          <h2 id={`${id}-a`}>Anonymous reports</h2>
          <p>
            Anonymous reports are{" "}
            <strong data-testid="anon-state">{site.data.anonymous_reports ? "on" : "off"}</strong>.
            When on, breakdown tables (referrers, pages, countries, devices, events) show counts
            rounded to the nearest 10 and combine rows below 10 into “Other”, as the French
            audience-measurement criteria require. Totals are always exact. If you switch this off,
            the notice text we supply no longer refers to those criteria.
          </p>
          <button
            type="button"
            className="secondary"
            onClick={() => anon.mutate(!site.data.anonymous_reports)}
            disabled={anon.isPending}
          >
            {site.data.anonymous_reports
              ? "Switch anonymous reports off"
              : "Switch anonymous reports on"}
          </button>
          <ProblemAlert error={anon.error} />
        </section>
      ) : null}
    </>
  );
}
