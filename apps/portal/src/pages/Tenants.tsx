// SPDX-License-Identifier: Apache-2.0
// The member's projects (tenants) and creating a new one. A new tenant may start `pending` until an SCF operator
// approves it, depending on the enrollment mode (C-08); its events are rejected (`tenant_pending`) until then.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { useMe, useSession } from "../auth/session.ts";
import { useTenants, useTitle } from "../components/AppShell.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import {
  buttonClass,
  Card,
  ErrorState,
  Icon,
  LoadingState,
  PageHeader,
} from "../components/ui/index.ts";
import "./project/project.css";

export const STATUS_TEXT: Record<string, string> = {
  pending: "Awaiting approval",
  active: "Active",
  suspended: "Suspended",
  removed: "Removed",
};

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function CreateTenant() {
  const id = useId();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.call("createTenant", {
        body: {
          name: name.trim(),
          slug,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      }),
    onSuccess: async (t) => {
      await qc.invalidateQueries({ queryKey: ["tenants"] });
      void navigate({ to: "/t/$tenantId", params: { tenantId: t.tenant_id } });
    },
  });
  return (
    <form
      className="um-card"
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 id={`${id}-h`} className="um-h2">
        Create a project
      </h2>
      <div className="um-fld">
        <label htmlFor={`${id}-name`}>Project name</label>
        <input
          className="um-inp"
          id={`${id}-name`}
          required
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
        />
      </div>
      <div className="um-fld">
        <label htmlFor={`${id}-slug`}>Short name (used in links)</label>
        <input
          className="um-inp"
          id={`${id}-slug`}
          required
          pattern="[a-z0-9][a-z0-9-]*"
          maxLength={40}
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          aria-describedby={`${id}-slug-help`}
        />
        <p id={`${id}-slug-help`} className="small muted">
          Lower-case letters, digits and hyphens.
        </p>
      </div>
      <div>
        <label htmlFor={`${id}-desc`}>Description (optional)</label>
        <textarea
          id={`${id}-desc`}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <ProblemAlert error={create.error} />
      <div>
        <button
          type="submit"
          className="um-btn um-btn--secondary um-btn--sm"
          disabled={create.isPending}
        >
          Create project
        </button>
      </div>
    </form>
  );
}

export function TenantsPage() {
  useTitle("Stellar ecosystem projects");
  const tenants = useTenants();
  const session = useSession();
  const me = useMe();
  const operator =
    session.data?.kind === "operator" || !!session.data?.platform_role || !!me.data?.platform_role;
  // An account without a project goes straight to onboarding ("Find your project"); an SCF operator is not sent
  // there (their console is the operator side).
  if (tenants.data && tenants.data.length === 0 && me.data && !operator)
    return <Navigate to="/onboard" search={{}} replace />;
  return (
    <>
      <PageHeader
        title="Your Stellar ecosystem projects"
        sub="The Stellar ecosystem projects you are a member of."
        actions={
          <Link to="/onboard" search={{}} className={buttonClass("primary", { size: "sm" })}>
            <Icon name="search" />
            Find your project
          </Link>
        }
      />
      {tenants.error ? (
        <ErrorState error={tenants.error} onRetry={() => void tenants.refetch()} />
      ) : null}
      {tenants.isPending ? <LoadingState block /> : null}
      {tenants.data && tenants.data.length === 0 ? (
        <p className="um-muted">
          You are not a member of any project yet. Create one, or ask a project owner for an
          invitation.
        </p>
      ) : null}
      {tenants.data && tenants.data.length > 0 ? (
        <ul className="um-p-projects" aria-label="Stellar ecosystem projects">
          {tenants.data.map((t) => (
            <li key={t.tenant_id}>
              <Link
                to="/t/$tenantId"
                params={{ tenantId: t.tenant_id }}
                search={{}}
                className="um-p-project"
              >
                <span className="um-pav" aria-hidden="true">
                  {t.name
                    .replace(/[^\p{L}\p{N}]/gu, "")
                    .slice(0, 1)
                    .toUpperCase() || "·"}
                </span>
                <span className="um-p-project-t">
                  <b>{t.name}</b>
                  <small>
                    {t.role} · {STATUS_TEXT[t.status] ?? t.status}
                  </small>
                </span>
                <Icon name="arrow" size="sm" />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <section className="um-grid um-g2">
        <Card title="A Stellar ecosystem project?" icon="search" data-testid="find-scf-project">
          <p>
            Find it in the Stellar registries (SCF awards, Stellarlight, PG Atlas): the details are
            filled in for you and you get a ready-to-copy snippet.
          </p>
          <div>
            <Link to="/onboard" search={{}} className={buttonClass("secondary", { size: "sm" })}>
              Find your project
            </Link>
          </div>
        </Card>
        <Card title="Have an invitation code?" icon="mail">
          <p>A project owner or admin can invite you. Enter the code to join.</p>
          <div>
            <Link to="/invitations/accept" className={buttonClass("secondary", { size: "sm" })}>
              Accept an invitation
            </Link>
          </div>
        </Card>
      </section>
      <CreateTenant />
    </>
  );
}
