// SPDX-License-Identifier: Apache-2.0
// Live first-event panel (plan E4, the UI side of E2): while a website has no counted events, show what the edge
// received from its dev/preview origins (`listSiteDevEvents`: kind, event name, normalised path, would-be verdict and
// worst reason — never counted, kept 24 hours, no visitor data), let an admin declare dev origins (`localhost`,
// `127.0.0.1`, exact hosts, `myapp-*.vercel.app`) and switch the time-boxed debug mode on or off (`setSiteDebugMode`,
// wire-formats §a.8). Polls every 5 seconds while it is shown.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { fmtDayTime } from "../lib/format.ts";
import { ProblemAlert } from "./ProblemAlert.tsx";

export const FIRST_EVENT_POLL_MS = 5000;

const VERDICT_TEXT: Record<ControlPlane.DevEvent["would_be_verdict"], string> = {
  verified: "would be verified",
  suspect: "would be suspect",
  rejected: "would be rejected",
};

/** wire-formats §a.8 entry rules, checked before the request (the control plane checks them again). */
export function devOriginProblem(entry: string): string | null {
  const e = entry.trim().toLowerCase();
  if (e === "") return "Enter a host.";
  if (e === "localhost" || e === "127.0.0.1") return null;
  if (e.includes("://") || e.includes("/") || e.includes(":"))
    return "Enter a host only, without scheme, port or path.";
  const labels = e.split(".");
  if (labels.length < 2) return "Enter a full host name.";
  const stars = (e.match(/\*/g) ?? []).length;
  if (stars > 1) return "Use at most one *.";
  // The control plane also refuses short wildcard labels on hosts the project has not verified and any bare `*.`
  // directly above a public suffix (`*.vercel.app` would admit every user of the host); its answer is shown as is.
  if (stars === 1 && !(labels[0] as string).includes("*"))
    return "The * may only appear in the leftmost label.";
  if (!/^[a-z0-9*-]+(\.[a-z0-9-]+)+$/.test(e)) return "Only letters, digits, hyphens and dots.";
  return null;
}

function DevOriginsForm({ tenantId, site }: { tenantId: string; site: ControlPlane.Site }) {
  const id = useId();
  const qc = useQueryClient();
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const current = site.dev_origins ?? [];
  const save = useMutation({
    mutationFn: (dev_origins: string[]) =>
      api.call("updateSite", {
        path: { tenantId, siteId: site.site_id },
        body: { dev_origins },
      }),
    onSuccess: async () => {
      setEntry("");
      await qc.invalidateQueries({ queryKey: ["site", tenantId, site.site_id] });
      await qc.invalidateQueries({ queryKey: ["sites", tenantId] });
      await qc.invalidateQueries({ queryKey: ["dev-events", tenantId, site.site_id] });
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const p = devOriginProblem(entry);
        if (p) {
          save.reset();
          return setError(p);
        }
        setError(null);
        save.mutate([...current, entry.trim().toLowerCase()]);
      }}
    >
      <p className="small">Dev and preview origins: {current.length === 0 ? "none yet." : null}</p>
      {current.length > 0 ? (
        <ul data-testid="dev-origins">
          {current.map((o) => (
            <li key={o}>
              <code>{o}</code>{" "}
              <button
                type="button"
                className="secondary"
                onClick={() => save.mutate(current.filter((x) => x !== o))}
              >
                Remove<span className="sr-only"> {o}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <div>
          <label htmlFor={`${id}-o`}>Add a dev or preview origin</label>
          <input
            id={`${id}-o`}
            value={entry}
            placeholder="localhost or myapp-*.vercel.app"
            onChange={(e) => setEntry(e.target.value)}
          />
        </div>
        <button type="submit" disabled={save.isPending || current.length >= 10}>
          Add origin
        </button>
      </div>
      {error ? (
        <p className="alert error" role="alert">
          {error}
        </p>
      ) : null}
      <ProblemAlert error={save.error} />
    </form>
  );
}

export function FirstEventPanel({
  tenantId,
  site,
  headingLevel = 3,
}: {
  tenantId: string;
  site: ControlPlane.Site;
  headingLevel?: 2 | 3;
}) {
  const id = useId();
  const qc = useQueryClient();
  const dev = useQuery({
    queryKey: ["dev-events", tenantId, site.site_id],
    queryFn: () => api.call("listSiteDevEvents", { path: { tenantId, siteId: site.site_id } }),
    refetchInterval: FIRST_EVENT_POLL_MS,
  });
  const debug = useMutation({
    mutationFn: (enabled: boolean) =>
      api.call("setSiteDebugMode", {
        path: { tenantId, siteId: site.site_id },
        body: enabled ? { enabled: true, duration_minutes: 60 } : { enabled: false },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["dev-events", tenantId, site.site_id] });
      await qc.invalidateQueries({ queryKey: ["site", tenantId, site.site_id] });
    },
  });
  const until = dev.data?.debug_until ?? null;
  const debugOn = until !== null && Date.parse(until) > Date.now();
  const events = dev.data?.events ?? [];
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      className="card stack"
      aria-labelledby={`${id}-h`}
      data-testid={`first-event-${site.site_id}`}
    >
      <H id={`${id}-h`}>Waiting for the first event: {site.name}</H>
      <p>
        No counted events have arrived yet. Open a page of the website with the snippet installed.
        To try it before you deploy, add <code>localhost</code> or your preview host below: events
        from these origins appear here within seconds and are <strong>never counted</strong>.
      </p>
      <ProblemAlert error={dev.error} />
      {events.length === 0 ? (
        <p className="alert info" role="status" data-testid="first-event-none">
          Nothing received from a dev origin in the last 24 hours. This panel refreshes every few
          seconds.
        </p>
      ) : (
        <div className="table-wrap">
          <table data-testid="dev-events">
            <caption>Received from dev origins (newest first, not counted)</caption>
            <thead>
              <tr>
                <th scope="col">Received</th>
                <th scope="col">Event</th>
                <th scope="col">Path</th>
                <th scope="col">Verdict if it were counted</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={`${e.received_at}-${e.event_name}-${e.path}`}>
                  <td>{fmtDayTime(e.received_at)}</td>
                  <td>
                    {e.event_name} <span className="tag">{e.kind}</span>
                  </td>
                  <td>
                    <code>{e.path}</code>
                  </td>
                  <td>
                    {VERDICT_TEXT[e.would_be_verdict]}
                    {e.reason ? (
                      <>
                        {" "}
                        (<code>{e.reason}</code>)
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DevOriginsForm tenantId={tenantId} site={site} />
      <div className="stack">
        <p data-testid="debug-state">
          Debug mode:{" "}
          {debugOn && until ? <strong>on until {fmtDayTime(until)}</strong> : <strong>off</strong>}
        </p>
        <p className="small muted">
          While debug mode is on (at most 24 hours, recorded in the audit log), every request of
          this website gets an <code>X-Scf-Debug</code> answer header with its verdict and reasons,
          so the tracker's debug mode can explain why an event was not counted. Anyone can read
          those reasons meanwhile, so switch it off when you are done.
        </p>
        <div className="row">
          {debugOn ? (
            <button
              type="button"
              className="secondary"
              onClick={() => debug.mutate(false)}
              disabled={debug.isPending}
            >
              Switch debug mode off
            </button>
          ) : (
            <button type="button" onClick={() => debug.mutate(true)} disabled={debug.isPending}>
              Switch debug mode on for 1 hour
            </button>
          )}
        </div>
        <ProblemAlert error={debug.error} />
      </div>
    </section>
  );
}
