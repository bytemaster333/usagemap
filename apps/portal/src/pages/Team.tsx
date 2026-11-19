// SPDX-License-Identifier: Apache-2.0
// Project team (tenancy.sites-and-services): members and their roles, invitation codes, and accepting a code. Roles: owner (one; changed
// only by an ownership transfer), admin (manages members, invitations, sites, tokens), member, viewer. An invitation
// code (`scfi_…`) is shown once at creation; we store only its hash, so it is never in a URL, storage or the query
// cache — the person who receives it types or pastes it on the "Accept an invitation" page after signing in.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { ApiError, api } from "../api/client.ts";
import { useSession } from "../auth/session.ts";
import { useTenants, useTitle } from "../components/AppShell.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { SecretOnce } from "../components/SecretOnce.tsx";
import {
  AccessNotice,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  TableScroll,
  Tag,
} from "../components/ui/index.ts";
import { fmtDay, fmtDayTime } from "../lib/format.ts";
import { ProjectFrame, useTenant } from "./project/common.tsx";

type Role = ControlPlane.TenantRole;
type AssignableRole = Exclude<Role, "owner">;
export const ASSIGNABLE_ROLES: AssignableRole[] = ["admin", "member", "viewer"];

/** "Owner", "Admin", "Member", "Viewer" (as in the sidebar and the project switcher). */
export const roleName = (r: string): string => (r ? `${r[0]?.toUpperCase()}${r.slice(1)}` : r);

export const ROLE_TEXT: Record<Role, string> = {
  owner: "owner — everything, including removing the project",
  admin: "admin — manages members, invitations, websites, services and tokens",
  member: "member — works with websites and services, sees all analytics",
  viewer: "viewer — reads analytics only",
};

export const INVITATION_CODE_RE = /^scfi_[0-9A-Za-z]{22}$/;

/** Whether the role may manage members and invitations. */
export const canManage = (role: Role | undefined): boolean => role === "owner" || role === "admin";

/** The signed-in person's role in a project, from their membership list. */
export function useMyRole(tenantId: string): Role | undefined {
  const tenants = useTenants();
  return tenants.data?.find((t) => t.tenant_id === tenantId)?.role;
}

