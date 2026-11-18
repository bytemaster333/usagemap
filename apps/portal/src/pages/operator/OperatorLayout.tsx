// SPDX-License-Identifier: Apache-2.0
// Frame of the SCF-operator console (operator.global-view-credentials): only for SCF operators, whose session is complete only after the
// passkey (C-09, enforced by the app shell); state-changing actions ask for a passkey step-up (auth/fresh.ts). Every
// read here is a cross-tenant read that the control plane writes to the audit log (C-17) — the audit page shows them.
// The ink operator shell (sidebar, "Every view is audit-logged") and the two-passkey gate (C-20) are drawn by
// components/AppShell.tsx; this layout only refuses accounts without the operator role.

import { Link, Outlet } from "@tanstack/react-router";
import { buttonClass, Icon } from "../../components/ui/basics.tsx";
import { useOperatorRole } from "./common.tsx";
import "./operator.css";

/** Live passkeys an SCF operator needs before the console opens (C-20; the control plane refuses operator calls). */
export const MIN_OPERATOR_PASSKEYS = 2;

const DEFAULT_SEARCH = {
  range: "30d" as const,
  variant: "verified" as const,
  min_level: "L1" as const,
  awarded: "any" as const,
  band: "any" as const,
  ids: [] as string[],
};

export function OperatorLayout() {
  const role = useOperatorRole();
  if (!role) {
    return (
      <section className="um-state" aria-labelledby="no-operator-access">
        <span className="um-state-ic">
          <Icon name="info" />
        </span>
        <h1 id="no-operator-access" className="um-h1">
          This account has no operator access
        </h1>
        <p className="um-state-d">
          The SCF operator console is only for designated SCF operators; access is granted by the
          UsageMap operator admin. You can still open the projects your account belongs to.
        </p>
        <div className="um-state-act">
          <Link to="/tenants" className={buttonClass("primary")}>
            Go to my projects
          </Link>
        </div>
      </section>
    );
  }
  return <Outlet />;
}

export { DEFAULT_SEARCH as OPERATOR_DEFAULT_SEARCH };
