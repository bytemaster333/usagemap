// SPDX-License-Identifier: Apache-2.0
// SCF-operator projects (approved design 2026-11-20) with the lifecycle (C-08, C-64, C-94): the enrolment mode, every
// enrolled Stellar ecosystem project by status, approve a pending project, suspend and reinstate (operator), remove with a
// reason code, restore before the purge and purge (operator_admin). Every action asks for a note (audit log) and a
// passkey step-up up front (C-09); destructive ones also ask to type the project's slug. A refused change (read-only
// operator) shows a plain notice. The detail shows configuration, evidence, members and activity — no visitor data.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { useFreshAction } from "../../auth/fresh.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Note,
  QueryState,
  Segmented,
  StatusBadge,
  TableScroll,
  Tabs,
  Tag,
} from "../../components/ui/index.ts";
import { fmtDay, fmtDayTime } from "../../lib/format.ts";
import { useOperatorRole } from "./common.tsx";
import { Lvl, OpIntro, OpModal, OpProblem, PName, SearchBox, Sel, useToast } from "./kit.tsx";
import { STAGE_SHORT } from "./model.ts";

type Tenant = ControlPlane.Tenant;
type Status = ControlPlane.TenantStatus;
type Action = "approve" | "suspend" | "reinstate" | "remove" | "restore" | "purge";
type ReasonCode = ControlPlane.RemovalReasonCode;

export const STATUS_LABEL: Record<Status, string> = {
  pending: "Waiting for approval",
  active: "Active",
  suspended: "Suspended",
  removed: "Removed",
};
const STATUS_KIND: Record<Status, "wait" | "live" | "off" | "gone"> = {
  pending: "wait",
  active: "live",
  suspended: "off",
  removed: "gone",
};
const REASON_CODES: Record<ReasonCode, string> = {
  not_ecosystem: "Not a Stellar ecosystem project",
  duplicate: "Duplicate of another project",
  spam: "Spam or abuse",
  other: "Other reason",
};

const ACTION: Record<
  Action,
  {
    label: string;
    title: (n: string) => string;
    sub: string;
    admin: boolean;
    danger: boolean;
    icon: "check" | "pause" | "undo" | "trash";
    done: string;
  }
> = {
  approve: {
    label: "Approve",
    title: (n) => `Approve ${n}?`,
    sub: "The project can start measuring right away.",
    admin: false,
    danger: false,
    icon: "check",
    done: "Approved. The project can start measuring.",
  },
  suspend: {
    label: "Suspend",
    title: (n) => `Suspend ${n}?`,
    sub: "Ingest pauses within a minute and the project leaves rankings until you reinstate it. Data is kept.",
    admin: false,
    danger: true,
    icon: "pause",
    done: "Suspended. Ingest is paused.",
  },
  reinstate: {
    label: "Reinstate",
    title: (n) => `Reinstate ${n}?`,
    sub: "Ingest resumes and the project returns to rankings.",
    admin: false,
    danger: false,
    icon: "undo",
    done: "Reinstated.",
  },
  remove: {
    label: "Remove",
    title: (n) => `Remove ${n}?`,
    sub: "For projects that are not part of the Stellar ecosystem.",
    admin: true,
    danger: true,
    icon: "trash",
    done: "Removed. You can restore it until the purge date.",
  },
  restore: {
    label: "Restore",
    title: (n) => `Restore ${n}?`,
    sub: "The project comes back suspended, with all its data; reinstate it afterwards to resume counting.",
    admin: true,
    danger: false,
    icon: "undo",
    done: "Restored with all its data.",
  },
  purge: {
    label: "Purge",
    title: (n) => `Purge ${n}’s data now?`,
    sub: "All analytics data of the project is deleted by the next purge run. Tombstones and the audit chain are kept. This cannot be undone.",
    admin: true,
    danger: true,
    icon: "trash",
    done: "Purge requested.",
  },
};

export function actionsFor(status: Status): Action[] {
  switch (status) {
    case "pending":
      return ["approve", "remove"];
    case "active":
      return ["suspend", "remove"];
    case "suspended":
      return ["reinstate", "remove"];
    case "removed":
      return ["restore", "purge"];
  }
}

