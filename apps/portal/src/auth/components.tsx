// SPDX-License-Identifier: Apache-2.0
// Sign-in building blocks shared by the sign-in page, the operator passkey step and the re-authentication dialog.

import type { ControlPlane } from "@usagemap/api-types";
import { useEffect, useId, useState } from "react";
import { api } from "../api/client.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { safeReturnTo } from "../lib/returnTo.ts";
import type { Session } from "./session.ts";
import {
  ACCOUNT_RE,
  normaliseSignature,
  normaliseXdr,
  passphraseFor,
  type StellarMethod,
  WALLETS,
  type WalletAdapter,
} from "./wallet.ts";
import {
  createPasskey,
  getPasskeyAssertion,
  webauthnAvailable,
  webauthnErrorMessage,
} from "./webauthn.ts";

/** Top-level navigation to the control plane's GitHub OAuth start (a GET that redirects to github.com). */
export function githubStartUrl(returnTo: string, link = false): string {
  const sp = new URLSearchParams({ return_to: safeReturnTo(returnTo) });
  if (link) sp.set("link", "true");
  return `/v1/auth/github/start?${sp.toString()}`;
}

export function GithubButton({ returnTo, label }: { returnTo: string; label?: string }) {
  return (
    <a className="button" href={githubStartUrl(returnTo)}>
      {label ?? "Sign in with GitHub"}
    </a>
  );
}

function useAvailableWallets(): WalletAdapter[] {
  const [found, setFound] = useState<WalletAdapter[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(WALLETS.map(async (w) => ((await w.available()) ? w : null))).then((r) => {
      if (live) setFound(r.filter((w): w is WalletAdapter => w !== null));
    });
    return () => {
      live = false;
    };
  }, []);
  return found;
}

type StellarChallenge = ControlPlane.StellarChallenge;
/** What the person sends back: a SEP-53 signature or a SEP-10 signed transaction. */
export type StellarProofBody =
  | { challenge_id: string; signature: string }
  | { challenge_id: string; signed_transaction_xdr: string };

/**
 * Proving control of a Stellar account, for sign-in (authStellar*) and for linking the project's account (L2,
 * verificationStellar*): the person picks SEP-53 (sign a message) or SEP-10 (sign a challenge transaction — hardware
 * wallets and multisig accounts, whose signatures must reach the medium threshold, C-19), asks the control plane for the
 * challenge, has it signed by a detected wallet or by any wallet/tool and pastes the result. The network is the
 * deployment's (C-114); the portal never chooses it.
 */
