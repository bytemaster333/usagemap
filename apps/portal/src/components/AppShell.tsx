// SPDX-License-Identifier: Apache-2.0
// Signed-in frame (approved dashboard designs): a full-viewport app shell — fixed left sidebar (logo, navigation,
// account at the bottom), slim top bar, and the content pane, which is the only thing that scrolls. Phones get the
// sidebar as a drawer. Two variants:
//   - project: light sidebar; top bar with the project switcher, the "Private · only your team" chip and a slot for
//     the page's range picker (<TopBarSlot>);
//   - operator (/operator/* for an SCF operator): ink sidebar with the yellow "SCF operator" tag, "Switch to my
//     projects", and "Every view is audit-logged" under the content.
// Requires a complete session (an SCF operator's sign-in is complete only after the passkey, C-09); the operator
// console additionally needs two passkeys (C-20).

import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.ts";
import { type Session, useMe, useSession, useSetSession } from "../auth/session.ts";
import { safeReturnTo } from "../lib/returnTo.ts";
import { SecondPasskeyScreen } from "../pages/auth/SecondPasskey.tsx";
import { MIN_OPERATOR_PASSKEYS } from "../pages/operator/OperatorLayout.tsx";
import { OperatorNav, ProjectNav, useOperatorPage } from "./shell/nav.tsx";
import { ProjectSwitcher, roleLabel } from "./shell/ProjectSwitcher.tsx";
import { TopBarSlotContext } from "./shell/TopBarSlot.tsx";
import { Icon, PrivateChip } from "./ui/basics.tsx";
import { Logo } from "./ui/Logo.tsx";
import { ErrorState, LoadingState } from "./ui/states.tsx";

