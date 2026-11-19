// SPDX-License-Identifier: Apache-2.0
// Account: sign-in identities (GitHub, Stellar) and passkeys. Linking an identity, registering and removing a passkey
// need recent authentication (C-114; SCF operators: step-up); the API client asks for it when the control plane
// answers 403, and linking GitHub (a top-level navigation) asks before leaving the page.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api/client.ts";
import { githubStartUrl, PasskeyRegister } from "../auth/components.tsx";
import { useRequestReauth } from "../auth/ReauthProvider.tsx";
import { recentAuthValid, useMe, useSession } from "../auth/session.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { Button, Card, PageHeader } from "../components/ui/basics.tsx";
import { TableScroll } from "../components/ui/controls.tsx";
import { fmtDay, fmtDayTime } from "../lib/format.ts";

export function AccountPage() {
  useTitle("Account");
  const qc = useQueryClient();
  const session = useSession();
  const me = useMe();
  const requestReauth = useRequestReauth();
  const identities = useQuery({
    queryKey: ["identities"],
    queryFn: () => api.call("listMyIdentities", {}),
  });
  const passkeys = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => api.call("listMyPasskeys", {}),
  });
  const [error, setError] = useState<unknown>(null);
  const s = session.data;
  const reauthUntil = s?.kind === "operator" ? s.step_up_valid_until : s?.recent_auth_valid_until;

  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e);
    }
  };

  const shortName = me.data?.display_name;
  return (
    <>
      <PageHeader
        title="Your account"
        sub={
          me.data
            ? `${shortName} · member since ${fmtDay(me.data.created_at)}`
            : "Sign-in identities and passkeys"
        }
      />
      <ProblemAlert error={me.error ?? error} />
      {me.data ? (
        <Card title="Signed in" icon="lock">
          {me.data.platform_role ? (
            <p>
              SCF operator role:{" "}
              {me.data.platform_role === "operator_admin" ? "Operator admin" : "Operator"}
            </p>
          ) : null}
          <p className="um-muted">
            {reauthUntil && recentAuthValid(s)
              ? `Sensitive changes are allowed until ${fmtDayTime(reauthUntil)} without signing in again.`
              : "Sensitive changes (identities, passkeys) will ask you to confirm it is you."}
          </p>
        </Card>
      ) : null}

      <Card
        title="Sign-in identities"
        sub="The accounts you can sign in with"
        icon="fingerprint"
        flush
        actions={
          <Button
            size="sm"
            icon="github"
            onClick={async () => {
              if (!recentAuthValid(session.data)) {
                const ok = await requestReauth(
                  session.data?.kind === "operator" ? "step_up_required" : "recent_auth_required",
                );
                if (!ok) return;
              }
              window.location.assign(githubStartUrl("/account", true));
            }}
          >
            Link a GitHub account
          </Button>
        }
      >
        <ProblemAlert error={identities.error} />
        <TableScroll label="Sign-in identities">
          <table className="um-table">
            <caption className="um-sr">Sign-in identities</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Account</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="um-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(identities.data ?? []).map((i) => (
                <tr key={i.identity_id}>
                  <td>{i.provider === "github" ? "GitHub" : "Stellar"}</td>
                  <td>
                    <code className="um-acct-id">{i.display}</code>
                  </td>
                  <td>{i.last_used_at ? fmtDay(i.last_used_at) : "—"}</td>
                  <td className="um-r">
                    <Button
                      size="sm"
                      disabled={(identities.data?.length ?? 0) < 2}
                      onClick={() =>
                        act(async () => {
                          await api.call("unlinkIdentity", {
                            path: { identityId: i.identity_id },
                          });
                          await qc.invalidateQueries({ queryKey: ["identities"] });
                        })
                      }
                    >
                      Unlink {i.provider === "github" ? "GitHub" : "Stellar"} identity
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Card>

      <Card
        title="Passkeys"
        sub="Passkeys confirm sensitive actions. Once you have one, only a passkey counts as a fresh sign-in."
        icon="passkey"
      >
        <ProblemAlert error={passkeys.error} />
        {passkeys.data && passkeys.data.length === 0 ? (
          <p className="um-muted">No passkeys registered.</p>
        ) : null}
        {passkeys.data && passkeys.data.length > 0 ? (
          <TableScroll label="Passkeys">
            <table className="um-table">
              <caption className="um-sr">Passkeys</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Added</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="um-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {passkeys.data.map((p) => (
                  <tr key={p.credential_id}>
                    <td>{p.label ?? "Passkey"}</td>
                    <td>{fmtDay(p.created_at)}</td>
                    <td>{p.last_used_at ? fmtDay(p.last_used_at) : "—"}</td>
                    <td className="um-r">
                      <Button
                        size="sm"
                        onClick={() =>
                          act(async () => {
                            await api.call("deletePasskey", {
                              path: { credentialId: p.credential_id },
                            });
                            await qc.invalidateQueries({ queryKey: ["passkeys"] });
                            await qc.invalidateQueries({ queryKey: ["me"] });
                          })
                        }
                      >
                        Remove {p.label ?? "passkey"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        ) : null}
        <PasskeyRegister
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ["passkeys"] });
            void qc.invalidateQueries({ queryKey: ["me"] });
          }}
        />
      </Card>

      <Card title="Connected apps" icon="plug">
        <p>
          AI assistants you connected with OAuth (such as claude.ai or Claude Desktop) read one
          project, read-only. See or disconnect them on <Link to="/oauth/apps">Connected apps</Link>
          .
        </p>
      </Card>
    </>
  );
}
