// SPDX-License-Identifier: Apache-2.0
// SCF-operator governance pages (approved design 2026-11-20): enrolment tombstones (C-64), the audit log of
// cross-tenant reads and actions (operator.global-view-credentials, C-17), the erasure requests of all projects (types and counts only, never
// the selector, C-88), operator API keys (C-06, C-70, C-72; shown once) and the platform settings (enrolment mode,
// read-only mode, published thresholds). Changes need `operator_admin` and a passkey step-up (C-09); a refused change
// shows a plain read-only notice.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import { useFreshAction } from "../../auth/fresh.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  AccessNotice,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  isForbidden,
  Kpi,
  LoadingState,
  Note,
  QueryState,
  StatusBadge,
  TableScroll,
  Tag,
  type Tone,
} from "../../components/ui/index.ts";
import { fmtDay, fmtDayTime, fmtRange } from "../../lib/format.ts";
import { useOperatorRole, useOpSettings } from "./common.tsx";
import { OpIntro, OpProblem, PName, Sel, useToast } from "./kit.tsx";
import { fmtExact } from "./model.ts";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- tombstones

const KIND_TEXT: Record<ControlPlane.Tombstone["kind"], string> = {
  host: "Website",
  github_user: "GitHub user",
  stellar_account: "Stellar account",
};