export function StellarProof({
  requestChallenge,
  submit,
  submitLabel,
  walletLabel,
  accountLabel = "Stellar account",
}: {
  requestChallenge: (account: string, method: StellarMethod) => Promise<StellarChallenge>;
  /** sends the proof for `account` (the account the challenge was issued for) */
  submit: (body: StellarProofBody, account: string) => Promise<void>;
  submitLabel: string;
  /** button text for a detected wallet, e.g. "Sign in with" → "Sign in with Freighter" */
  walletLabel: string;
  accountLabel?: string;
}) {
  const id = useId();
  const wallets = useAvailableWallets();
  const [method, setMethod] = useState<StellarMethod>("sep53");
  const [account, setAccount] = useState("");
  const [challenge, setChallenge] = useState<StellarChallenge | null>(null);
  const [proof, setProof] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const fetchChallenge = async (a: string): Promise<StellarChallenge> => {
    const c = await requestChallenge(a, method);
    if (method === "sep53" && !c.message)
      throw new Error("The service did not return a message to sign.");
    if (method === "sep10" && (!c.transaction_xdr || !c.network_passphrase))
      throw new Error("The service did not return a transaction to sign.");
    return c;
  };

  const getChallenge = (acct: string) =>
    run(async () => {
      const a = acct.trim();
      if (!ACCOUNT_RE.test(a))
        throw new Error("Enter a Stellar account id (it starts with G and has 56 characters).");
      const c = await fetchChallenge(a);
      setAccount(a);
      setChallenge(c);
    });

  const send = (raw: string) =>
    run(async () => {
      if (!challenge) return;
      await submit(
        challenge.method === "sep10"
          ? { challenge_id: challenge.challenge_id, signed_transaction_xdr: normaliseXdr(raw) }
          : { challenge_id: challenge.challenge_id, signature: normaliseSignature(raw) },
        account,
      );
      // a challenge is single use
      setChallenge(null);
      setProof("");
    });

  const withWallet = (w: WalletAdapter) =>
    run(async () => {
      const a = await w.getAccount();
      const c = await fetchChallenge(a);
      if (c.method === "sep10") {
        if (!w.signTransaction) throw new Error(`${w.name} cannot sign transactions here.`);
        const signed = await w.signTransaction(
          c.transaction_xdr as string,
          a,
          c.network_passphrase as string,
        );
        await submit({ challenge_id: c.challenge_id, signed_transaction_xdr: signed }, a);
        return;
      }
      const message = c.message as string;
      const sig = await w.signMessage(message, a, passphraseFor(message, c.network_passphrase));
      await submit({ challenge_id: c.challenge_id, signature: sig }, a);
    });

  return (
    <div className="stack">
      {!challenge ? (
        <fieldset>
          <legend>Signing method</legend>
          <label className="inline">
            <input
              type="radio"
              name={`${id}-method`}
              value="sep53"
              checked={method === "sep53"}
              onChange={() => setMethod("sep53")}
            />
            Sign a message (SEP-53)
          </label>
          <label className="inline">
            <input
              type="radio"
              name={`${id}-method`}
              value="sep10"
              checked={method === "sep10"}
              onChange={() => setMethod("sep10")}
            />
            Sign a challenge transaction (SEP-10) — hardware wallets and multisig accounts
          </label>
        </fieldset>
      ) : null}
      {wallets
        .filter((w) => method === "sep53" || w.signTransaction)
        .map((w) => (
          <p key={w.id}>
            <button type="button" disabled={busy} onClick={() => void withWallet(w)}>
              {walletLabel} {w.name}
            </button>
          </p>
        ))}
      {!challenge ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void getChallenge(account);
          }}
        >
          <label htmlFor={`${id}-acct`}>{accountLabel}</label>
          <div className="row">
            <input
              id={`${id}-acct`}
              name="account"
              autoComplete="off"
              spellCheck={false}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="G…"
              size={60}
            />
            <button type="submit" disabled={busy}>
              {method === "sep10" ? "Get transaction to sign" : "Get message to sign"}
            </button>
          </div>
          <p className="small muted">
            {method === "sep10"
              ? "Any wallet or tool that signs Stellar transactions works (for multisig accounts, collect enough signatures to reach the account's medium threshold); the transaction is never submitted to the network."
              : "Any wallet that can sign a message (SEP-53) works: sign the message shown next and paste the signature."}
          </p>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(proof);
          }}
        >
          {challenge.method === "sep10" ? (
            <>
              <p>
                Sign this challenge transaction with the account {account} on the network “
                {challenge.network_passphrase}”:
              </p>
              <pre className="code" data-testid="sep10-xdr">
                {challenge.transaction_xdr}
              </pre>
              <CopyButton text={challenge.transaction_xdr as string} label="Copy transaction" />
              <label htmlFor={`${id}-proof`}>Signed transaction (base64 XDR)</label>
            </>
          ) : (
            <>
              <p>Sign this message with the account {account}:</p>
              <pre className="code" data-testid="sep53-message">
                {challenge.message}
              </pre>
              <label htmlFor={`${id}-proof`}>Signature (base64 or hex)</label>
            </>
          )}
          <textarea
            id={`${id}-proof`}
            name="proof"
            spellCheck={false}
            value={proof}
            onChange={(e) => setProof(e.target.value)}
          />
          <div className="row">
            <button type="submit" disabled={busy || proof.trim() === ""}>
              {submitLabel}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setChallenge(null);
                setProof("");
              }}
            >
              Use another account
            </button>
          </div>
        </form>
      )}
      <ProblemAlert error={error} />
    </div>
  );
}

/** Sign-in with a Stellar account (SEP-53 or SEP-10) as the first factor. */
export function StellarSignIn({
  onSignedIn,
  submitLabel = "Sign in",
}: {
  onSignedIn: (s: Session) => void;
  submitLabel?: string;
}) {
  return (
    <StellarProof
      requestChallenge={(account, method) =>
        api.call("authStellarChallenge", { body: { account, method } })
      }
      submit={async (body) => onSignedIn(await api.call("authStellarVerify", { body }))}
      submitLabel={submitLabel}
      walletLabel="Sign in with"
    />
  );
}

/** Confirms the signed-in person with one of their passkeys; the session it returns carries the new validity. */
export function PasskeyConfirm({
  onDone,
  label = "Confirm with passkey",
}: {
  onDone: (s: Session) => void;
  label?: string;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!webauthnAvailable())
    return <p className="alert warn">This browser does not support passkeys.</p>;
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const options = await api.call("authPasskeyAssertionOptions", {});
            const body = await getPasskeyAssertion(options);
            onDone(await api.call("authPasskeyAssertionVerify", { body }));
          } catch (e) {
            setError(e instanceof DOMException ? new Error(webauthnErrorMessage(e)) : e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {label}
      </button>
      <ProblemAlert error={error} />
    </div>
  );
}

/** Registers a new passkey for the signed-in person (needs recent authentication, C-114). */
export function PasskeyRegister({
  onDone,
  buttonLabel = "Add a passkey",
}: {
  onDone: () => void;
  buttonLabel?: string;
}) {
  const id = useId();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!webauthnAvailable())
    return <p className="alert warn">This browser does not support passkeys.</p>;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const options = await api.call("authPasskeyRegistrationOptions", {});
          const body = await createPasskey(options, label.trim() || undefined);
          await api.call("authPasskeyRegistrationVerify", { body });
          setLabel("");
          onDone();
        } catch (err) {
          setError(err instanceof DOMException ? new Error(webauthnErrorMessage(err)) : err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={`${id}-label`}>Passkey name (optional)</label>
      <div className="row">
        <input
          id={`${id}-label`}
          maxLength={64}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. laptop"
        />
        <button type="submit" disabled={busy}>
          {buttonLabel}
        </button>
      </div>
      <ProblemAlert error={error} />
    </form>
  );
}