function runAction(
  tenantId: string,
  action: Action,
  reason: string,
  code: ReasonCode,
): Promise<Tenant> {
  const path = { tenantId };
  switch (action) {
    case "approve":
    case "suspend":
    case "reinstate":
      return api.call("operatorTransitionTenant", { path, body: { action, reason } });
    case "remove":
      return api.call("operatorRemoveTenant", { path, body: { reason, reason_code: code } });
    case "restore":
      return api.call("operatorRestoreTenant", { path, body: { reason } });
    case "purge":
      return api.call("operatorPurgeTenant", { path, body: { reason } });
  }
}

interface Target {
  tenant_id: string;
  slug: string;
  name: string;
  status: Status;
}

/** Lifecycle buttons for one project; opens the confirmation and runs the action with step-up. */
export function LifecycleButtons({
  t,
  small = true,
  onDone,
}: {
  t: Target;
  small?: boolean;
  onDone: (msg: string) => void;
}) {
  const role = useOperatorRole();
  const [open, setOpen] = useState<Action | null>(null);
  return (
    <>
      {actionsFor(t.status).map((a) => {
        const c = ACTION[a];
        const allowed = !c.admin || role === "operator_admin";
        const variant =
          a === "approve"
            ? "primary"
            : a === "reinstate" || a === "restore"
              ? "secondary"
              : "ghost";
        return (
          <Button
            key={a}
            variant={variant}
            size={small ? "sm" : undefined}
            icon={c.icon}
            className={a === "remove" || a === "purge" ? "um-op-dz" : undefined}
            disabled={!allowed}
            title={allowed ? undefined : "Operator admins only"}
            aria-label={small ? `${c.label} ${t.name}` : undefined}
            onClick={() => setOpen(a)}
          >
            {c.label}
          </Button>
        );
      })}
      {open ? (
        <LifecycleModal
          t={t}
          action={open}
          onClose={() => setOpen(null)}
          onDone={(m) => {
            setOpen(null);
            onDone(m);
          }}
        />
      ) : null}
    </>
  );
}

function LifecycleModal({
  t,
  action,
  onClose,
  onDone,
}: {
  t: Target;
  action: Action;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const c = ACTION[action];
  const [reason, setReason] = useState("");
  const [code, setCode] = useState<ReasonCode>("not_ecosystem");
  const [slug, setSlug] = useState("");
  const run = useMutation({
    mutationFn: () =>
      fresh(() =>
        runAction(t.tenant_id, action, reason.trim() || "Approved in the operator console", code),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["op-tenant", t.tenant_id] });
      await qc.invalidateQueries({ queryKey: ["op-tenants"] });
      await qc.invalidateQueries({ queryKey: ["op-overview"] });
      onDone(c.done);
    },
  });
  const needReason = action !== "approve";
  const ready =
    (!needReason || reason.trim().length > 0) &&
    (!c.danger || slug.trim() === t.slug) &&
    !run.isPending;
  return (
    <OpModal
      title={c.title(t.name)}
      sub={c.sub}
      icon={c.icon}
      tone={c.danger ? "dang" : "good"}
      onClose={onClose}
      footer={
        <>
          <span className="um-op-stepup">
            <Icon name="fingerprint" size="sm" />
            Confirm with your passkey · recorded in the audit log
          </span>
          <span className="um-op-btns">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant={c.danger ? "danger" : "primary"}
              icon={c.icon}
              disabled={!ready}
              onClick={() => run.mutate()}
            >
              {action === "remove" ? "Remove project" : c.label}
            </Button>
          </span>
        </>
      }
    >
      {action === "remove" ? (
        <>
          <fieldset className="um-op-choices">
            <legend>Reason</legend>
            {(Object.keys(REASON_CODES) as ReasonCode[]).map((k) => (
              <label key={k}>
                <input
                  type="radio"
                  name="op-rc"
                  value={k}
                  checked={code === k}
                  onChange={() => setCode(k)}
                />
                <span>{REASON_CODES[k]}</span>
                <code>{k}</code>
              </label>
            ))}
          </fieldset>
          <ul className="um-op-facts">
            <li>
              <Icon name="eyeoff" />
              Ingest stops within a minute; the project leaves every list, comparison and cohort.
            </li>
            <li>
              <Icon name="clock" />
              Data is kept 30 days so you can restore it. After that it can be purged.
            </li>
            <li>
              <Icon name="ban" />
              Its verified domains and accounts are blocked from enrolling again (a tombstone).
            </li>
            <li>
              <Icon name="users" />
              Members see the reason when they next sign in. Nothing is e-mailed.
            </li>
          </ul>
        </>
      ) : null}
      <div className="um-op-fld">
        <label htmlFor="op-lc-reason">
          {action === "remove" ? "Note for the audit log" : "Reason"}
          {needReason ? "" : " (optional)"}
        </label>
        <textarea
          id="op-lc-reason"
          className="um-inp"
          value={reason}
          maxLength={500}
          placeholder={
            action === "remove" ? "Shown to the project’s members" : "Recorded in the audit log"
          }
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {c.danger ? (
        <div className="um-op-fld">
          <label htmlFor="op-lc-slug">
            Type <b className="um-op-mono">{t.slug}</b> to confirm
          </label>
          <input
            id="op-lc-slug"
            className="um-inp um-inp--mono"
            autoComplete="off"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
      ) : null}
      <OpProblem error={run.error} />
    </OpModal>
  );
}