export function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · UsageMap`;
  }, [title]);
}

export function useTenants(enabled = true) {
  return useQuery({
    queryKey: ["tenants"],
    queryFn: () => api.call("listMyTenants", {}),
    enabled,
  });
}

const isOperator = (s: Session | null | undefined) =>
  !!s && (s.platform_role === "operator" || s.platform_role === "operator_admin");

function initials(name: string | undefined): string {
  if (!name) return "·";
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0] ?? "";
  if (parts.length >= 2)
    return `${first[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return first.slice(0, 2).toUpperCase() || "·";
}

/** True below the drawer breakpoint (keeps the closed drawer out of the tab order there). */
function usePhone(): boolean {
  const q = "(max-width: 900px)";
  const [phone, setPhone] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

function useSignOut() {
  const setSession = useSetSession();
  const navigate = useNavigate();
  return async () => {
    try {
      await api.call("authLogout", {});
    } finally {
      setSession(null);
      void navigate({ to: "/signin", search: {} });
    }
  };
}

export function AppShell() {
  const session = useSession();
  const path = useLocation({ select: (l) => l.pathname });
  const operatorView = isOperator(session.data) && path.startsWith("/operator");
  const me = useMe(!!session.data?.complete);
  // The committed browser location, not the router's pending one: while a redirect to /signin is pending, the pending
  // location would itself become the return_to of the next redirect (and grow without end).
  const returnTo = safeReturnTo(window.location.pathname + window.location.search, "/tenants");

  if (session.isLoading)
    return (
      <div className="um-page">
        <LoadingState label="Signing you in…" />
      </div>
    );
  if (session.error) {
    return (
      <main className="um-main um-page" id="main">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </main>
    );
  }
  if (!session.data) return <Navigate to="/signin" search={{ return_to: returnTo }} replace />;
  if (!session.data.complete)
    return <Navigate to="/signin/passkey" search={{ return_to: returnTo }} replace />;

  const passkeys = me.data?.passkey_count;
  // The console's pages call operator operations, which the control plane refuses below two passkeys (C-20): wait
  // for the count before rendering them.
  if (operatorView && me.isPending)
    return (
      <div className="um-page">
        <LoadingState label="Opening the operator console…" />
      </div>
    );
  if (operatorView && passkeys !== undefined && passkeys < MIN_OPERATOR_PASSKEYS)
    return <SecondPasskeyScreen passkeys={passkeys} />;

  // Onboarding (Find your project → … → First event) is a full-screen flow without the dashboard shell; its pages
  // render their own frame (pages/onboard/OnboardFrame.tsx).
  if (!operatorView && /^\/(onboard|t\/[^/]+\/onboard\/)/.test(path)) return <Outlet />;
  return <Frame variant={operatorView ? "operator" : "project"} session={session.data} />;
}

function Frame({ variant, session }: { variant: "project" | "operator"; session: Session }) {
  const op = variant === "operator";
  const params = useParams({ strict: false }) as { tenantId?: string };
  const path = useLocation({ select: (l) => l.pathname });
  const tenants = useTenants(!op);
  const me = useMe();
  const signOut = useSignOut();
  const phone = usePhone();
  const [drawer, setDrawer] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const opPage = useOperatorPage();

  // Close the drawer and start each page at the top when the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route change only
  useEffect(() => {
    setDrawer(false);
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [path]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawer(false);
        menuBtn.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  const current = tenants.data?.find((t) => t.tenant_id === params.tenantId);
  const name = me.data?.display_name;
  const roleLine = op
    ? `${session.platform_role === "operator_admin" ? "Operator admin" : "Operator"}${
        me.data ? ` · ${me.data.passkey_count} passkeys` : ""
      }`
    : current
      ? roleLabel(current.role)
      : isOperator(session)
        ? "SCF operator"
        : "Signed in";

  return (
    <div className={op ? "um-shell um-shell--operator" : "um-shell"}>
      <a className="um-skip" href="#main">
        Skip to content
      </a>
      <aside
        id="um-side"
        className={drawer ? "um-side um-side--open" : "um-side"}
        aria-label={op ? "Operator navigation" : "Project navigation"}
        inert={phone && !drawer ? true : undefined}
      >
        <div className="um-side-top">
          {op ? (
            <Link
              to="/operator/overview"
              search={{
                range: "30d",
                variant: "verified",
                min_level: "L1",
                awarded: "any",
                band: "any",
                ids: [],
              }}
              className="um-logo"
            >
              <Logo inverse label="UsageMap operator home" />
            </Link>
          ) : (
            <Link to="/tenants" className="um-logo">
              <Logo label="UsageMap home" />
            </Link>
          )}
          {op ? (
            <span className="um-optag">
              <Icon name="shield" />
              SCF operator
            </span>
          ) : null}
        </div>
        {op ? <OperatorNav /> : <ProjectNav tenantId={params.tenantId} />}
        <div className="um-side-foot">
          <div className="um-me" data-testid={op ? "operator-banner" : "account-block"}>
            <span className="um-me-av" aria-hidden="true">
              {initials(name)}
            </span>
            <div className="um-me-t">
              <b>{name ?? "Your account"}</b>
              <small>{roleLine}</small>
            </div>
          </div>
          {op ? (
            <Link to="/tenants" className="um-side-link">
              <Icon name="swap" />
              Switch to my projects
            </Link>
          ) : isOperator(session) ? (
            <Link
              to="/operator/overview"
              search={{
                range: "30d",
                variant: "verified",
                min_level: "L1",
                awarded: "any",
                band: "any",
                ids: [],
              }}
              className="um-side-link"
            >
              <Icon name="landmark" />
              SCF operator console
            </Link>
          ) : null}
          <Link to="/account" className="um-side-link">
            <Icon name="gear" />
            Account
          </Link>
          <button type="button" className="um-side-link" onClick={() => void signOut()}>
            <Icon name="logout" />
            Sign out
          </button>
        </div>
      </aside>
      {drawer ? (
        <button
          type="button"
          className="um-scrim"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setDrawer(false)}
        />
      ) : null}
      <div className="um-col">
        <header className="um-top">
          <button
            ref={menuBtn}
            type="button"
            className="um-menu-btn"
            aria-label={drawer ? "Close menu" : "Open menu"}
            aria-controls="um-side"
            aria-expanded={drawer}
            onClick={() => setDrawer((d) => !d)}
          >
            <Icon name={drawer ? "x" : "menu"} />
          </button>
          {op ? (
            <p className="um-top-t">
              {opPage ? <span className="um-top-crumb">{opPage.group}</span> : null}
              <span className="um-top-title">{opPage?.label ?? "Operator console"}</span>
            </p>
          ) : (
            <>
              <ProjectSwitcher tenants={tenants.data} currentId={params.tenantId} />
              <PrivateChip />
            </>
          )}
          <span className="um-top-grow" />
          <div className="um-top-slot" ref={setSlot} />
        </header>
        <main className="um-main" id="main" tabIndex={-1} ref={mainRef}>
          <TopBarSlotContext.Provider value={slot}>
            <div className="um-page">
              <Outlet />
            </div>
          </TopBarSlotContext.Provider>
          {op ? (
            <footer className="um-main-foot">
              <span className="um-audit">
                <Icon name="filecheck" />
                Every view is audit-logged.
              </span>
              <p>Operators see per-project aggregates, never individual visitors.</p>
            </footer>
          ) : null}
        </main>
      </div>
    </div>
  );
}
