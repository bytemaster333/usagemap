// SPDX-License-Identifier: Apache-2.0
// Sign-in (approved sign-in design): one page, two modes — "Ecosystem project" | "SCF operator" (/signin?as=operator
// preselects the operator mode). The mode only picks where the person goes afterwards; access always comes from the
// server-side role (Session.platform_role). A non-operator who chose the operator mode sees a neutral "no operator
// access" screen.
//   - Ecosystem project (Stellar ecosystem projects): passkey (planned first-factor contract, isolated in auth/passkeyLogin.ts), Freighter (SEP-53,
//     with the hand-signing form for any other wallet or tool, SEP-53 or SEP-10) or GitHub.
//   - SCF operator: passkey only. TEMP until passkey login is live in the control plane: GitHub or a Stellar wallet as
//     the first factor, then the passkey on /signin/passkey (C-09).
// Claiming a project happens after sign-in ("Find your project"), never here. Nothing here says whether an account
// exists.

import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { githubStartUrl, StellarSignIn } from "../auth/components.tsx";
import {
  PasskeyLoginRefused,
  PasskeyLoginUnavailable,
  passkeyLogin,
} from "../auth/passkeyLogin.ts";
import { type Session, useSession, useSetSession } from "../auth/session.ts";
import { passphraseFor, WALLETS } from "../auth/wallet.ts";
import { webauthnAvailable, webauthnErrorMessage } from "../auth/webauthn.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { buttonClass, Icon } from "../components/ui/basics.tsx";
import { safeReturnTo } from "../lib/returnTo.ts";
import { AuthFrame, type AuthMode, ModeSwitch } from "./auth/AuthFrame.tsx";

type View = "methods" | "wallet" | "no-access";

export const isOperatorSession = (s: Session) =>
  s.platform_role === "operator" || s.platform_role === "operator_admin";

