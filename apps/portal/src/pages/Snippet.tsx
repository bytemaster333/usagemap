// SPDX-License-Identifier: Apache-2.0
// Snippet page: the SRI-pinned tracker snippet for the site's profile, per framework, including the consent-gated
// mode (C-55), and the published tracker versions with both profiles' files and integrity values.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useId } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { fmtDay } from "../lib/format.ts";
import { SNIPPET_FORMATS, type SnippetFormat } from "../lib/search.ts";
import { PROFILE_TEXT, SettingsHeader } from "./project/Settings.tsx";
import { useSite } from "./SiteLayout.tsx";

export function SnippetPage() {
  const id = useId();
  const { tenantId, siteId } = useParams({ from: "/app/t/$tenantId/sites/$siteId/snippet" });
  const search = useSearch({ from: "/app/t/$tenantId/sites/$siteId/snippet" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const site = useSite(tenantId, siteId);
  useTitle(site.data ? `${site.data.name} snippet` : "Snippet");
  const versions = useQuery({
    queryKey: ["tracker-versions"],
    queryFn: () => api.call("listTrackerVersions", {}),
  });
  const snippet = useQuery({
    queryKey: [
      "snippet",
      tenantId,
      siteId,
      search.format,
      search.version,
      site.data?.tracker_profile,
    ],
    queryFn: () =>
      api.call("getSnippet", {
        path: { tenantId, siteId },
        query: { format: search.format, ...(search.version ? { version: search.version } : {}) },
      }),
  });
  const setProfile = useMutation({
    mutationFn: (p: "standard" | "strict") =>
      api.call("updateSite", { path: { tenantId, siteId }, body: { tracker_profile: p } }),
    onSuccess: (s) => {
      qc.setQueryData(["site", tenantId, siteId], s);
    },
  });
  const go = (s: { format: SnippetFormat; version?: string }) =>
    void navigate({
      to: "/t/$tenantId/sites/$siteId/snippet",
      params: { tenantId, siteId },
      search: s,
      replace: true,
    });
  const active = (versions.data ?? []).filter((v) => v.status === "active");

  return (
    <>
      <SettingsHeader tenantId={tenantId} current="sites" />
      <h2 className="um-h2">Install the tracker</h2>
      <p>
        Add this snippet to every page of your website. The <code>integrity</code> value pins the
        exact file, so the browser refuses any other content (Subresource Integrity).
      </p>
      {site.data ? (
        <section className="card" aria-labelledby={`${id}-p`}>
          <h3 id={`${id}-p`}>Tracker profile</h3>
          <p>
            This website uses the{" "}
            <strong data-testid="site-profile">{site.data.tracker_profile}</strong> profile.
          </p>
          <ul>
            <li>{PROFILE_TEXT.standard}</li>
            <li>{PROFILE_TEXT.strict}</li>
          </ul>
          <button
            type="button"
            className="secondary"
            disabled={setProfile.isPending}
            onClick={() =>
              setProfile.mutate(site.data.tracker_profile === "standard" ? "strict" : "standard")
            }
          >
            Switch to the {site.data.tracker_profile === "standard" ? "strict" : "standard"} profile
          </button>
          <ProblemAlert error={setProfile.error} />
        </section>
      ) : null}
      <div className="row">
        <div>
          <label htmlFor={`${id}-f`}>Format</label>
          <select
            id={`${id}-f`}
            value={search.format}
            onChange={(e) =>
              go({
                format: e.target.value as SnippetFormat,
                ...(search.version ? { version: search.version } : {}),
              })
            }
          >
            {SNIPPET_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-v`}>Tracker version</label>
          <select
            id={`${id}-v`}
            value={search.version ?? ""}
            onChange={(e) =>
              go({ format: search.format, ...(e.target.value ? { version: e.target.value } : {}) })
            }
          >
            <option value="">Newest</option>
            {active.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ProblemAlert error={snippet.error} />
      {snippet.data ? (
        <section className="card" aria-labelledby={`${id}-s`}>
          <h3 id={`${id}-s`}>
            Snippet ({SNIPPET_FORMATS.find((f) => f.id === search.format)?.label}, version{" "}
            {snippet.data.version})
          </h3>
          <pre className="code" data-testid="snippet-code">
            <code>{snippet.data.code}</code>
          </pre>
          <CopyButton text={snippet.data.code} label="Copy snippet" />
          {snippet.data.integrity ? (
            <p className="small">
              Integrity: <code data-testid="snippet-integrity">{snippet.data.integrity}</code>
            </p>
          ) : null}
          {snippet.data.notice_text_url ? (
            <p className="small">
              <a href={snippet.data.notice_text_url} rel="noopener noreferrer">
                Privacy notice text for your website
              </a>
            </p>
          ) : null}
        </section>
      ) : null}
      {search.format === "consent_html" ? (
        <section className="card" data-testid="consent-help">
          <h3>Consent mode</h3>
          <p>
            In consent mode the tracker loads but sends nothing — no challenge request, no event —
            until your consent tool calls <code>grantConsent()</code>, and it stops sending when it
            calls <code>revokeConsent()</code>. Use it wherever your visitors' jurisdiction requires
            opt-in, or whenever you prefer consent. Obtaining and recording consent is your job as
            the controller; the tracker only obeys the signal. The opt-out link, Global Privacy
            Control and Do Not Track still apply.
          </p>
        </section>
      ) : null}
      <section className="card" aria-labelledby={`${id}-tv`}>
        <h3 id={`${id}-tv`}>Published tracker versions</h3>
        <ProblemAlert error={versions.error} />
        <table>
          <caption className="sr-only">Tracker versions and their files</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Released</th>
              <th scope="col">Profile</th>
              <th scope="col">Integrity</th>
            </tr>
          </thead>
          <tbody>
            {(versions.data ?? []).flatMap((v) =>
              v.files.map((f) => (
                <tr key={`${v.version}-${f.profile}`}>
                  <td>{v.version}</td>
                  <td>{v.status}</td>
                  <td>{fmtDay(v.released_at)}</td>
                  <td>{f.profile}</td>
                  <td>
                    <code className="small">{f.integrity}</code>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