export function OperatorTombstonesPage() {
  useTitle("Tombstones");
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [toast, show] = useToast();
  const [ask, setAsk] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["op-tombstones"],
    queryFn: () => api.call("operatorListTombstones", { query: { limit: 200 } }),
  });
  const tenants = useQuery({
    queryKey: ["op-tenants", "names"],
    queryFn: () =>
      api.call("operatorListTenants", {
        query: {
          status: ["pending", "active", "suspended", "removed"],
          min_level: "L0",
          limit: 200,
        },
      }),
    staleTime: 60_000,
  });
  const names = new Map((tenants.data?.items ?? []).map((t) => [t.tenant_id, t.name]));
  const lift = useMutation({
    mutationFn: (t: ControlPlane.Tombstone) =>
      fresh(() => api.call("operatorLiftTombstone", { path: { tombstoneId: t.tombstone_id } })),
    onSuccess: async () => {
      setAsk(null);
      await qc.invalidateQueries({ queryKey: ["op-tombstones"] });
      show("Tombstone lifted. It can enrol again.");
    },
  });
  const active = list.data?.items.filter((t) => !t.lifted_at).length;
  return (
    <>
      <h1 className="um-sr">Tombstones</h1>
      <Note icon="ban">
        A tombstone stops a removed project’s website or identities from simply enrolling again.
        Lifting one allows them again and is recorded in the audit log. Operator admins only.
      </Note>
      <OpProblem error={lift.error} />
      <Card
        title="Tombstones"
        flush
        className="um-op-card-flush"
        actions={active !== undefined ? <span className="um-card-sub">{active} active</span> : null}
      >
        {isForbidden(list.error) ? (
          <AccessNotice kind="forbidden" title="Tombstones are for operator admins">
            Your operator role can use the rest of the console. An operator admin can review and
            lift tombstones.
          </AccessNotice>
        ) : (
          <QueryState
            query={list}
            plain
            isEmpty={(d) => d.items.length === 0}
            empty={
              <EmptyState plain icon="check" title="No tombstones">
                Nothing is blocked from enrolling.
              </EmptyState>
            }
          >
            {(d) => (
              <TableScroll label="Tombstones" stickyFirst>
                <table className="um-table um-op-table" data-testid="tombstones">
                  <thead>
                    <tr>
                      <th scope="col">Blocked</th>
                      <th scope="col">Kind</th>
                      <th scope="col">From project</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Created</th>
                      <th scope="col">State</th>
                      <th scope="col">
                        <span className="um-sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((t) => (
                      <tr key={t.tombstone_id}>
                        <th scope="row">
                          <code>{t.subject}</code>
                        </th>
                        <td>
                          <Tag>{KIND_TEXT[t.kind]}</Tag>
                        </td>
                        <td>{names.get(t.tenant_id) ?? "Removed project"}</td>
                        <td className="um-muted">{t.reason ?? "—"}</td>
                        <td className="um-muted">{fmtDay(t.created_at)}</td>
                        <td>
                          {t.lifted_at ? (
                            <StatusBadge status="off">Lifted {fmtDay(t.lifted_at)}</StatusBadge>
                          ) : (
                            <StatusBadge status="bad">Blocking</StatusBadge>
                          )}
                        </td>
                        <td>
                          <div className="um-op-rowact">
                            {t.lifted_at ? null : ask === t.tombstone_id ? (
                              <span className="um-op-confirm">
                                Allow again?
                                <Button
                                  variant="primary"
                                  size="sm"
                                  disabled={lift.isPending}
                                  onClick={() => lift.mutate(t)}
                                >
                                  Lift
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setAsk(null)}>
                                  Keep
                                </Button>
                              </span>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                icon="undo"
                                aria-label={`Lift tombstone of ${t.subject}`}
                                onClick={() => setAsk(t.tombstone_id)}
                              >
                                Lift
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </QueryState>
        )}
      </Card>
      {toast}
    </>
  );
}

// ---------------------------------------------------------------- audit log

const PREFIXES = [
  { v: "", label: "All actions" },
  { v: "operator.read.", label: "Reads by operators" },
  { v: "tenant.", label: "Project changes" },
  { v: "api_key.", label: "API keys" },
  { v: "settings.", label: "Settings" },
  { v: "erasure.", label: "Erasure" },
  { v: "operator.tombstone", label: "Tombstones" },
  { v: "operator.grant", label: "Operator access" },
  { v: "audit.", label: "Chain seals" },
];

function actorName(e: ControlPlane.AuditEntry): string {
  if (e.actor_display) return e.actor_display;
  if (e.actor_kind === "system") return "System";
  if (e.actor_kind === "job") return "Scheduled job";
  return "Account without a name";
}

const AUDIT_PAGE = 200;
const AUDIT_MAX_PAGES = 25;
const AUDIT_STEP = 100;

const OUTCOME_KIND = { success: "live", denied: "bad", failure: "gone" } as const;

function detailsText(d: Record<string, unknown> | undefined): string {
  if (!d || Object.keys(d).length === 0) return "—";
  return Object.entries(d)
    .map(
      ([k, v]) =>
        `${k.replaceAll("_", " ")} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
    )
    .join(" · ");
}

export function OperatorAuditPage() {
  useTitle("Audit log");
  const search = useSearch({ from: "/app/operator/audit" });
  const navigate = useNavigate();
  const [tenant, setTenant] = useState("");
  const [days, setDays] = useState("7");
  const start =
    days === "all"
      ? undefined
      : `${new Date(Date.now() - Number(days) * DAY_MS).toISOString().slice(0, 13)}:00:00Z`;
  // The API lists the chain oldest first, 200 per page with a cursor. To show the newest entries first, the page reads
  // every page of the chosen range (up to AUDIT_MAX_PAGES), then shows them newest first, 100 at a time.
  const pages = useInfiniteQuery({
    queryKey: ["op-audit", search.prefix, tenant, days],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.call("operatorListAudit", {
        query: {
          ...(search.prefix ? { action_prefix: search.prefix } : {}),
          ...(tenant ? { tenant_id: tenant } : {}),
          ...(start ? { start } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
          limit: AUDIT_PAGE,
        },
      }),
    getNextPageParam: (last, all) =>
      last.next_cursor && all.length < AUDIT_MAX_PAGES ? last.next_cursor : undefined,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !pages.error) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, pages.error, fetchNextPage]);
  const [shown, setShown] = useState(AUDIT_STEP);
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the first rows when the filters change
  useEffect(() => setShown(AUDIT_STEP), [search.prefix, tenant, days]);
  const loadedAll = !hasNextPage;
  const capped = !!pages.data?.pages.at(-1)?.next_cursor && loadedAll;
  const entries = (pages.data?.pages ?? [])
    .flatMap((p) => p.items)
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.seq - a.seq);
  const log = {
    data: pages.data && loadedAll ? entries : undefined,
    error: pages.error,
    isPending: pages.isPending || (!loadedAll && !pages.error),
    refetch: (() => pages.refetch()) as never,
  };
  const tenants = useQuery({
    queryKey: ["op-tenants", "names"],
    queryFn: () =>
      api.call("operatorListTenants", {
        query: {
          status: ["pending", "active", "suspended", "removed"],
          min_level: "L0",
          limit: 200,
        },
      }),
    staleTime: 60_000,
  });
  return (
    <>
      <OpIntro
        title="Audit log"
        lead="Every sign-in, read and change by operators, API keys and the system. Entries form a hash chain sealed once a day."
        aside={
          <span title="Each entry includes the hash of the one before it, and every day’s last hash is published as a sealed anchor.">
            <Chip kind="verified">Hash-chained · sealed daily</Chip>
          </span>
        }
      />
      <Card flush className="um-op-card-flush">
        <div className="um-op-filters um-op-filters--top">
          <Sel
            label="Action"
            value={search.prefix}
            onChange={(v) =>
              void navigate({ to: "/operator/audit", search: { prefix: v }, replace: true })
            }
          >
            {PREFIXES.map((p) => (
              <option key={p.v} value={p.v}>
                {p.label}
              </option>
            ))}
          </Sel>
          <Sel label="Project" value={tenant} onChange={setTenant}>
            <option value="">All Stellar ecosystem projects</option>
            {(tenants.data?.items ?? []).map((t) => (
              <option key={t.tenant_id} value={t.tenant_id}>
                {t.name}
              </option>
            ))}
          </Sel>
          <Sel label="Range" value={days} onChange={setDays}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">Everything</option>
          </Sel>
          <span className="um-op-grow" />
          {log.data ? (
            <span className="um-op-fcount" data-testid="audit-count">
              {fmtExact(log.data.length)}
              {capped ? "+" : ""} entries · newest first
            </span>
          ) : pages.data ? (
            <span className="um-op-fcount">Reading the log… {fmtExact(entries.length)} so far</span>
          ) : null}
        </div>
        <QueryState<ControlPlane.AuditEntry[]>
          query={log}
          plain
          isEmpty={(d) => d.length === 0}
          empty={<EmptyState plain title="Nothing recorded for these filters" />}
        >
          {(d) => (
            <TableScroll label="Audit log" stickyFirst>
              <table className="um-table um-op-table" data-testid="audit">
                <thead>
                  <tr>
                    <th scope="col">When (UTC)</th>
                    <th scope="col">Who</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Details</th>
                    <th scope="col" className="um-r">
                      #
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.slice(0, shown).map((e) => (
                    <tr key={`${e.chain_id}-${e.seq}`}>
                      <td className="um-op-mono">
                        {fmtDayTime(e.occurred_at).replace(" UTC", "")}
                      </td>
                      <td>
                        <PName sub={e.actor_kind.replace("_", " ")}>
                          <b>{actorName(e)}</b>
                        </PName>
                      </td>
                      <td>
                        <code>{e.action}</code>
                      </td>
                      <td className="um-op-det">
                        {e.target_type ? e.target_type.replaceAll("_", " ") : "—"}
                      </td>
                      <td>
                        <StatusBadge status={OUTCOME_KIND[e.outcome]}>
                          {e.outcome[0]?.toUpperCase()}
                          {e.outcome.slice(1)}
                        </StatusBadge>
                      </td>
                      <td className="um-op-det" title={detailsText(e.details)}>
                        {detailsText(e.details)}
                      </td>
                      <td className="um-r um-op-hash">{e.seq}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </QueryState>
        {log.data && log.data.length > shown ? (
          <div className="um-op-more-row">
            <span className="um-op-hint">
              Showing {fmtExact(shown)} of {fmtExact(log.data.length)}
            </span>
            <Button size="sm" onClick={() => setShown((n) => n + AUDIT_STEP)}>
              Load more
            </Button>
          </div>
        ) : null}
        {capped ? (
          <div className="um-op-more-row">
            <Note>
              This range has more than {fmtExact(AUDIT_PAGE * AUDIT_MAX_PAGES)} entries and only the
              oldest {fmtExact(AUDIT_PAGE * AUDIT_MAX_PAGES)} were read. Pick a shorter range, one
              action or one project to see the newest.
            </Note>
          </div>
        ) : null}
      </Card>
      <Note icon="lock">
        No IP addresses are stored, for anyone. The log keeps who, what, when and the outcome.
      </Note>
    </>
  );
}

// ---------------------------------------------------------------- erasure requests

const ERASURE_TEXT: Record<ControlPlane.ErasureStatus, string> = {
  previewing: "Counting",
  previewed: "Previewed",
  confirmed: "Confirmed",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const ERASURE_KIND: Record<ControlPlane.ErasureStatus, "run" | "live" | "off" | "bad" | "wait"> = {
  previewing: "wait",
  previewed: "wait",
  confirmed: "run",
  running: "run",
  completed: "live",
  failed: "bad",
  cancelled: "off",
};
const SELECTOR_TYPE: Record<string, string> = {
  path_pattern: "Path pattern",
  event_name: "Event name",
  property_key: "Property key",
};

function erasureResult(e: ControlPlane.OperatorErasureRequest): string {
  if (e.failure_code) return `failure_code ${e.failure_code}`;
  const c = e.counts;
  if (!c) return "—";
  const parts: string[] = [];
  if (c.website_events !== undefined) parts.push(`${fmtExact(c.website_events)} events`);
  if (c.api_metric_rows !== undefined && c.api_metric_rows > 0)
    parts.push(`${fmtExact(c.api_metric_rows)} API rows`);
  if (c.api_routes !== undefined && c.api_routes > 0)
    parts.push(`${fmtExact(c.api_routes)} routes`);
  const verb = e.status === "completed" ? "removed" : "matched";
  return parts.length ? `${parts.join(" · ")} ${verb}` : "—";
}

export function OperatorErasurePage() {
  useTitle("Erasure requests");
  const [status, setStatus] = useState<ControlPlane.ErasureStatus | "">("");
  const [tenant, setTenant] = useState("");
  const [days, setDays] = useState("30");
  const start = new Date(Date.now() - Number(days) * DAY_MS);
  const startIso = `${start.toISOString().slice(0, 10)}T00:00:00Z`;
  const list = useQuery({
    queryKey: ["op-erasures", status, tenant, days],
    queryFn: () =>
      api.call("operatorListErasureRequests", {
        query: {
          ...(status ? { status: [status] } : {}),
          ...(tenant ? { tenant_id: tenant } : {}),
          start: startIso,
          limit: 200,
        },
      }),
  });
  // the tiles count the whole window, whatever the status filter
  const all = useQuery({
    queryKey: ["op-erasures", "", tenant, days],
    queryFn: () =>
      api.call("operatorListErasureRequests", {
        query: { ...(tenant ? { tenant_id: tenant } : {}), start: startIso, limit: 200 },
      }),
  });
  const tenants = useQuery({
    queryKey: ["op-tenants", "names"],
    queryFn: () =>
      api.call("operatorListTenants", {
        query: {
          status: ["pending", "active", "suspended", "removed"],
          min_level: "L0",
          limit: 200,
        },
      }),
    staleTime: 60_000,
  });
  const items = all.data?.items ?? [];
  const count = (s: ControlPlane.ErasureStatus) => items.filter((e) => e.status === s).length;
  const durations = items
    .filter((e) => e.status === "completed" && e.confirmed_at && (e.finished_at ?? e.completed_at))
    .map(
      (e) =>
        Date.parse((e.finished_at ?? e.completed_at) as string) -
        Date.parse(e.confirmed_at as string),
    )
    .sort((a, b) => a - b);
  const median = durations.length ? (durations[Math.floor(durations.length / 2)] ?? null) : null;
  const fmtDur = (ms: number) =>
    ms < 60_000
      ? `${Math.round(ms / 1000)} s`
      : ms < 3_600_000
        ? `${Math.round(ms / 60_000)} min`
        : `${(ms / 3_600_000).toFixed(1)} h`;
  const k = (tone: Tone, icon: IconName, label: string, value: string | null, foot: ReactNode) => (
    <Kpi tone={tone} icon={icon} label={label} loading={all.isPending} value={value} foot={foot} />
  );
  return (
    <>
      <OpIntro
        title="Erasure requests"
        lead="Erasure requests across all Stellar ecosystem projects. Projects run their own erasure; operators follow progress but do not start or change one."
        aside={<Chip kind="self">Read-only</Chip>}
      />
      <div className="um-grid um-g4 um-op-kg2">
        {k(
          "neutral",
          "eraser",
          "Running",
          String(count("running") + count("confirmed")),
          "Confirmed and in progress",
        )}
        {k("web", "check", "Completed", String(count("completed")), `Last ${days} days`)}
        {k("neutral", "alert", "Failed", String(count("failed")), `Last ${days} days`)}
        {k(
          "neutral",
          "clock",
          "Median time",
          median === null || median === undefined ? null : fmtDur(median),
          "From confirm to done",
        )}
      </div>
      <Card flush className="um-op-card-flush">
        <div className="um-op-filters um-op-filters--top">
          <Sel
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as ControlPlane.ErasureStatus | "")}
          >
            <option value="">Any status</option>
            {(Object.keys(ERASURE_TEXT) as ControlPlane.ErasureStatus[]).map((s) => (
              <option key={s} value={s}>
                {ERASURE_TEXT[s]}
              </option>
            ))}
          </Sel>
          <Sel label="Project" value={tenant} onChange={setTenant}>
            <option value="">All Stellar ecosystem projects</option>
            {(tenants.data?.items ?? []).map((t) => (
              <option key={t.tenant_id} value={t.tenant_id}>
                {t.name}
              </option>
            ))}
          </Sel>
          <Sel label="Range" value={days} onChange={setDays}>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
          </Sel>
        </div>
        <QueryState
          query={list}
          plain
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState plain title="No erasure requests" />}
        >
          {(d) => (
            <TableScroll label="Erasure requests" stickyFirst>
              <table className="um-table um-op-table" data-testid="op-erasures">
                <thead>
                  <tr>
                    <th scope="col">Requested (UTC)</th>
                    <th scope="col">Project</th>
                    <th scope="col">Covers</th>
                    <th scope="col">Selector</th>
                    <th scope="col">Status</th>
                    <th scope="col">Done</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((e) => (
                    <tr key={e.request_id} data-testid={`op-erasure-${e.slug}`}>
                      <td className="um-op-mono">{fmtDayTime(e.created_at).replace(" UTC", "")}</td>
                      <td>
                        <PName sub={fmtRange(e.start, e.end)}>
                          <b>{e.slug}</b>
                        </PName>
                      </td>
                      <td>
                        <Tag>{e.scope === "tenant" ? "whole project" : e.scope}</Tag>
                      </td>
                      <td>
                        {e.selector_type ? SELECTOR_TYPE[e.selector_type] : "—"}
                        {e.selector_redacted ? (
                          <span
                            className="um-op-hint"
                            title="Selectors are redacted once an erasure finishes."
                          >
                            {" "}
                            <Icon name="eyeoff" size="xs" /> value redacted
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <StatusBadge status={ERASURE_KIND[e.status]}>
                          {ERASURE_TEXT[e.status]}
                        </StatusBadge>
                      </td>
                      <td className="um-op-mono um-muted">
                        {(e.finished_at ?? e.completed_at)
                          ? fmtDayTime((e.finished_at ?? e.completed_at) as string).replace(
                              " UTC",
                              "",
                            )
                          : "—"}
                      </td>
                      <td className="um-op-det">{erasureResult(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </QueryState>
      </Card>
      <Note icon="clock">
        Erased data leaves every backup within 56 days (35-day backup window, the next weekly full
        and 14 days as a previous version).
      </Note>
    </>
  );
}

// ---------------------------------------------------------------- API keys

const SCOPES: { v: ControlPlane.OperatorApiKeyCreate["scopes"][number]; label: string }[] = [
  { v: "web:read", label: "Web figures" },
  { v: "api:read", label: "API figures" },
  { v: "registry:read", label: "SCF registry links" },
];

export function OperatorApiKeysPage() {
  useTitle("API keys");
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [toast, show] = useToast();
  const keys = useQuery({
    queryKey: ["op-keys"],
    queryFn: () => api.call("operatorListApiKeys", {}),
  });
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["web:read", "api:read"]);
  const [days, setDays] = useState("90");
  const [rate, setRate] = useState("600");
  const [created, setCreated] = useState<ControlPlane.OperatorApiKeyCreated | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      fresh(() =>
        api.call("operatorCreateApiKey", {
          body: {
            label: label.trim(),
            scopes: scopes as ControlPlane.OperatorApiKeyCreate["scopes"],
            expires_in_days: Number(days),
            rate_limit_per_min: Number(rate),
          },
        }),
      ),
    onSuccess: async (k) => {
      setCreated(k);
      setLabel("");
      await qc.invalidateQueries({ queryKey: ["op-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (k: ControlPlane.OperatorApiKey) =>
      fresh(() =>
        api.call("operatorRevokeApiKey", {
          path: { keyId: k.key_id },
          body: { reason: "Revoked in the operator console" },
        }),
      ),
    onSuccess: async () => {
      setAsk(null);
      await qc.invalidateQueries({ queryKey: ["op-keys"] });
      show("Key revoked. Requests with it now fail.");
    },
  });
  const active = keys.data?.filter((k) => !k.revoked_at).length;
  return (
    <>
      <OpIntro
        title="API keys"
        lead="Read-only keys for dashboards, scripts and other tools that pull the global figures. A key sees the same aggregates you do, never more."
      />
      <div className="um-op-kgrid">
        <Card title="Create a read key" icon="plus" tone="wallet">
          {created ? (
            <div className="um-op-created" data-testid="key-created">
              <div className="um-op-created-h">
                <span className="um-tile um-op-tile-g">
                  <Icon name="check" />
                </span>
                <div>
                  <b>Key created: {created.label}</b>
                  <span>
                    {created.scopes.join(" · ")} · expires {fmtDay(created.expires_at)}
                  </span>
                </div>
              </div>
              <div className="um-op-keybox">
                <code data-testid="secret-value">{created.key}</code>
                <Button
                  variant="primary"
                  icon="copy"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(created.key);
                      show("Key copied");
                    } catch {
                      show("Select the key and press Ctrl+C to copy it.");
                    }
                  }}
                >
                  Copy
                </Button>
              </div>
              <p className="um-op-once">
                <Icon name="lock" size="sm" />
                <span>
                  <b>Copy it now; only a hash is stored.</b> Once you leave this panel the key
                  cannot be shown again.
                </span>
              </p>
              <div className="um-op-lead-row">
                <span className="um-op-hint">
                  Send it as <span className="um-op-mono">Authorization: Bearer …</span>
                </span>
                <Button size="sm" onClick={() => setCreated(null)}>
                  I’ve copied it
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="um-op-form"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <div className="um-op-fld">
                <label htmlFor="op-key-label">Name</label>
                <input
                  id="op-key-label"
                  className="um-inp"
                  required
                  maxLength={100}
                  placeholder="Funding review sheet"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <fieldset className="um-op-choices">
                <legend>What it can read</legend>
                {SCOPES.map((s) => (
                  <label key={s.v}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(s.v)}
                      onChange={(e) =>
                        setScopes((x) =>
                          e.target.checked ? [...x, s.v] : x.filter((y) => y !== s.v),
                        )
                      }
                    />
                    <span>{s.label}</span>
                    <code>{s.v}</code>
                  </label>
                ))}
              </fieldset>
              <div className="um-op-row2">
                <div className="um-op-fld">
                  <label htmlFor="op-key-exp">Expires after</label>
                  <select
                    id="op-key-exp"
                    className="um-op-sel"
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                  >
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="180">180 days</option>
                    <option value="365">365 days (maximum)</option>
                  </select>
                </div>
                <div className="um-op-fld">
                  <label htmlFor="op-key-rate">Requests per minute</label>
                  <select
                    id="op-key-rate"
                    className="um-op-sel"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                  >
                    <option value="60">60</option>
                    <option value="120">120</option>
                    <option value="600">600</option>
                    <option value="6000">6000</option>
                  </select>
                </div>
              </div>
              <OpProblem error={create.error} />
              <div>
                <Button
                  variant="primary"
                  type="submit"
                  icon="key"
                  disabled={create.isPending || scopes.length === 0 || !label.trim()}
                >
                  Create key
                </Button>
              </div>
            </form>
          )}
        </Card>
        <Card
          title="Keys"
          flush
          className="um-op-card-flush"
          actions={
            active !== undefined ? <span className="um-card-sub">{active} active</span> : null
          }
        >
          <OpProblem error={revoke.error} />
          <QueryState
            query={keys}
            plain
            isEmpty={(d) => d.length === 0}
            empty={
              <EmptyState plain icon="key" title="No keys yet">
                Create one to pull the global figures from a script.
              </EmptyState>
            }
          >
            {(d) => (
              <TableScroll label="API keys" stickyFirst>
                <table className="um-table um-op-table" data-testid="op-keys">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Access</th>
                      <th scope="col">Last used</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="um-sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.map((k) => (
                      <tr
                        key={k.key_id}
                        className={k.revoked_at ? "um-op-dim" : undefined}
                        data-testid={`key-${k.label}`}
                      >
                        <th scope="row">
                          <PName sub={<span className="um-num">{k.display}</span>}>
                            <b>{k.label}</b>
                          </PName>
                        </th>
                        <td>
                          <span className="um-op-sc">
                            {k.scopes.map((s) => (
                              <Tag key={s}>{s}</Tag>
                            ))}
                          </span>
                          <p className="um-op-hint">
                            {k.tenant_restriction?.length
                              ? `${k.tenant_restriction.length} projects`
                              : "All Stellar ecosystem projects"}{" "}
                            · {k.rate_limit_per_min}/min
                          </p>
                        </td>
                        <td>
                          <PName sub={`Created ${fmtDay(k.created_at)}`}>
                            <span>{k.last_used_at ? fmtDayTime(k.last_used_at) : "Never"}</span>
                          </PName>
                        </td>
                        <td>
                          {k.revoked_at ? (
                            <StatusBadge status="off">Revoked {fmtDay(k.revoked_at)}</StatusBadge>
                          ) : k.flagged_for_review ? (
                            <span
                              className="um-op-chip-org"
                              title="Its creator no longer holds operator access. Revoke it if nobody needs it."
                            >
                              <Icon name="alert" />
                              Review
                            </span>
                          ) : (
                            <StatusBadge status="live">Active</StatusBadge>
                          )}
                          {k.revoked_at ? null : (
                            <p className="um-op-hint">Expires {fmtDay(k.expires_at)}</p>
                          )}
                        </td>
                        <td>
                          <div className="um-op-rowact">
                            {k.revoked_at ? null : ask === k.key_id ? (
                              <span className="um-op-confirm">
                                Revoke now?
                                <Button
                                  variant="danger"
                                  size="sm"
                                  disabled={revoke.isPending}
                                  onClick={() => revoke.mutate(k)}
                                >
                                  Revoke
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setAsk(null)}>
                                  Keep
                                </Button>
                              </span>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="um-op-dz"
                                aria-label={`Revoke ${k.label}`}
                                onClick={() => setAsk(k.key_id)}
                              >
                                Revoke
                              </Button>
                            )}
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
      </div>
      {toast}
    </>
  );
}

// ---------------------------------------------------------------- settings

const SETTING_GROUPS: { title: string; icon: IconName; keys: string[] }[] = [
  {
    title: "Privacy thresholds",
    icon: "shield",
    keys: [
      "op_min_count",
      "op_round_to",
      "tenant_min_count",
      "cohort_min_tenants",
      "ecosystem_percentile_min_tenants",
      "op_rank_min_level",
    ],
  },
  {
    title: "Bots and inflation",
    icon: "filter",
    keys: [
      "multiplicity_mode",
      "multiplicity_thresholds",
      "multiplicity_event_thresholds",
      "pow_cost",
      "pow_max",
      "pow_max_multiplier",
      "trust_weights",
      "trust_algorithm_version",
    ],
  },
  {
    title: "Limits",
    icon: "activity",
    keys: [
      "web_requests_per_min_site",
      "web_requests_per_min_subnet",
      "otlp_requests_per_s",
      "otlp_burst",
      "otlp_bytes_per_s",
      "op_key_requests_per_min",
      "max_services_per_tenant",
      "max_active_ingest_tokens",
      "max_tenants_per_user",
    ],
  },
  {
    title: "Retention and windows",
    icon: "clock",
    keys: ["web_event_retention_days", "public_metrics_window_days", "web_live_window_max_days"],
  },
];
const HIDDEN_KEYS = new Set(["read_only_mode", "enrollment_mode"]);

function valueText(v: unknown): string {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function parseValue(text: string, old: unknown): unknown {
  if (typeof old === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error("Enter a number.");
    return n;
  }
  if (typeof old === "boolean") return text.trim() === "true";
  if (typeof old === "object" && old !== null) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Enter valid JSON.");
    }
  }
  return text.trim();
}

function SettingRow({ s, onSaved }: { s: ControlPlane.Setting; onSaved: (msg: string) => void }) {
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [edit, setEdit] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (value: unknown) =>
      fresh(() => api.call("operatorUpdateSetting", { path: { key: s.key }, body: { value } })),
    onSuccess: async () => {
      setEdit(null);
      await qc.invalidateQueries({ queryKey: ["op-settings"] });
      onSaved("Setting saved");
    },
  });
  return (
    <div className="um-op-set-row" data-testid={`setting-${s.key}`}>
      <div>
        <b>
          {s.description || s.key}
          {s.public ? (
            <span title="Published so anyone can check how figures are made.">
              <Tag>public</Tag>
            </span>
          ) : null}
        </b>
        <small>
          <code>{s.key}</code>
          {s.updated_at ? ` · changed ${fmtDay(s.updated_at)}` : ""}
        </small>
      </div>
      <span className="um-op-set-v">{valueText(s.value)}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Edit ${s.key}`}
        onClick={() => {
          setEdit(edit === null ? valueText(s.value) : null);
          setErr(null);
          save.reset();
        }}
      >
        {edit === null ? "Edit" : "Close"}
      </Button>
      {edit !== null ? (
        <form
          className="um-op-set-edit"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setErr(null);
              save.mutate(parseValue(edit, s.value));
            } catch (x) {
              setErr((x as Error).message);
            }
          }}
        >
          <label htmlFor={`op-set-${s.key}`} className="um-sr">
            New value for {s.key}
          </label>
          <input
            id={`op-set-${s.key}`}
            className="um-inp um-inp--mono"
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
          />
          <Button variant="primary" size="sm" type="submit" disabled={save.isPending}>
            Save
          </Button>
          {err ? (
            <Note tone="bad" role="alert">
              {err}
            </Note>
          ) : null}
          <OpProblem error={save.error} />
        </form>
      ) : null}
    </div>
  );
}