function MemberRow({
  tenantId,
  m,
  manage,
  self,
}: {
  tenantId: string;
  m: ControlPlane.Member;
  manage: boolean;
  self: boolean;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const name = m.display_name ?? "deleted account";
  const update = useMutation({
    mutationFn: (role: AssignableRole) =>
      api.call("updateMember", { path: { tenantId, userId: m.user_id }, body: { role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", tenantId] }),
  });
  const remove = useMutation({
    mutationFn: () => api.call("removeMember", { path: { tenantId, userId: m.user_id } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["members", tenantId] });
      if (self) await qc.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
  const editable = manage && m.role !== "owner" && !self;
  return (
    <tr data-testid={`member-${name}`}>
      <td>
        <span className="um-p-member">
          <span className="um-p-av" aria-hidden="true">
            {initials(name)}
          </span>
          <b>{name}</b>
          {self ? <Tag>You</Tag> : null}
        </span>
      </td>
      <td>
        {editable ? (
          <>
            <label className="um-sr" htmlFor={`role-${m.user_id}`}>
              Role of {name}
            </label>
            <select
              className="um-inp um-p-role"
              id={`role-${m.user_id}`}
              value={m.role}
              disabled={update.isPending}
              onChange={(e) => update.mutate(e.target.value as AssignableRole)}
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleName(r)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span data-testid="member-role">{roleName(m.role)}</span>
        )}
      </td>
      <td className="um-num">{fmtDay(m.added_at)}</td>
      <td className="um-r">
        {manage && m.role !== "owner" ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            {self ? "Leave project" : "Remove"}
            {self ? null : <span className="um-sr"> {name}</span>}
          </Button>
        ) : null}
        <ProblemAlert error={update.error ?? remove.error} />
        {confirming ? (
          <ConfirmDialog
            title={self ? "Leave this project?" : `Remove ${name}?`}
            confirmLabel={self ? "Leave project" : "Remove member"}
            danger
            busy={remove.isPending}
            onConfirm={() => {
              setConfirming(false);
              remove.mutate();
            }}
            onCancel={() => setConfirming(false)}
          >
            <p>
              {self
                ? "You lose access to this project at once. An admin can invite you again."
                : `${name} loses access to this project at once. They can rejoin only with a new invitation.`}
            </p>
          </ConfirmDialog>
        ) : null}
      </td>
    </tr>
  );
}

function InvitationRow({ tenantId, inv }: { tenantId: string; inv: ControlPlane.Invitation }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () =>
      api.call("revokeInvitation", { path: { tenantId, invitationId: inv.invitation_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invitations", tenantId] }),
  });
  const label = inv.note ?? `${inv.role} invitation`;
  return (
    <tr data-testid={`invitation-${label}`}>
      <td>{roleName(inv.role)}</td>
      <td>{inv.note ?? <span className="um-muted">—</span>}</td>
      <td className="um-num">{fmtDay(inv.created_at)}</td>
      <td className="um-num">{fmtDayTime(inv.expires_at)}</td>
      <td className="um-r">
        <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Revoke<span className="um-sr"> {label}</span>
        </Button>
        <ProblemAlert error={revoke.error} />
        {confirming ? (
          <ConfirmDialog
            title={`Revoke “${label}”?`}
            confirmLabel="Revoke invitation"
            danger
            busy={revoke.isPending}
            onConfirm={() => {
              setConfirming(false);
              revoke.mutate();
            }}
            onCancel={() => setConfirming(false)}
          >
            <p>The code stops working at once. Create a new invitation if it is still needed.</p>
          </ConfirmDialog>
        ) : null}
      </td>
    </tr>
  );
}

function CreateInvitation({
  tenantId,
  onCreated,
}: {
  tenantId: string;
  onCreated: (i: ControlPlane.InvitationCreated) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const [role, setRole] = useState<AssignableRole>("member");
  const [note, setNote] = useState("");
  const [hours, setHours] = useState(72);
  const create = useMutation({
    mutationFn: () =>
      api.call("createInvitation", {
        path: { tenantId },
        body: {
          role,
          ...(note.trim() ? { note: note.trim() } : {}),
          expires_in_hours: hours,
        },
      }),
    onSuccess: async (i) => {
      setNote("");
      await qc.invalidateQueries({ queryKey: ["invitations", tenantId] });
      onCreated(i);
    },
  });
  return (
    <form
      className="um-p-annform"
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h3 id={`${id}-h`} className="um-h3">
        Invite someone
      </h3>
      <div className="um-grid um-g3">
        <div className="um-fld">
          <label htmlFor={`${id}-role`}>Role</label>
          <select
            className="um-inp"
            id={`${id}-role`}
            value={role}
            onChange={(e) => setRole(e.target.value as AssignableRole)}
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_TEXT[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="um-fld">
          <label htmlFor={`${id}-note`}>Note for your records (optional)</label>
          <input
            className="um-inp"
            id={`${id}-note`}
            maxLength={200}
            value={note}
            placeholder="e.g. backend developer"
            onChange={(e) => setNote(e.target.value)}
            aria-describedby={`${id}-note-help`}
          />
          <p id={`${id}-note-help`} className="um-fld-hint">
            Do not put e-mail addresses or other personal data here.
          </p>
        </div>
        <div className="um-fld">
          <label htmlFor={`${id}-hours`}>Valid for (hours, 1–168)</label>
          <input
            className="um-inp"
            id={`${id}-hours`}
            type="number"
            min={1}
            max={168}
            required
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          />
        </div>
      </div>
      <ProblemAlert error={create.error} />
      <div className="um-p-tools">
        <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
          Create invitation code
        </Button>
      </div>
    </form>
  );
}

export function TeamPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/team" });
  useTitle("Team");
  const session = useSession();
  const role = useMyRole(tenantId);
  const manage = canManage(role);
  const members = useQuery({
    queryKey: ["members", tenantId],
    queryFn: () => api.call("listMembers", { path: { tenantId } }),
  });
  const invitations = useQuery({
    queryKey: ["invitations", tenantId],
    queryFn: () => api.call("listInvitations", { path: { tenantId } }),
    enabled: manage,
  });
  const [created, setCreated] = useState<ControlPlane.InvitationCreated | null>(null);
  const me = session.data?.user_id;
  const [inviting, setInviting] = useState(false);
  const tenant = useTenant(tenantId);
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader
        title="Team"
        sub={`Everyone here sees ${tenant.data?.name ?? "this project"}'s private numbers. Your role: ${role ?? "…"}.`}
      />
      <Card
        title="Team members"
        sub="People who can see or manage this project"
        flush
        actions={
          manage ? (
            <Button
              variant="primary"
              size="sm"
              icon="mail"
              aria-expanded={inviting}
              onClick={() => setInviting((v) => !v)}
            >
              Invite
            </Button>
          ) : null
        }
      >
        {manage && inviting ? (
          <div className="um-p-pad">
            <CreateInvitation
              tenantId={tenantId}
              onCreated={(i) => {
                setCreated(i);
                setInviting(false);
              }}
            />
          </div>
        ) : null}
        {created ? (
          <div className="um-p-pad">
            <SecretOnce
              label={`Invitation code (${created.role})`}
              secret={created.code}
              onDismiss={() => setCreated(null)}
            >
              <p>
                Send the code to the person over a channel you trust. They sign in, open{" "}
                <b>Accept an invitation</b> from the projects page and enter it before{" "}
                {fmtDayTime(created.expires_at)}. It works once.
              </p>
            </SecretOnce>
          </div>
        ) : null}
        {members.error ? (
          <ErrorState error={members.error} plain onRetry={() => void members.refetch()} />
        ) : members.isPending ? (
          <LoadingState />
        ) : (
          <TableScroll label="Members">
            <table className="um-table">
              <caption className="um-sr">Members</caption>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Role</th>
                  <th scope="col">Added</th>
                  <th scope="col">
                    <span className="um-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data.map((m) => (
                  <MemberRow
                    key={m.user_id}
                    tenantId={tenantId}
                    m={m}
                    manage={manage}
                    self={m.user_id === me}
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>
      {manage ? (
        <Card title="Open invitations" flush>
          {invitations.error ? (
            <ErrorState error={invitations.error} plain />
          ) : invitations.data && invitations.data.length > 0 ? (
            <TableScroll label="Open invitations">
              <table className="um-table">
                <caption className="um-sr">Open invitations</caption>
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Note</th>
                    <th scope="col">Created</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className="um-sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.data.map((i) => (
                    <InvitationRow key={i.invitation_id} tenantId={tenantId} inv={i} />
                  ))}
                </tbody>
              </table>
            </TableScroll>
          ) : invitations.data ? (
            <EmptyState plain title="No open invitations." icon="mail" />
          ) : (
            <LoadingState />
          )}
        </Card>
      ) : (
        <AccessNotice kind="read-only">
          Only the owner and admins can invite people or change roles. You can see everyone who has
          access.
        </AccessNotice>
      )}
    </ProjectFrame>
  );
}

function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2)
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return (parts[0] ?? "·").slice(0, 2).toUpperCase();
}

export function AcceptInvitationPage() {
  useTitle("Accept an invitation");
  const id = useId();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [joined, setJoined] = useState<ControlPlane.TenantMembershipSummary | null>(null);
  const accept = useMutation({
    mutationFn: () => {
      const c = code.trim();
      if (!INVITATION_CODE_RE.test(c))
        throw new Error("An invitation code starts with scfi_ followed by 22 letters and digits.");
      return api.call("acceptInvitation", { body: { code: c } });
    },
    onSuccess: async (m) => {
      setCode("");
      setJoined(m);
      await qc.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
  const err = accept.error;
  const notFound = err instanceof ApiError && err.status === 404;
  return (
    <>
      <h1>Accept an invitation</h1>
      {joined ? (
        <p className="alert ok" data-testid="joined">
          You joined{" "}
          <Link to="/t/$tenantId" params={{ tenantId: joined.tenant_id }}>
            {joined.name}
          </Link>{" "}
          as {joined.role}.
        </p>
      ) : null}
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          accept.mutate();
        }}
      >
        <div>
          <label htmlFor={`${id}-code`}>Invitation code</label>
          <input
            id={`${id}-code`}
            autoComplete="off"
            spellCheck={false}
            required
            value={code}
            placeholder="scfi_…"
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        {notFound ? (
          <p className="alert error" role="alert">
            This code is not valid: it may have expired, been revoked or used already. Ask the
            project for a new one.
          </p>
        ) : (
          <ProblemAlert error={err} />
        )}
        <button type="submit" disabled={accept.isPending}>
          Join project
        </button>
      </form>
    </>
  );
}