// ---------------------------------------------------------------------------------------------- list

const TABS: { id: "all" | Status; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending", label: "Waiting" },
  { id: "active", label: "Active" },
  { id: "suspended", label: "Suspended" },
  { id: "removed", label: "Removed" },
];

function EnrolmentCard() {
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const mode = useQuery({
    queryKey: ["op-enrollment"],
    queryFn: () => api.call("operatorGetEnrollmentMode", {}),
  });
  const set = useMutation({
    mutationFn: (m: ControlPlane.EnrollmentMode["enrollment_mode"]) =>
      fresh(() => api.call("operatorSetEnrollmentMode", { body: { enrollment_mode: m } })),
    onSuccess: (r) => qc.setQueryData(["op-enrollment"], r),
  });
  const cur = mode.data?.enrollment_mode;
  return (
    <Card
      tone="api"
      icon="userplus"
      title="New project sign-ups"
      sub={
        cur === undefined
          ? undefined
          : cur === "open"
            ? "Open: any Stellar ecosystem project can enrol and start measuring right away."
            : "Approval required: new projects wait here until an operator approves them."
      }
      actions={
        cur ? (
          <Segmented
            label="Enrolment"
            value={cur}
            onChange={(m) => m !== cur && set.mutate(m)}
            options={[
              { value: "open", label: "Open" },
              { value: "approval_required", label: "Approval required" },
            ]}
          />
        ) : null
      }
      data-testid="enrollment-mode"
    >
      {mode.isPending ? (
        <LoadingState />
      ) : mode.error ? (
        <ErrorState plain error={mode.error} />
      ) : null}
      <OpProblem error={set.error} />
    </Card>
  );
}