function ReadOnlyCard({
  setting,
  onSaved,
}: {
  setting: ControlPlane.Setting | undefined;
  onSaved: (m: string) => void;
}) {
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const v = setting?.value as { enabled?: boolean; ingest?: string } | undefined;
  const on = !!v?.enabled;
  const save = useMutation({
    mutationFn: () =>
      fresh(() =>
        api.call("operatorUpdateSetting", {
          path: { key: "read_only_mode" },
          body: { value: { enabled: !on, ingest: v?.ingest ?? "accept" } },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["op-settings"] });
      onSaved(on ? "Read-only mode is off" : "Read-only mode is on");
    },
  });
  return (
    <Card
      title="Read-only mode"
      icon="pause"
      tone="neutral"
      actions={
        setting ? <StatusBadge status={on ? "bad" : "live"}>{on ? "On" : "Off"}</StatusBadge> : null
      }
      data-testid="read-only-mode"
    >
      <p className="um-op-hint">
        For maintenance: the portal stops accepting changes. Ingest keeps accepting events unless it
        is paused too
        {v?.ingest ? ` (ingest: ${v.ingest})` : ""}.
      </p>
      {setting ? (
        <div>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {on ? "Turn off read-only mode" : "Turn on read-only mode"}
          </Button>
        </div>
      ) : (
        <p className="um-op-hint">This setting is not available to your account.</p>
      )}
      <OpProblem error={save.error} />
    </Card>
  );
}

