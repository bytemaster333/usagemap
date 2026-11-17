// SPDX-License-Identifier: Apache-2.0
// The project switcher in the project top bar: the current project (name, your role, slug) and a list of your other
// projects, plus "Claim another project" (the registry search at /onboard). A disclosure (button + list of links),
// closed by Escape, a click outside or a navigation.

import { Link, useLocation } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../ui/basics.tsx";

type Membership = ControlPlane.TenantMembershipSummary;

const ROLE: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export const roleLabel = (r: string | undefined) => (r ? (ROLE[r] ?? r) : "");

function initial(name: string): string {
  const c = name.trim().match(/[\p{L}\p{N}]/u);
  return c ? c[0].toUpperCase() : "·";
}

export function ProjectSwitcher({
  tenants,
  currentId,
}: {
  tenants: Membership[] | undefined;
  currentId: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const path = useLocation({ select: (l) => l.pathname });
  const current = tenants?.find((t) => t.tenant_id === currentId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close whenever the route changes
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="um-psw" ref={root}>
      <button
        ref={btn}
        type="button"
        className="um-psw-btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        data-testid="project-switcher"
      >
        <span className={current ? "um-pav" : "um-pav um-pav--none"} aria-hidden="true">
          {current ? initial(current.name) : <Icon name="list" size="sm" />}
        </span>
        <span className="um-sr">Switch project: </span>
        <span className="um-psw-t">
          <b>{current ? current.name : "Your Stellar ecosystem projects"}</b>
          <small>
            {current
              ? `${roleLabel(current.role)} · ${current.slug}`
              : tenants
                ? `${tenants.length} Stellar ecosystem ${tenants.length === 1 ? "project" : "projects"}`
                : "Loading…"}
          </small>
        </span>
        <Icon name="updown" size="sm" />
      </button>
      {open ? (
        <div className="um-psw-menu" id={id}>
          {tenants && tenants.length > 0 ? (
            <ul aria-label="Your Stellar ecosystem projects">
              {tenants.map((t, i) => (
                <li key={t.tenant_id}>
                  <Link
                    to="/t/$tenantId"
                    params={{ tenantId: t.tenant_id }}
                    className="um-psw-item"
                    aria-current={t.tenant_id === currentId ? "true" : undefined}
                  >
                    <span className={i % 2 ? "um-pav um-pav--alt" : "um-pav"} aria-hidden="true">
                      {initial(t.name)}
                    </span>
                    <span className="um-psw-t">
                      <b>{t.name}</b>
                      <small>
                        {roleLabel(t.role)} · {t.slug}
                        {t.status !== "active" ? ` · ${t.status}` : ""}
                      </small>
                    </span>
                    {t.tenant_id === currentId ? (
                      <span className="um-psw-ck">
                        <Icon name="check" size="sm" />
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {tenants && tenants.length > 0 ? <hr /> : null}
          <Link to="/onboard" search={{}} className="um-psw-item um-psw-add">
            <Icon name="plus" size="sm" />
            Claim another project
          </Link>
          <Link to="/tenants" className="um-psw-item um-psw-add">
            <Icon name="list" size="sm" />
            All your Stellar ecosystem projects
          </Link>
        </div>
      ) : null}
    </div>
  );
}