/** Freighter (SEP-53), with the hand-signing form for any other wallet or tool. */
function WalletSignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const freighter = WALLETS.find((w) => w.id === "freighter");
  const [found, setFound] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    let live = true;
    // Without the extension Freighter's library may never answer; no answer within 1.5 s means "not installed".
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 1500));
    void Promise.race([freighter?.available() ?? Promise.resolve(false), timeout]).then((ok) => {
      if (!live) return;
      setFound(ok);
      if (!ok) setMoreOpen(true);
    });
    return () => {
      live = false;
    };
  }, [freighter]);

  const signIn = async () => {
    if (!freighter) return;
    setBusy(true);
    setError(null);
    try {
      const account = await freighter.getAccount();
      const c = await api.call("authStellarChallenge", { body: { account, method: "sep53" } });
      const message = c.message as string;
      const signature = await freighter.signMessage(
        message,
        account,
        passphraseFor(message, c.network_passphrase),
      );
      onSignedIn(
        await api.call("authStellarVerify", { body: { challenge_id: c.challenge_id, signature } }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="um-auth-wait" aria-live="polite">
        <span className="um-auth-mi um-auth-mi--org um-auth-mi--lg">
          <Icon name="freighter" />
        </span>
        <div>
          <b>
            {found === false
              ? "Freighter is not installed"
              : busy
                ? "Waiting for Freighter…"
                : found
                  ? "Freighter is ready"
                  : "Looking for Freighter…"}
          </b>
          <small>
            {found === false
              ? "Install the extension, or sign the message with another wallet below."
              : "You approve a short sign-in message in the Freighter pop-up."}
          </small>
        </div>
        {busy || found === null ? <span className="um-auth-spin" aria-hidden="true" /> : null}
      </div>
      {found ? (
        <button
          type="button"
          className={buttonClass("primary", { block: true })}
          disabled={busy}
          onClick={() => void signIn()}
        >
          Sign with Freighter
          <Icon name="arrow" />
        </button>
      ) : null}
      <ProblemAlert error={error} />
      <details
        className="um-auth-more"
        open={moreOpen}
        onToggle={(e) => setMoreOpen(e.currentTarget.open)}
      >
        <summary>
          <Icon name="chev" size="sm" />
          Sign with another wallet or tool
        </summary>
        <div className="um-auth-more-b">
          <StellarSignIn onSignedIn={onSignedIn} />
        </div>
      </details>
      {found === false ? (
        <p className="um-auth-note">
          No Freighter yet? <a href="https://www.freighter.app/">Get the extension</a>, then reload
          this page.
        </p>
      ) : null}
    </>
  );
}

export function SignInPage() {
  const search = useSearch({ from: "/signin" });
  const [mode, setMode] = useState<AuthMode>(search.as === "operator" ? "operator" : "project");
  const [view, setView] = useState<View>(search.method === "wallet" ? "wallet" : "methods");
  const [pkError, setPkError] = useState<unknown>(null);
  const [pkBusy, setPkBusy] = useState(false);
  const session = useSession();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const op = mode === "operator";
  useTitle(op ? "Operator sign-in" : "Sign in");
  const returnTo = safeReturnTo(search.return_to, op ? "/operator" : "/tenants");

  // A session decides where to go: an unfinished operator sign-in → the passkey step; operator mode without the role
  // → the neutral "no operator access" screen; everything else → where the person was going.
  useEffect(() => {
    const s = session.data;
    if (!s) return;
    if (!s.complete) {
      void navigate({ to: "/signin/passkey", search: { return_to: returnTo }, replace: true });
      return;
    }
    if (mode === "operator" && !isOperatorSession(s)) {
      setView("no-access");
      return;
    }
    void navigate({ href: returnTo, replace: true });
  }, [session.data, navigate, returnTo, mode]);

  const pick = (m: AuthMode) => {
    setMode(m);
    setView("methods");
    setPkError(null);
    const { as: _as, ...rest } = search;
    void navigate({
      to: "/signin",
      search: m === "operator" ? { ...rest, as: "operator" } : rest,
      replace: true,
    });
  };

  const withPasskey = async () => {
    setPkBusy(true);
    setPkError(null);
    try {
      setSession(await passkeyLogin(mode));
    } catch (e) {
      if (e instanceof PasskeyLoginUnavailable)
        setPkError(
          new Error(
            op
              ? "Passkey sign-in is not switched on yet. For now, sign in with GitHub or a Stellar wallet below, then confirm with your passkey."
              : "Passkey sign-in is not switched on yet. Use Freighter or GitHub for now.",
          ),
        );
      else if (e instanceof PasskeyLoginRefused) setPkError(e);
      else setPkError(e instanceof DOMException ? new Error(webauthnErrorMessage(e)) : e);
    } finally {
      setPkBusy(false);
    }
  };

  const canPasskey = webauthnAvailable();
  const signOut = async () => {
    try {
      await api.call("authLogout", {});
    } finally {
      setSession(null);
      setView("methods");
    }
  };

  let body: ReactNode;
  if (view === "no-access") {
    body = (
      <section className="um-auth-view" aria-labelledby="um-auth-na">
        <span className="um-auth-big">
          <Icon name="info" />
        </span>
        <div className="um-auth-hd">
          <h1 id="um-auth-na">This account has no operator access</h1>
          <p>
            Operator access is granted by the UsageMap operator admin. You can still open the
            projects your account belongs to.
          </p>
        </div>
        <div className="um-auth-row">
          <a className={buttonClass("primary")} href="/tenants">
            Go to my projects
            <Icon name="arrow" />
          </a>
          <button type="button" className={buttonClass("secondary")} onClick={() => void signOut()}>
            Use another account
          </button>
        </div>
      </section>
    );
  } else if (view === "wallet") {
    body = (
      <section className="um-auth-view" aria-labelledby="um-auth-w">
        <button type="button" className="um-auth-back" onClick={() => setView("methods")}>
          <Icon name="back" size="sm" /> All sign-in options
        </button>
        <div className="um-auth-hd">
          <h1 id="um-auth-w">Sign in with your Stellar wallet</h1>
          <p>You sign a short message. It costs nothing and moves no funds.</p>
        </div>
        <WalletSignIn onSignedIn={(s) => setSession(s)} />
      </section>
    );
  } else if (op) {
    body = (
      <section className="um-auth-view" aria-labelledby="um-auth-op">
        <div className="um-auth-hd">
          <h1 id="um-auth-op">Operator console</h1>
          <p>
            For designated SCF operators. Your access must first be enabled by the UsageMap team,
            and two registered passkeys are required.
          </p>
        </div>
        <button
          type="button"
          className="um-auth-pk"
          disabled={pkBusy || !canPasskey}
          onClick={() => void withPasskey()}
        >
          <span className="um-auth-mi">
            <Icon name="passkey" />
          </span>
          <span className="um-auth-tx">
            <b>Sign in with passkey</b>
            <small>
              {canPasskey
                ? "Passkey only. No e-mail, no wallet."
                : "This browser does not support passkeys."}
            </small>
          </span>
          <Icon name="arrow" className="um-auth-go" />
        </button>
        <ProblemAlert error={pkError} />
        {/* TEMP until passkey login is live in the control plane (auth/passkeyLogin.ts, SWAP): the first factor
            here, then the passkey on /signin/passkey. Remove this block when operators sign in with the passkey. */}
        <details className="um-auth-more" data-testid="operator-temp-fallback">
          <summary>
            <Icon name="chev" size="sm" />
            Sign in with your first factor instead
            <span className="um-auth-temp">For now</span>
          </summary>
          <div className="um-auth-more-b">
            <div className="um-auth-row">
              <a
                className={buttonClass("secondary", { size: "sm" })}
                href={githubStartUrl(returnTo)}
              >
                <Icon name="github" />
                Sign in with GitHub
              </a>
              <button
                type="button"
                className={buttonClass("secondary", { size: "sm" })}
                onClick={() => setView("wallet")}
              >
                <Icon name="wallet" />
                Stellar wallet
              </button>
            </div>
            <p className="um-auth-note">You confirm with your passkey on the next screen.</p>
          </div>
        </details>
        <p className="um-auth-note">
          Not an operator?{" "}
          <button type="button" className="um-auth-linkbtn" onClick={() => pick("project")}>
            Switch to Ecosystem project
          </button>
          . Operator access can't be requested here.
        </p>
      </section>
    );
  } else {
    body = (
      <section className="um-auth-view" aria-labelledby="um-auth-pr">
        <div className="um-auth-hd">
          <h1 id="um-auth-pr">Sign in to your project</h1>
          <p>
            No passwords. After you sign in, you find your Stellar ecosystem project or open the one
            you already have.
          </p>
        </div>
        <div className="um-auth-methods">
          <a className="um-auth-btn um-auth-btn--primary" href={githubStartUrl(returnTo)}>
            <span className="um-auth-mi um-auth-mi--y">
              <Icon name="github" />
            </span>
            <span className="um-auth-tx">
              <b>Sign in with GitHub</b>
              <small>Read-only access to your public profile</small>
            </span>
            <Icon name="arrow" className="um-auth-go" />
          </a>
          {/* Passkey and Freighter open later; the wallet form stays reachable at /signin?method=wallet. */}
          <button type="button" className="um-auth-btn um-auth-btn--soon" disabled>
            <span className="um-auth-mi um-auth-mi--soft">
              <Icon name="passkey" />
            </span>
            <span className="um-auth-tx">
              <b>
                Passkey <span className="um-auth-tag um-auth-tag--soon">Soon</span>
              </b>
              <small>Face, fingerprint or security key</small>
            </span>
          </button>
          <button type="button" className="um-auth-btn um-auth-btn--soon" disabled>
            <span className="um-auth-mi um-auth-mi--soft">
              <Icon name="freighter" />
            </span>
            <span className="um-auth-tx">
              <b>
                Freighter <span className="um-auth-tag um-auth-tag--soon">Soon</span>
              </b>
              <small>Sign a message with your Stellar wallet · SEP-53</small>
            </span>
          </button>
        </div>
        <ProblemAlert error={pkError} />
      </section>
    );
  }

  return (
    <AuthFrame
      mode={mode}
      modeSwitch={view === "no-access" ? null : <ModeSwitch mode={mode} onChange={pick} />}
    >
      {body}
    </AuthFrame>
  );
}