export function OperatorSettingsPage() {
  useTitle("Settings");
  const role = useOperatorRole();
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [toast, show] = useToast();
  const mode = useQuery({
    queryKey: ["op-enrollment"],
    queryFn: () => api.call("operatorGetEnrollmentMode", {}),
  });
  const settings = useOpSettings();
  const setMode = useMutation({
    mutationFn: (m: ControlPlane.EnrollmentMode["enrollment_mode"]) =>
      fresh(() => api.call("operatorSetEnrollmentMode", { body: { enrollment_mode: m } })),
    onSuccess: (r) => {
      qc.setQueryData(["op-enrollment"], r);
      show(
        r.enrollment_mode === "open" ? "Enrolment is now open" : "New projects now need approval",
      );
    },
  });
  const cur = mode.data?.enrollment_mode;
  const list = settings.data ?? [];
  const known = new Set(SETTING_GROUPS.flatMap((g) => g.keys));
  const other = list.filter((s) => !known.has(s.key) && !HIDDEN_KEYS.has(s.key));
  const groups = [
    ...SETTING_GROUPS,
    { title: "Other", icon: "gear" as IconName, keys: other.map((s) => s.key) },
  ];
  return (
    <>
      <OpIntro
        title="Settings"
        lead="Platform settings. Values marked public are published so anyone can check how figures are made. Operator admins can change them; every change is audit-logged."
      />
      {role !== "operator_admin" ? (
        <Note icon="lock">
          Your operator role can read these settings. Changes need an operator admin.
        </Note>
      ) : null}
      <div className="um-grid um-g2">
        <Card title="Enrolment" icon="userplus" tone="api" data-testid="enrollment-mode">
          {mode.isPending ? (
            <LoadingState />
          ) : mode.error ? (
            <ErrorState plain error={mode.error} onRetry={() => void mode.refetch()} />
          ) : (
            <fieldset className="um-op-opts">
              <legend className="um-sr">Enrolment mode</legend>
              <label className="um-op-opt">
                <input
                  type="radio"
                  name="op-enrol"
                  checked={cur === "open"}
                  onChange={() => setMode.mutate("open")}
                />
                <span>
                  <b>Open</b>
                  <small>Any Stellar ecosystem project can enrol and start measuring.</small>
                </span>
              </label>
              <label className="um-op-opt">
                <input
                  type="radio"
                  name="op-enrol"
                  checked={cur === "approval_required"}
                  onChange={() => setMode.mutate("approval_required")}
                />
                <span>
                  <b>Approval required</b>
                  <small>New projects wait for an operator.</small>
                </span>
              </label>
            </fieldset>
          )}
          <OpProblem error={setMode.error} />
        </Card>
        <ReadOnlyCard setting={list.find((s) => s.key === "read_only_mode")} onSaved={show} />
      </div>
      {settings.isPending ? (
        <LoadingState />
      ) : settings.error ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        groups.map((g) => {
          const rows = g.keys
            .map((k) => list.find((s) => s.key === k))
            .filter((s): s is ControlPlane.Setting => !!s);
          if (rows.length === 0) return null;
          return (
            <Card
              key={g.title}
              title={g.title}
              icon={g.icon}
              data-testid={g.title === "Privacy thresholds" ? "thresholds" : undefined}
            >
              <div>
                {rows.map((s) => (
                  <SettingRow key={s.key} s={s} onSaved={show} />
                ))}
              </div>
            </Card>
          );
        })
      )}
      {toast}
    </>
  );
}