export function OperatorTenantsPage() {
  useTitle("Stellar ecosystem projects");
  const search = useSearch({ from: "/app/operator/tenants" });
  const navigate = useNavigate();
  const [toast, show] = useToast();
  const tab: "all" | Status = search.status.includes(",") ? "all" : (search.status as Status);
  const list = useQuery({
    queryKey: ["op-tenants", "all", search.q ?? null, search.sort],
    queryFn: () =>
      api.call("operatorListTenants", {
        query: {
          status: ["pending", "active", "suspended", "removed"],
          min_level: "L0",
          sort: search.sort,
          ...(search.q ? { q: search.q } : {}),
          limit: 200,
        },
      }),
  });
  const go = (s: { status?: string; sort?: typeof search.sort; q?: string | undefined }) => {
    const next: typeof search = { status: s.status ?? search.status, sort: s.sort ?? search.sort };
    const q = "q" in s ? s.q : search.q;
    if (q) next.q = q;
    void navigate({ to: "/operator/tenants", search: next, replace: true });
  };
  const items = list.data?.items ?? [];
  const counts: Record<string, number> = { all: items.length };
  for (const t of items) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const rows = items.filter((t) => tab === "all" || t.status === tab);
  return (
    <>
      <OpIntro
        title="Stellar ecosystem projects"
        lead="Every Stellar ecosystem project enrolled in UsageMap. Approve new sign-ups, pause projects for review, and remove anything that is not a Stellar ecosystem project."
      />
      <EnrolmentCard />
      <Card flush className="um-op-card-flush">
        <div className="um-op-tabs-pad">
          <Tabs
            label="Project status"
            idBase="op-proj"
            value={tab}
            onChange={(v) => go({ status: v === "all" ? "pending,active,suspended,removed" : v })}
            items={TABS.map((t) => ({ ...t, count: list.data ? (counts[t.id] ?? 0) : undefined }))}
          />
        </div>
        <div
          className="um-op-filters um-op-filters--top"
          id={`op-proj-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`op-proj-tab-${tab}`}
        >
          <SearchBox
            value={search.q ?? ""}
            onChange={(v) => go({ q: v || undefined })}
            placeholder="Name or slug"
            label="Find a project"
          />
          <Sel
            label="Sort"
            value={search.sort}
            onChange={(v) => go({ sort: v as typeof search.sort })}
          >
            <option value="name">Name</option>
            <option value="-created_at">Newest first</option>
            <option value="-verification_level">Highest level first</option>
          </Sel>
          <span className="um-op-grow" />
        </div>
        <QueryState
          query={list}
          plain
          isEmpty={() => rows.length === 0}
          empty={
            <EmptyState
              plain
              title={
                tab === "pending"
                  ? "No Stellar ecosystem projects waiting for approval"
                  : "No Stellar ecosystem projects here"
              }
            >
              {search.q ? "Nothing matches this search." : undefined}
            </EmptyState>
          }
        >
          {() => (
            <TableScroll label="Stellar ecosystem projects" stickyFirst>
              <table className="um-table um-op-table" data-testid="op-tenants">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">SCF registry</th>
                    <th scope="col">Level</th>
                    <th scope="col">Status</th>
                    <th scope="col">Enrolled</th>
                    <th scope="col">
                      <span className="um-sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.tenant_id} data-testid={`op-tenant-${t.slug}`}>
                      <th scope="row">
                        <PName sub={<span className="um-num">{t.slug}</span>}>
                          <Link to="/operator/tenants/$tenantId" params={{ tenantId: t.tenant_id }}>
                            {t.name}
                          </Link>
                        </PName>
                      </th>
                      <td>
                        <RegistryChip link={t.registry_link ?? null} />
                      </td>
                      <td>
                        <Lvl level={t.verification_level} />
                      </td>
                      <td>
                        <StatusBadge status={STATUS_KIND[t.status]}>
                          {STATUS_LABEL[t.status]}
                        </StatusBadge>
                      </td>
                      <td className="um-muted">{fmtDay(t.created_at)}</td>
                      <td>
                        <div className="um-op-rowact">
                          <LifecycleButtons t={t} onDone={show} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </QueryState>
      </Card>
      {toast}
    </>
  );
}

function RegistryChip({ link }: { link: ControlPlane.OperatorRegistryFacts | null }) {
  if (!link)
    return (
      <span className="um-op-chip-org">
        <Icon name="alert" />
        Not in registry
      </span>
    );
  const parts = [
    link.award_round ? `Round ${link.award_round}` : link.name,
    link.award_stage ? STAGE_SHORT[link.award_stage] : null,
  ];
  return (
    <Chip kind="verified" title={link.name}>
      {parts.filter(Boolean).join(" · ")}
    </Chip>
  );
}

// ---------------------------------------------------------------------------------------------- detail

type MultiplicityChoice = "platform" | "enforce" | "shadow";

/** A website's multiplicity mode (C-124): the platform setting or an override; operator_admin only, with step-up. */
function SiteMultiplicity({ tenantId, site }: { tenantId: string; site: ControlPlane.Site }) {
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const role = useOperatorRole();
  const current: MultiplicityChoice = site.multiplicity_mode ?? "platform";
  const set = useMutation({
    mutationFn: (c: MultiplicityChoice) =>
      fresh(() =>
        api.call("operatorSetSiteMultiplicityMode", {
          path: { tenantId, siteId: site.site_id },
          body: { multiplicity_mode: c === "platform" ? null : c },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["op-tenant", tenantId] });
    },
  });
  return (
    <>
      <select
        className="um-op-sel"
        aria-label={`Suspect traffic handling for ${site.name}`}
        value={current}
        disabled={role !== "operator_admin" || set.isPending}
        title={role !== "operator_admin" ? "Operator admins only" : undefined}
        onChange={(e) => set.mutate(e.target.value as MultiplicityChoice)}
      >
        <option value="platform">Platform setting</option>
        <option value="enforce">Enforce: mark suspect</option>
        <option value="shadow">Shadow: count only</option>
      </select>
      {set.data ? (
        <span className="um-op-hint"> Now: {set.data.effective_multiplicity_mode}</span>
      ) : null}
      <OpProblem error={set.error} />
    </>
  );
}

const EVIDENCE_TEXT: Record<ControlPlane.Evidence["kind"], string> = {
  domain: "Domain",
  stellar_account: "Stellar account",
  registry_match: "Registry match",
  operator_approval: "Operator approval",
};

export function OperatorTenantPage() {
  const { tenantId } = useParams({ from: "/app/operator/tenants/$tenantId" });
  const [toast, show] = useToast();
  const detail = useQuery({
    queryKey: ["op-tenant", tenantId],
    queryFn: () => api.call("operatorGetTenant", { path: { tenantId } }),
  });
  const activity = useQuery({
    queryKey: ["op-audit", "tenant", tenantId],
    queryFn: () => api.call("operatorListAudit", { query: { tenant_id: tenantId, limit: 6 } }),
  });
  const t = detail.data?.tenant;
  useTitle(t ? t.name : "Project");
  const confirmed = detail.data?.registry_links.find((l) => l.status === "confirmed");
  return (
    <>
      <Link
        to="/operator/tenants"
        search={{ status: "active,suspended,pending", sort: "name" }}
        className="um-op-back"
      >
        <Icon name="left" />
        Stellar ecosystem projects
      </Link>
      {detail.isPending ? (
        <LoadingState label="Loading the project…" />
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : detail.data && t ? (
        <>
          <div className="um-op-dhead">
            <span className="um-op-dtile um-op-tile-ink" aria-hidden="true">
              {t.name.slice(0, 1)}
            </span>
            <div>
              <h1 className="um-h1">{t.name}</h1>
              <div className="um-op-dmeta" data-testid="op-tenant-status">
                <StatusBadge status={STATUS_KIND[t.status]}>{STATUS_LABEL[t.status]}</StatusBadge>
                <Lvl level={t.verification_level} />
                <span className="um-num">{t.slug}</span>· enrolled {fmtDay(t.created_at)}
                {t.status_reason ? <span>· {t.status_reason}</span> : null}
              </div>
            </div>
            <div className="um-op-dacts">
              <LifecycleButtons t={t} small={false} onDone={show} />
            </div>
          </div>
          {t.status === "pending" && !confirmed ? (
            <Note tone="warn">
              <b>Not found in the SCF registry.</b> The website and Stellar account do not match a
              confirmed registry project. Check it before approving.
            </Note>
          ) : null}
          {t.status === "removed" ? (
            <Note tone="warn" icon="clock">
              <span data-testid="purge-after">
                Removed{t.removed_at ? ` on ${fmtDayTime(t.removed_at)}` : ""}
                {t.removal_reason_code ? `: ${REASON_CODES[t.removal_reason_code]}` : ""}. Data is
                hidden
                {t.purge_after
                  ? ` and kept until ${fmtDayTime(t.purge_after)}, then it can be purged`
                  : ""}
                . Members see the reason when they next sign in.
              </span>
            </Note>
          ) : null}
          <div className="um-grid um-g3">
            <Card title="Project">
              <dl className="um-op-kv">
                <dt>SCF registry</dt>
                <dd>
                  {confirmed ? (
                    <Chip kind="verified">
                      {confirmed.award_round ? `Round ${confirmed.award_round} · ` : ""}confirmed
                    </Chip>
                  ) : (
                    <span className="um-op-chip-org">No confirmed match</span>
                  )}
                </dd>
                <dt>Footprint</dt>
                <dd>{t.footprint_status ? t.footprint_status.replace("_", " ") : "—"}</dd>
                <dt>Public stats page</dt>
                <dd>{t.public_stats_enabled ? "On" : "Off"}</dd>
                <dt>Daily seal</dt>
                <dd>{t.seal_enabled === undefined ? "—" : t.seal_enabled ? "On" : "Off"}</dd>
                <dt>On-chain correlation</dt>
                <dd>{t.onchain_correlation_enabled ? "On" : "Off"}</dd>
                {t.quotas ? (
                  <>
                    <dt>Quotas</dt>
                    <dd className="um-op-mono">
                      {[
                        t.quotas.max_sites !== undefined ? `${t.quotas.max_sites} sites` : null,
                        t.quotas.max_services !== undefined
                          ? `${t.quotas.max_services} services`
                          : null,
                        t.quotas.web_events_per_day !== undefined
                          ? `${t.quotas.web_events_per_day.toLocaleString("en-US")} events/day`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <Card title="Evidence">
              {detail.data.evidence.length === 0 ? (
                <EmptyState plain title="No verification evidence yet" />
              ) : (
                <ul className="um-op-ilist">
                  {detail.data.evidence.map((e) => (
                    <li key={e.evidence_id}>
                      <div>
                        <b>{EVIDENCE_TEXT[e.kind]}</b>
                        <small>
                          <span className="um-op-mono">{e.subject}</span> · verified{" "}
                          {fmtDay(e.verified_at)}
                        </small>
                      </div>
                      <StatusBadge
                        status={
                          e.status === "valid" ? "live" : e.status === "lapsed" ? "off" : "bad"
                        }
                      >
                        {e.status === "valid"
                          ? "Valid"
                          : e.status === "lapsed"
                            ? "Lapsed"
                            : "Revoked"}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card
              title="Members"
              actions={<span className="um-card-sub">{detail.data.members.length}</span>}
            >
              {detail.data.members.length === 0 ? (
                <EmptyState plain title="No members" />
              ) : (
                <ul className="um-op-ilist">
                  {detail.data.members.map((m) => (
                    <li key={`${m.user_id}-${m.role}`}>
                      <div>
                        <b>{m.display_name ?? "Deleted account"}</b>
                        <small>Added {fmtDay(m.added_at)}</small>
                      </div>
                      <Tag>{m.role}</Tag>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <div className="um-grid um-g2">
            <Card title="Websites" flush className="um-op-card-flush">
              {detail.data.sites.length === 0 ? (
                <EmptyState plain title="No websites" />
              ) : (
                <TableScroll label="Websites">
                  <table className="um-table um-op-table">
                    <thead>
                      <tr>
                        <th scope="col">Website</th>
                        <th scope="col">Status</th>
                        <th scope="col">Suspect traffic handling</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.sites.map((s) => (
                        <tr key={s.site_id} data-testid={`op-site-${s.name}`}>
                          <td>
                            <PName
                              sub={(s.domains ?? []).map((d) => d.host).join(", ") || undefined}
                            >
                              <b>{s.name}</b>
                            </PName>
                          </td>
                          <td>{s.status.replace("_", " ")}</td>
                          <td>
                            <SiteMultiplicity tenantId={tenantId} site={s} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </Card>
            <Card
              title="API services"
              flush
              className="um-op-card-flush"
              actions={<Chip kind="self" />}
            >
              {detail.data.services.length === 0 ? (
                <EmptyState plain title="No API services" />
              ) : (
                <TableScroll label="API services">
                  <table className="um-table um-op-table">
                    <thead>
                      <tr>
                        <th scope="col">Service</th>
                        <th scope="col">Registered</th>
                        <th scope="col" className="um-r">
                          SLO
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.services.map((s) => (
                        <tr key={s.service_id}>
                          <td>
                            <PName sub={s.status === "archived" ? "Archived" : undefined}>
                              <b>{s.display_name ?? s.service_name}</b>
                            </PName>
                          </td>
                          <td>{s.registration === "auto" ? "Automatically" : "In the portal"}</td>
                          <td className="um-r">
                            {s.slo_target_pct !== undefined ? `${s.slo_target_pct}%` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
              {detail.data.ingest_tokens ? (
                <p className="um-op-hint um-op-pad">
                  {detail.data.ingest_tokens.filter((k) => !k.revoked_at).length} active ingest
                  tokens
                </p>
              ) : null}
            </Card>
          </div>
          <Card
            title="Activity on this project"
            actions={
              <Link to="/operator/audit" search={{ prefix: "" }} className="um-op-tlink">
                Full audit log
              </Link>
            }
          >
            <QueryState
              query={activity}
              isEmpty={(d) => d.items.length === 0}
              empty={<EmptyState plain title="No recorded activity" />}
            >
              {(d) => (
                <ul className="um-op-ilist">
                  {d.items.map((e) => (
                    <li key={`${e.chain_id}-${e.seq}`}>
                      <div>
                        <b>{e.action.replaceAll("_", " ").replace(".", ": ")}</b>
                        <small>
                          {fmtDayTime(e.occurred_at)} ·{" "}
                          {e.actor_display ??
                            (e.actor_kind === "system" || e.actor_kind === "job"
                              ? "System"
                              : "Account without a name")}
                        </small>
                      </div>
                      <span className="um-op-hash">{e.action}</span>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
          </Card>
        </>
      ) : null}
      {toast}
    </>
  );
}
