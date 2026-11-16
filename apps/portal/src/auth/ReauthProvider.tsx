// SPDX-License-Identifier: Apache-2.0
// Recent authentication and step-up prompts (C-09, C-87, C-114). When an action answers `403 recent_auth_required`
// or `403 step_up_required`, the API client asks this provider; it opens a modal dialog that offers exactly the
// methods the control plane accepts for this person and, once one succeeds, the client repeats the action:
//   - step-up (SCF operators): a passkey assertion only;
//   - recent authentication of a member with a passkey: a passkey assertion only (C-87);
//   - recent authentication of a member without one: a new Stellar sign-in to the same account here, or a new GitHub
//     sign-in (which leaves the page; the person repeats the action after coming back).
// A 401 anywhere sends the person to the sign-in page and back to where they were.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, type ReauthKind } from "../api/client.ts";
import { GithubButton, PasskeyConfirm, StellarSignIn } from "./components.tsx";
import { SESSION_KEY, type Session, useMe, useSetSession } from "./session.ts";

type Pending = { kind: ReauthKind; resolve: (ok: boolean) => void };

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

const ReauthContext = createContext<(kind: ReauthKind) => Promise<boolean>>(async () => false);

/** Asks for a fresh sign-in before an action that is not an API call (e.g. linking GitHub, a top-level navigation). */
export function useRequestReauth() {
  return useContext(ReauthContext);
}

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const request = useCallback(
    (kind: ReauthKind) => new Promise<boolean>((resolve) => setPending({ kind, resolve })),
    [],
  );
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setSession = useSetSession();

  useEffect(() => {
    api.setHooks({
      reauthenticate: request,
      onUnauthenticated: () => {
        qc.setQueryData(SESSION_KEY, null);
        if (!window.location.pathname.startsWith("/signin"))
          void navigate({ to: "/signin", search: { return_to: currentPath() } });
      },
    });
    return () => api.setHooks({});
  }, [navigate, qc, request]);

  const finish = (ok: boolean, s?: Session) => {
    if (s) qc.setQueryData(SESSION_KEY, s);
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <ReauthContext.Provider value={request}>
      {children}
      {pending ? (
        <ReauthDialog
          kind={pending.kind}
          onDone={(s) => {
            const before = qc.getQueryData<Session | null>(SESSION_KEY);
            if (before && before.user_id !== s.user_id) {
              // Signed in as somebody else: drop everything cached for the previous account; do not repeat the action.
              setSession(s);
              pending.resolve(false);
              setPending(null);
              return;
            }
            // Same account: keep cached data, only the session's validity changed.
            finish(true, s);
          }}
          onCancel={() => finish(false)}
        />
      ) : null}
    </ReauthContext.Provider>
  );
}

function ReauthDialog({
  kind,
  onDone,
  onCancel,
}: {
  kind: ReauthKind;
  onDone: (s: Session) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const me = useMe();
  useEffect(() => {
    const d = ref.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }, []);
  const passkeyOnly = kind === "step_up_required" || (me.data?.passkey_count ?? 0) > 0;
  return (
    <dialog
      ref={ref}
      aria-labelledby="reauth-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="reauth-title">
        {kind === "step_up_required" ? "Confirm with your passkey" : "Confirm it is you"}
      </h2>
      <p>
        {kind === "step_up_required"
          ? "This SCF operator action needs a passkey confirmation from the last 10 minutes."
          : "This action changes how you sign in or removes data, so it needs a fresh sign-in from the last 10 minutes."}
      </p>
      {me.isLoading && kind !== "step_up_required" ? (
        <p>Loading…</p>
      ) : passkeyOnly ? (
        <PasskeyConfirm onDone={onDone} />
      ) : (
        <div className="stack">
          <h3>Sign in again with your Stellar wallet</h3>
          <StellarSignIn onSignedIn={onDone} submitLabel="Confirm" />
          <h3>Or sign in again with GitHub</h3>
          <p className="small muted">You will come back to this page; then repeat the action.</p>
          <GithubButton returnTo={currentPath()} label="Sign in again with GitHub" />
        </div>
      )}
      <p>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </dialog>
  );
}
