// SPDX-License-Identifier: Apache-2.0
// Connected apps (/oauth/apps): the MCP clients (such as AI assistants) the signed-in person has allowed to read UsageMap
// data, one row per grant, each with "Disconnect" — which revokes the grant and every token issued under it at once
// (audited `oauth.grant_revoked`).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import { fmtDayTime } from "../../lib/format.ts";

export function ConnectedAppsPage() {
  useTitle("Connected apps");
  const qc = useQueryClient();
  const grants = useQuery({
    queryKey: ["oauth-grants"],
    queryFn: () => api.call("listMyOAuthGrants", {}),
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) => api.call("revokeMyOAuthGrant", { path: { grantId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oauth-grants"] }),
  });
  const rows = grants.data ?? [];
  return (
    <>
      <h1>Connected apps</h1>
      <p>
        Apps you allowed to read UsageMap data through the hosted MCP server (for example an AI
        assistant). Access is read-only; disconnecting ends it at once.
      </p>
      <ProblemAlert error={grants.error ?? revoke.error} />
      <section className="card">
        {rows.length === 0 && grants.isSuccess ? (
          <p className="muted">No app is connected.</p>
        ) : (
          <table>
            <caption className="sr-only">Connected apps</caption>
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Access to</th>
                <th scope="col">Connected</th>
                <th scope="col">Last token</th>
                <th scope="col">Ends at the latest</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.grant_id}>
                  <td>{g.client_name}</td>
                  <td>
                    {g.kind === "operator"
                      ? "SCF operator view (all projects)"
                      : (g.tenant_name ?? "a project you left")}
                  </td>
                  <td>{fmtDayTime(g.created_at)}</td>
                  <td>{g.last_used_at ? fmtDayTime(g.last_used_at) : "—"}</td>
                  <td>{fmtDayTime(g.expires_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(g.grant_id)}
                    >
                      Disconnect <span className="sr-only">{g.client_name}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
