// SPDX-License-Identifier: Apache-2.0
// Second step of an SCF operator's sign-in (C-09, operator.global-view-credentials): the session stays partial until a passkey assertion. An
// operator without a passkey enrols the first one here; the control plane allows that only within 10 minutes of the
// first factor (C-114). Drawn in the sign-in design's operator mode.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client.ts";
import { PasskeyRegister } from "../auth/components.tsx";
import { useSession, useSetSession } from "../auth/session.ts";
import { getPasskeyAssertion, webauthnAvailable, webauthnErrorMessage } from "../auth/webauthn.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { Icon } from "../components/ui/basics.tsx";
import { LoadingState } from "../components/ui/states.tsx";
import { safeReturnTo } from "../lib/returnTo.ts";
import { AuthFrame, PasskeyTrack } from "./auth/AuthFrame.tsx";

export function PasskeyStepPage() {
  useTitle("Confirm with your passkey");
  const search = useSearch({ from: "/signin/passkey" });
  const returnTo = safeReturnTo(search.return_to, "/tenants");
  const navigate = useNavigate();
  const session = useSession();
  const setSession = useSetSession();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // A partial session may call only session, logout and passkey operations (C-113): whether the operator already
  // has a passkey is learnt from the assertion options (409 = none registered).
  const hasPasskey = useQuery({
    queryKey: ["passkey-step-probe", session.data?.user_id],
    enabled: !!session.data && !session.data.complete,
    queryFn: async () => {
      try {
        await api.call("authPasskeyAssertionOptions", {});
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return false;
        throw e;
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  useEffect(() => {
    if (session.isLoading) return;
    if (!session.data)
      void navigate({ to: "/signin", search: { return_to: returnTo }, replace: true });
    else if (session.data.complete) void navigate({ href: returnTo, replace: true });
  }, [session.data, session.isLoading, navigate, returnTo]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.call("authPasskeyAssertionOptions", {});
      const body = await getPasskeyAssertion(options);
      setSession(await api.call("authPasskeyAssertionVerify", { body }));
    } catch (e) {
      setError(e instanceof DOMException ? new Error(webauthnErrorMessage(e)) : e);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await api.call("authLogout", {});
    } finally {
      setSession(null);
      void navigate({ to: "/signin", search: {} });
    }
  };

  const supported = webauthnAvailable();

  return (
    <AuthFrame mode="operator">
      {hasPasskey.data === false ? (
        <section className="um-auth-view" aria-labelledby="um-pk-enrol">
          <div className="um-auth-hd">
            <h1 id="um-pk-enrol">Register your first passkey</h1>
            <p>
              SCF operator accounts sign in with a passkey. Register one on this device now; this is
              possible only within 10 minutes of signing in.
            </p>
          </div>
          <PasskeyTrack count={0} />
          <PasskeyRegister
            buttonLabel="Register passkey"
            onDone={() => {
              void hasPasskey.refetch();
            }}
          />
        </section>
      ) : (
        <section className="um-auth-view" aria-labelledby="um-pk-confirm">
          <div className="um-auth-hd">
            <h1 id="um-pk-confirm">Confirm with your passkey</h1>
            <p>
              SCF operator accounts need a passkey at every sign-in. Your session is complete once
              you confirm with it.
            </p>
          </div>
          {hasPasskey.isPending && session.data ? (
            <LoadingState label="Checking your passkeys…" />
          ) : null}
          {hasPasskey.data === true ? (
            supported ? (
              <button
                type="button"
                className="um-auth-pk"
                disabled={busy}
                onClick={() => void confirm()}
              >
                <span className="um-auth-mi">
                  <Icon name="passkey" />
                </span>
                <span className="um-auth-tx">
                  <b>Confirm with passkey</b>
                  <small>Face, fingerprint or security key</small>
                </span>
                <Icon name="arrow" className="um-auth-go" />
              </button>
            ) : (
              <p className="um-note um-note--warn">This browser does not support passkeys.</p>
            )
          ) : null}
          <ProblemAlert error={error ?? hasPasskey.error} />
        </section>
      )}
      <p className="um-auth-note">
        Not you, or the wrong account?{" "}
        <button type="button" className="um-auth-linkbtn" onClick={() => void cancel()}>
          Cancel and sign out
        </button>
      </p>
    </AuthFrame>
  );
}
