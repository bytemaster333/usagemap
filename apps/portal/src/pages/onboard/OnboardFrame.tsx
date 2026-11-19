// SPDX-License-Identifier: Apache-2.0
// The full-screen onboarding frame (approved design): logo, the privacy chip and either "Signed in as … · Sign out"
// (an account without a project yet) or "Back to my dashboard" (claiming another project from the switcher), the five
// steps — Find your project · Prove it · Framework · Your snippet · First event — and a scrolling body. Rendered by
// AppShell instead of the dashboard shell for /onboard and /t/:id/onboard/kit.

import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { api } from "../../api/client.ts";
import { useMe, useSetSession } from "../../auth/session.ts";
import { useTenants } from "../../components/AppShell.tsx";
import { Icon, Logo, PrivateChip, Steps } from "../../components/ui/index.ts";
import "../project/project.css";

export const ONBOARD_STEPS = [
  "Find your project",
  "Prove it",
  "Framework",
  "Your snippet",
  "First event",
];

export function OnboardFrame({
  step,
  allDone = false,
  children,
  onStep,
}: {
  /** 1-based */
  step: number;
  allDone?: boolean;
  children: ReactNode;
  onStep?: ((n: number) => void) | undefined;
}) {
  const tenants = useTenants();
  const me = useMe();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const first = tenants.data?.[0];
  const hasProjects = (tenants.data?.length ?? 0) > 0;
  const name = me.data?.display_name ?? "your account";
  useEffect(() => {
    document.documentElement.classList.add("um-onb-doc");
    return () => document.documentElement.classList.remove("um-onb-doc");
  }, []);
  const signOut = async () => {
    try {
      await api.call("authLogout", {});
    } finally {
      setSession(null);
      void navigate({ to: "/signin", search: {} });
    }
  };
  return (
    <div className="um-onb">
      <a className="um-skip" href="#onb-main">
        Skip to content
      </a>
      <header className="um-onb-head">
        <div className="um-onb-top">
          <Link to="/tenants" className="um-logo um-onb-logo">
            <Logo label="UsageMap home" />
          </Link>
          <PrivateChip />
          <span className="um-onb-grow" />
          {hasProjects && first ? (
            <Link
              to="/t/$tenantId"
              params={{ tenantId: first.tenant_id }}
              search={{}}
              className="um-onb-later"
            >
              <Icon name="back" size="sm" />
              Back to my dashboard
            </Link>
          ) : (
            <span className="um-onb-later">
              <span className="um-onb-who">
                Signed in as <b>{name}</b>
              </span>
              <button type="button" className="um-onb-out" onClick={() => void signOut()}>
                Sign out
              </button>
            </span>
          )}
        </div>
        <div className="um-onb-steps">
          <Steps
            items={ONBOARD_STEPS}
            current={step}
            allDone={allDone}
            label="Onboarding steps"
            onSelect={onStep}
          />
        </div>
      </header>
      <main className="um-onb-scroll" id="onb-main" tabIndex={-1}>
        <div className="um-onb-body">{children}</div>
      </main>
    </div>
  );
}

export function OnboardHead({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="um-onb-h">
      <span className="um-label">{label}</span>
      <h1>{title}</h1>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
