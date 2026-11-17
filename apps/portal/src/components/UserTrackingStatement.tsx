// SPDX-License-Identifier: Apache-2.0
// The "user tracking" paragraph for an SCF application: the programme asks every
// applicant to "provide an explanation of plans for user tracking and efforts to limit and protect users".
// The control plane generates it from the project's actual setup over the last 30 complete UTC days
// (getUserTrackingStatement): only sources that delivered data are named; sources that are set up but silent are
// listed below as "set up, no data yet". Wording rule C4: a description of measurement, never an endorsement.

import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { api } from "../api/client.ts";
import { fmtDay } from "../lib/format.ts";
import { CopyButton } from "./CopyButton.tsx";
import { ProblemAlert } from "./ProblemAlert.tsx";

export const SOURCE_TEXT: Record<string, string> = {
  web: "Website page views",
  wallet: "Wallet events",
  passkey: "Passkey and smart-wallet events",
  api: "API request metrics",
  stellar_client: "Stellar RPC / Horizon client metrics",
  onchain: "On-chain activity of registered contracts",
};

export function UserTrackingStatement({ tenantId }: { tenantId: string }) {
  const id = useId();
  const q = useQuery({
    queryKey: ["user-tracking", tenantId],
    queryFn: () => api.call("getUserTrackingStatement", { path: { tenantId } }),
  });
  const s = q.data;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`} data-testid="user-tracking">
      <h2 id={`${id}-h`}>User-tracking paragraph for your SCF application</h2>
      <p className="muted">
        SCF applications must explain how the project tracks users and how it limits and protects
        what it collects. This text is generated from what UsageMap actually received for your
        project
        {s ? ` between ${fmtDay(s.window.start)} and ${fmtDay(s.window.end)} (UTC)` : ""}. It names
        only sources that delivered data. Review it before you paste it.
      </p>
      <ProblemAlert error={q.error} />
      {s ? (
        <>
          <blockquote className="stack" data-testid="user-tracking-paragraph">
            <p>{s.paragraph}</p>
          </blockquote>
          <p>
            <CopyButton text={s.paragraph} label="Copy paragraph" />
          </p>
          {s.sources.length > 0 ? (
            <ul data-testid="user-tracking-sources">
              {s.sources.map((src) => (
                <li key={src.source} data-status={src.status}>
                  <strong>{SOURCE_TEXT[src.source] ?? src.source}</strong>
                  {src.status === "measured" ? " — measured: " : " — set up, no data yet: "}
                  {src.detail}
                </li>
              ))}
            </ul>
          ) : null}
          <details>
            <summary>Never collected</summary>
            <ul>
              {s.never_collected.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Data-flow diagram (Mermaid)</summary>
            <pre className="code">
              <code data-testid="user-tracking-mermaid">{s.mermaid}</code>
            </pre>
            <CopyButton text={s.mermaid} label="Copy diagram" />
          </details>
          <p className="small">
            Details for readers: <a href={s.links.privacy}>what is collected and for how long</a>
            {s.links.public_stats ? (
              <>
                {" · "}
                <a href={s.links.public_stats}>public statistics</a>
              </>
            ) : null}
            {s.links.snapshot ? (
              <>
                {" · "}
                <a href={s.links.snapshot}>latest signed snapshot</a>
              </>
            ) : null}
          </p>
        </>
      ) : null}
    </section>
  );
}
