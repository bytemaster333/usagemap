// SPDX-License-Identifier: Apache-2.0
// The sign-in screen's frame (approved sign-in design): a mode panel on the left (light for Stellar ecosystem projects, ink for
// SCF operators) and the sign-in card on the right. Used by /signin, /signin/passkey and the operator's
// "add a second passkey" gate.

import type { ReactNode } from "react";
import { Icon, type IconName } from "../../components/ui/basics.tsx";
import { Logo } from "../../components/ui/Logo.tsx";

export type AuthMode = "project" | "operator";

const FEATURES: Record<
  AuthMode,
  { icon: IconName; tone: "y" | "g" | "o"; title: string; text: string }[]
> = {
  project: [
    {
      icon: "lock",
      tone: "y",
      title: "Private by default",
      text: "Only your team sees your numbers.",
    },
    {
      icon: "shield",
      tone: "g",
      title: "Bots filtered, with reasons",
      text: "Verified and raw, side by side.",
    },
    { icon: "link", tone: "o", title: "Optional public proof", text: "Off until you turn it on." },
  ],
  operator: [
    {
      icon: "list",
      tone: "y",
      title: "Every project, side by side",
      text: "Compare, filter and sort the same metrics.",
    },
    {
      icon: "users",
      tone: "g",
      title: "Aggregates only",
      text: "Never individual visitors. Small groups stay hidden.",
    },
    {
      icon: "eyeoff",
      tone: "o",
      title: "Every view is audit-logged",
      text: "Who looked at what, and when.",
    },
  ],
};

function SidePanel({ mode }: { mode: AuthMode }) {
  const op = mode === "operator";
  return (
    <aside
      className="um-auth-side"
      aria-label={op ? "About the operator console" : "About UsageMap"}
    >
      <a className="um-logo" href="https://usagemap.dev/">
        <Logo inverse={op} label="UsageMap home" />
      </a>
      <div className="um-auth-side-body">
        {op ? (
          <h2>
            The SCF <span className="um-auth-hl">operator</span> console.
          </h2>
        ) : (
          <h2>
            Your project's <span className="um-auth-hl">private</span> analytics.
          </h2>
        )}
        <p>
          {op
            ? "One global view across every enrolled Stellar ecosystem project, for funding and ecosystem decisions. Each project still sees only its own data."
            : "Web, API and on-chain usage in one dashboard only your team can see. Share a public proof page when you choose."}
        </p>
        <ul className="um-auth-feat">
          {FEATURES[mode].map((f) => (
            <li key={f.title}>
              <span className={`um-auth-t um-auth-t--${f.tone}`}>
                <Icon name={f.icon} />
              </span>
              <div>
                <b>{f.title}</b>
                <span>{f.text}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="um-auth-side-foot">
        <a href="https://docs.usagemap.dev/privacy/">Privacy</a>
        <a href="https://status.usagemap.dev">Status</a>
        <a href="https://docs.usagemap.dev/">Docs</a>
        <span>EU hosted</span>
      </div>
    </aside>
  );
}

export function AuthFrame({
  mode,
  modeSwitch,
  children,
}: {
  mode: AuthMode;
  /** the "Ecosystem project | SCF operator" switch, shown above the card's content (sign-in page only) */
  modeSwitch?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={mode === "operator" ? "um-auth um-auth--operator" : "um-auth"}>
      <SidePanel mode={mode} />
      <main className="um-auth-main" id="main">
        <div className="um-auth-card">
          {modeSwitch}
          {children}
          <p className="um-auth-foot">
            By signing in you accept the{" "}
            <a href="https://docs.usagemap.dev/privacy/">privacy notes</a>. UsageMap stores no
            passwords.
          </p>
        </div>
      </main>
    </div>
  );
}

/** The two-way "Ecosystem project | SCF operator" switch (a radio group). */
export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: AuthMode;
  onChange: (m: AuthMode) => void;
}) {
  return (
    <fieldset className="um-auth-sw">
      <legend className="um-sr">Sign in as</legend>
      <span className="um-auth-knob" aria-hidden="true" />
      <label className="um-auth-opt">
        <input
          type="radio"
          name="um-auth-mode"
          value="project"
          checked={mode === "project"}
          onChange={() => onChange("project")}
        />
        <Icon name="code" />
        Ecosystem project
      </label>
      <label className="um-auth-opt">
        <input
          type="radio"
          name="um-auth-mode"
          value="operator"
          checked={mode === "operator"}
          onChange={() => onChange("operator")}
        />
        <Icon name="landmark" />
        SCF operator
      </label>
    </fieldset>
  );
}

/** Two-step progress list for passkey enrolment (first passkey, second passkey). */
export function PasskeyTrack({ count }: { count: number }) {
  const rows = [
    { n: 1, title: "First passkey", sub: "This device or a security key" },
    { n: 2, title: "Second passkey", sub: "Another device or security key" },
  ];
  return (
    <ol className="um-auth-track" aria-label="Operator passkeys">
      {rows.map((r) => {
        const done = count >= r.n;
        const now = !done && count === r.n - 1;
        return (
          <li key={r.n} className={done ? "is-done" : now ? "is-now" : undefined}>
            <span className="um-auth-n" aria-hidden="true">
              {done ? <Icon name="check" size="sm" /> : r.n}
            </span>
            <div>
              <b>{r.title}</b>
              <small>{r.sub}</small>
            </div>
            <span className={done ? "um-auth-chip um-auth-chip--ok" : "um-auth-chip"}>
              {done ? "Registered" : "Not added"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
