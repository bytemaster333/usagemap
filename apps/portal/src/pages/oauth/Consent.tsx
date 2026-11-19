// SPDX-License-Identifier: Apache-2.0
// Consent page of the MCP OAuth authorization server (/oauth/consent?request=<id>). An MCP client such as an AI assistant sent
// the person here through the control plane's authorization endpoint; the portal's own sign-in (GitHub, Stellar,
// passkey) has already happened in the signed-in frame. The person picks ONE project the app may read — or, for an SCF
// operator, the read-only operator view, which asks for a passkey step-up — or denies. Both answers send the browser
// back to the app's registered redirect URI. The page shows who is asking and where the browser will go (the redirect
// host), and warns when that is only this computer (a loopback redirect any local program could claim).

import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useId, useState } from "react";
import { ApiError, api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import { fmtDayTime } from "../../lib/format.ts";
import { approveBody, type Choice, safeRedirect } from "./model.ts";

export function OAuthConsentPage() {
  useTitle("Connect an app");
  const search = useSearch({ from: "/app/oauth/consent" });
  const requestId = search.request;
  const id = useId();
  const [choice, setChoice] = useState<Choice>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const req = useQuery({
    queryKey: ["oauth-request", requestId],
    queryFn: () => api.call("getOAuthRequest", { path: { requestId: requestId as string } }),
    enabled: requestId !== undefined,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const leave = (redirect: string) => {
    const to = safeRedirect(redirect);
    if (to) window.location.assign(to);
  };
  const decide = async (allow: boolean) => {
    if (!requestId) return;
    setError(null);
    setBusy(true);
    try {
      const r = allow
        ? choice
          ? await api.call("approveOAuthRequest", {
              path: { requestId },
              body: approveBody(choice),
            })
          : null
        : await api.call("denyOAuthRequest", { path: { requestId } });
      if (r) leave(r.redirect_to);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const gone =
    !requestId || (req.error instanceof ApiError && req.error.status === 404) ? (
      <section className="card">
        <h1>This connection request is no longer open</h1>
        <p>
          It has expired (requests are valid for 10 minutes) or has already been answered. Start the
          connection again from the app.
        </p>
      </section>
    ) : null;
  if (gone) return gone;
  if (req.error) return <ProblemAlert error={req.error} />;
  const r = req.data;
  if (!r) return <p aria-busy="true">Loading…</p>;

  const name = r.client.name;
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>
        Allow <q>{name}</q> read-only access?
      </h1>
      <p>
        <q>{name}</q> asks to read UsageMap analytics on your behalf. After you allow it, you will
        be sent back to <strong>{r.redirect_host}</strong>.
        {r.client.metadata_host ? (
          <>
            {" "}
            The app is identified by a description published at{" "}
            <strong>{r.client.metadata_host}</strong>.
          </>
        ) : (
          <>
            {" "}
            The name was given by the app itself when it registered; check the address above before
            you continue.
          </>
        )}
      </p>
      {r.redirect_loopback ? (
        <p role="alert" className="alert error">
          This app receives the access on <strong>this computer</strong> (a local address). Any
          program running here could pose as it: continue only if you started this connection
          yourself from an app on this computer.
        </p>
      ) : null}

      <h2>What the app can do</h2>
      <ul>
        <li>
          Read the chosen project's web and API analytics, wallet funnel, trust scores and traction
          snapshots.
        </li>
        <li>
          It cannot change anything, and cannot see members, keys, tokens or the audit log. Access
          ends when you disconnect it (Account → Connected apps), when you leave the project, or
          after 90 days.
        </li>
      </ul>

      <fieldset>
        <legend>Which data may it read?</legend>
        {r.tenants.length === 0 && !r.operator.eligible ? (
          <p className="muted">
            You are not a member of any project yet, so there is nothing to share.
          </p>
        ) : null}
        {r.tenants.map((t) => (
          <label key={t.tenant_id} className="inline">
            <input
              type="radio"
              name={`${id}-choice`}
              checked={choice !== null && "tenantId" in choice && choice.tenantId === t.tenant_id}
              onChange={() => setChoice({ tenantId: t.tenant_id })}
            />
            {t.name}{" "}
            <span className="muted small">
              ({t.slug}, your role: {t.role})
            </span>
          </label>
        ))}
        {r.operator.eligible ? (
          <label className="inline">
            <input
              type="radio"
              name={`${id}-choice`}
              checked={choice !== null && "operator" in choice}
              onChange={() => setChoice({ operator: true })}
            />
            SCF operator view: every project, read-only{" "}
            <span className="muted small">
              (asks for your passkey; ends after 30 minutes without use and at most after 12 hours
              {r.operator.step_up_valid_until
                ? `; passkey confirmed until ${fmtDayTime(r.operator.step_up_valid_until)}`
                : ""}
              )
            </span>
          </label>
        ) : null}
      </fieldset>

      <ProblemAlert error={error} />
      <p className="small muted">This request expires at {fmtDayTime(r.expires_at)}.</p>
      <div className="row">
        <button type="button" disabled={busy || choice === null} onClick={() => void decide(true)}>
          Allow read-only access
        </button>{" "}
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          Deny
        </button>
      </div>
    </section>
  );
}
