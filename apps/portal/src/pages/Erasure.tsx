// SPDX-License-Identifier: Apache-2.0
// Tenant-triggered erasure (privacy.tenant-erasure, ADR-0030, docs/privacy/erasure.md): request → count preview → confirm with a fresh
// sign-in (C-87) → status → completion report. A request covers a time range (whole UTC days) and at most one selector
// — a path pattern, a custom-event name or (websites only) an event property key — or a whole website, service or
// project. The literal selector is echoed back only until it is redacted (job end + 56 days, C-88/C-112) and is never
// written to the audit log; erased data leaves all backups within 56 days (C-112).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { useFreshAction } from "../auth/fresh.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { Button, Card, Note } from "../components/ui/basics.tsx";
import { TableScroll } from "../components/ui/controls.tsx";
import {
  AccessNotice,
  EmptyState,
  ErrorState,
  isForbidden,
  LoadingState,
} from "../components/ui/states.tsx";
import { fmtDayTime, fmtInt, fmtRange } from "../lib/format.ts";
import { customRange, dayString } from "../lib/range.ts";
import { SettingsHeader } from "./project/Settings.tsx";
import { useServices } from "./Services.tsx";
import { TenantNav } from "./TenantNav.tsx";

type Erasure = ControlPlane.ErasureRequest;
type Counts = ControlPlane.ErasureCounts;

export const ERASURE_STATUS_TEXT: Record<Erasure["status"], string> = {
  previewing: "Counting what would be erased…",
  previewed: "Preview ready — waiting for your confirmation",
  confirmed: "Confirmed — queued",
  running: "Erasing…",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const SELECTOR_TEXT: Record<ControlPlane.ErasureSelectorSummary["type"], string> = {
  path_pattern: "page path pattern",
  event_name: "custom-event name",
  property_key: "event property key",
};

const COUNT_ROWS: { key: keyof Counts; label: string }[] = [
  { key: "website_events", label: "Website events (page views and custom events)" },
  { key: "event_data_rows", label: "Event properties" },
  { key: "sessions_orphaned", label: "Visits left without events (removed too)" },
  { key: "breakdown_rows", label: "Daily breakdown rows recomputed" },
  { key: "api_routes", label: "API routes" },
  { key: "api_metric_rows", label: "API metric rows (1-minute, 1-hour and 1-day)" },
];

export function CountsTable({
  counts,
  caption,
  testId,
}: {
  counts: Counts;
  caption: string;
  testId: string;
}) {
  return (
    <table data-testid={testId}>
      <caption>{caption}</caption>
      <tbody>
        {COUNT_ROWS.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.label}</th>
            <td className="num">{fmtInt(counts[r.key] as number | undefined)}</td>
          </tr>
        ))}
        <tr>
          <th scope="row">Days whose totals are recomputed</th>
          <td className="num">{(counts.aggregate_days ?? []).join(", ") || "none"}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** What the request covers, without ever inventing a redacted selector. */
export function describeCriteria(e: Erasure): string {
  const c = e.criteria;
  const span = fmtRange(c.start, c.end);
  const literal = c.path_pattern ?? c.event_name ?? c.property_key ?? null;
  if (e.scope === "tenant") return `Everything in this project, ${span}`;
  if (e.scope === "site") return `The whole website, ${span}`;
  if (e.scope === "service") return `The whole API service, ${span}`;
  if (!e.selector) return `Everything in the ${e.site_id ? "website" : "service"}, ${span}`;
  if (literal !== null) return `${SELECTOR_TEXT[e.selector.type]} “${literal}”, ${span}`;
  return `${SELECTOR_TEXT[e.selector.type]} (redacted, ${e.selector.length} characters), ${span}`;
}

type Target = "site" | "service";
type Selector = "none" | "path_pattern" | "event_name" | "property_key";

function CreateErasure({ tenantId }: { tenantId: string }) {
  const id = useId();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const sites = useQuery({
    queryKey: ["sites", tenantId],
    queryFn: () => api.call("listSites", { path: { tenantId } }),
  });
  const services = useServices(tenantId);
  const [target, setTarget] = useState<Target | "tenant">("site");
  const [objectId, setObjectId] = useState("");
  const [whole, setWhole] = useState(false);
  const [selector, setSelector] = useState<Selector>("path_pattern");
  const [value, setValue] = useState("");
  const today = dayString(new Date());
  const [from, setFrom] = useState(dayString(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(today);
  const [formError, setFormError] = useState<string | null>(null);
  const objects =
    target === "site"
      ? (sites.data ?? []).map((s) => ({ id: s.site_id, name: s.name }))
      : target === "service"
        ? (services.data ?? []).map((s) => ({
            id: s.service_id,
            name: s.display_name ?? s.service_name,
          }))
        : [];
  const chosen = objectId || objects[0]?.id || "";
  const create = useMutation({
    mutationFn: (body: ControlPlane.ErasureRequestCreate) =>
      api.call("createErasureRequest", { path: { tenantId }, body }),
    onSuccess: async (e) => {
      await qc.invalidateQueries({ queryKey: ["erasures", tenantId] });
      void navigate({
        to: "/t/$tenantId/erasure/$requestId",
        params: { tenantId, requestId: e.request_id },
      });
    },
  });
  const submit = () => {
    const r = customRange(from, to);
    if ("error" in r) return setFormError(r.error);
    if (target !== "tenant" && !chosen) return setFormError("Choose a website or service.");
    const filtered = target !== "tenant" && !whole;
    if (filtered && selector !== "none" && value.trim() === "")
      return setFormError("Enter the value to match, or choose “everything in the range”.");
    if (filtered && selector === "path_pattern" && !value.trim().startsWith("/"))
      return setFormError("A path pattern starts with “/”, e.g. /users/*.");
    setFormError(null);
    const criteria: ControlPlane.ErasureCriteria = { start: r.start, end: r.end };
    if (filtered && selector !== "none") criteria[selector] = value.trim();
    create.mutate({
      ...(target === "site"
        ? { site_id: chosen }
        : target === "service"
          ? { service_id: chosen }
          : {}),
      scope: target === "tenant" ? "tenant" : whole ? target : "filtered",
      criteria,
    });
  };
  return (
    <Card
      title="New erasure request"
      sub="Nothing is erased yet: you will first see how much data matches, then confirm."
      icon="eraser"
    >
      <form
        className="um-p-form"
        aria-label="New erasure request"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset className="um-p-fieldset">
          <legend>Erase data of</legend>
          {(
            [
              ["site", "One website"],
              ["service", "One API service"],
              ["tenant", "The whole project (all websites and services)"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="um-p-check">
              <input
                type="radio"
                name={`${id}-t`}
                checked={target === v}
                onChange={() => {
                  setTarget(v);
                  setObjectId("");
                  if (v === "service" && selector === "property_key") setSelector("path_pattern");
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {target !== "tenant" ? (
          <div className="um-p-filters">
            <div className="um-p-inline">
              <label htmlFor={`${id}-o`}>{target === "site" ? "Website" : "API service"}</label>
              <select
                className="um-inp"
                id={`${id}-o`}
                value={chosen}
                onChange={(e) => setObjectId(e.target.value)}
              >
                {objects.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        <div className="um-p-filters">
          <div className="um-p-inline">
            <label htmlFor={`${id}-f`}>First day (UTC)</label>
            <input
              className="um-inp"
              id={`${id}-f`}
              type="date"
              value={from}
              max={today}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="um-p-inline">
            <label htmlFor={`${id}-to`}>Last day (UTC)</label>
            <input
              className="um-inp"
              id={`${id}-to`}
              type="date"
              value={to}
              max={today}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        {target !== "tenant" ? (
          <fieldset className="um-p-fieldset">
            <legend>What to erase in that range</legend>
            <label className="um-p-check">
              <input
                type="radio"
                name={`${id}-w`}
                checked={whole}
                onChange={() => setWhole(true)}
              />
              Everything of this {target === "site" ? "website" : "service"}
            </label>
            <label className="um-p-check">
              <input
                type="radio"
                name={`${id}-w`}
                checked={!whole}
                onChange={() => setWhole(false)}
              />
              Only matching data
            </label>
            {!whole ? (
              <div className="um-p-filters">
                <div className="um-p-inline">
                  <label htmlFor={`${id}-s`}>Match by</label>
                  <select
                    className="um-inp"
                    id={`${id}-s`}
                    value={selector}
                    onChange={(e) => setSelector(e.target.value as Selector)}
                  >
                    <option value="path_pattern">
                      {target === "site" ? "Page path pattern" : "Route pattern"}
                    </option>
                    {target === "site" ? (
                      <option value="event_name">Custom-event name</option>
                    ) : null}
                    {target === "site" ? (
                      <option value="property_key">Event property key</option>
                    ) : null}
                    <option value="none">Everything in the range</option>
                  </select>
                </div>
                {selector !== "none" ? (
                  <div className="um-p-inline">
                    <label htmlFor={`${id}-v`}>Value</label>
                    <input
                      className="um-inp um-inp--mono"
                      id={`${id}-v`}
                      value={value}
                      maxLength={512}
                      autoComplete="off"
                      placeholder={selector === "path_pattern" ? "/users/jane-doe/*" : ""}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {!whole && selector === "path_pattern" ? (
              <p className="um-p-fine">
                <code>*</code> matches any run of characters, including <code>/</code>.
              </p>
            ) : null}
          </fieldset>
        ) : null}
        <p className="um-p-fine">
          The value you enter is used to find the data and is removed from our records 56 days after
          the job ends; the audit log only ever records its type and length.
        </p>
        {formError ? (
          <Note tone="bad" role="alert">
            {formError}
          </Note>
        ) : null}
        <ProblemAlert error={create.error} />
        <div>
          <Button type="submit" variant="primary" icon="eye" disabled={create.isPending}>
            Preview erasure
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function ErasureListPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/erasure" });
  useTitle("Data erasure");
  const list = useQuery({
    queryKey: ["erasures", tenantId],
    queryFn: () => api.call("listErasureRequests", { path: { tenantId }, query: { limit: 50 } }),
  });
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <SettingsHeader tenantId={tenantId} current="danger" />
      <h2 className="um-h2">Data erasure</h2>
      <p className="um-muted">
        If personal data reached your analytics — for example a name in a page path or an e-mail
        address in an event property — erase it here. Erasure removes the matching events from the
        analytics engine and recomputes the daily totals; erased data leaves all backups within 56
        days.
      </p>
      <Card title="Requests" icon="list" flush={(list.data?.items.length ?? 0) > 0}>
        {isForbidden(list.error) ? (
          <AccessNotice
            kind="read-only"
            title="Only the project's owner and admins see erasure requests"
          >
            Requests can name personal data that reached your analytics. Your role can see the
            project's numbers but not these requests.
          </AccessNotice>
        ) : list.error ? (
          <ErrorState error={list.error} plain onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <LoadingState />
        ) : list.data.items.length === 0 ? (
          <EmptyState plain title="No erasure requests yet" icon="eraser" />
        ) : (
          <TableScroll label="Erasure requests">
            <table className="um-table">
              <caption className="um-sr">Erasure requests</caption>
              <thead>
                <tr>
                  <th scope="col">Requested</th>
                  <th scope="col">Covers</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((e) => (
                  <tr key={e.request_id}>
                    <td>
                      <Link
                        to="/t/$tenantId/erasure/$requestId"
                        params={{ tenantId, requestId: e.request_id }}
                      >
                        {fmtDayTime(e.created_at)}
                      </Link>
                    </td>
                    <td>{describeCriteria(e)}</td>
                    <td>{ERASURE_STATUS_TEXT[e.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>
      <CreateErasure tenantId={tenantId} />
    </>
  );
}

export function ErasureDetailPage() {
  const { tenantId, requestId } = useParams({ from: "/app/t/$tenantId/erasure/$requestId" });
  useTitle("Erasure request");
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [confirming, setConfirming] = useState(false);
  const key = ["erasure", tenantId, requestId];
  const req = useQuery({
    queryKey: key,
    queryFn: () => api.call("getErasureRequest", { path: { tenantId, requestId } }),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "previewing" || s === "confirmed" || s === "running" ? 1000 : false;
    },
  });
  const done = (e: Erasure) => {
    qc.setQueryData(key, e);
    void qc.invalidateQueries({ queryKey: ["erasures", tenantId] });
  };
  const confirm = useMutation({
    mutationFn: () =>
      fresh(() => api.call("confirmErasureRequest", { path: { tenantId, requestId } })),
    onSuccess: done,
  });
  const cancel = useMutation({
    mutationFn: () => api.call("cancelErasureRequest", { path: { tenantId, requestId } }),
    onSuccess: done,
  });
  const e = req.data;
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <SettingsHeader tenantId={tenantId} current="danger" />
      <p className="um-p-fine">
        <Link className="um-link" to="/t/$tenantId/erasure" params={{ tenantId }}>
          ← All erasure requests
        </Link>
      </p>
      <h2 className="um-h2">Erasure request</h2>
      <ProblemAlert error={req.error} />
      {e ? (
        <div className="stack">
          <p>
            <strong>Covers:</strong> <span data-testid="erasure-covers">{describeCriteria(e)}</span>
          </p>
          <p role="status" data-testid="erasure-status">
            <strong>Status:</strong> {ERASURE_STATUS_TEXT[e.status]}
            {e.failure_code ? ` (${e.failure_code})` : ""}
          </p>
          {e.preview && e.status === "previewed" ? (
            <section className="card stack" aria-labelledby="pv-h">
              <h2 id="pv-h">Preview</h2>
              <CountsTable
                counts={e.preview}
                caption="What would be erased"
                testId="erasure-preview"
              />
              <p>
                Erasing is permanent. Confirming needs a fresh sign-in (or your passkey) from the
                last 10 minutes.
              </p>
              <div className="row">
                <button type="button" className="danger" onClick={() => setConfirming(true)}>
                  Erase this data
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  Cancel request
                </button>
              </div>
              <ProblemAlert error={confirm.error ?? cancel.error} />
            </section>
          ) : null}
          {e.status === "completed" && e.result ? (
            <section className="card stack" aria-labelledby="rp-h" data-testid="erasure-report">
              <h2 id="rp-h">Completion report</h2>
              <p>
                Requested {fmtDayTime(e.created_at)}
                {e.confirmed_at ? `, confirmed ${fmtDayTime(e.confirmed_at)}` : ""}
                {e.completed_at ? `, completed ${fmtDayTime(e.completed_at)}` : ""}.
              </p>
              <CountsTable counts={e.result} caption="Erased" testId="erasure-result" />
              <p data-testid="backup-note">
                {e.backup_expiry_note ?? "Erased data leaves all backups within 56 days."}
              </p>
              <p className="small muted">
                {e.selector_redacted_at
                  ? `The matching value was removed from our records on ${fmtDayTime(e.selector_redacted_at)}; only its type and length remain.`
                  : "The matching value is kept for 56 days after the job ended, so the erasure can be re-applied if a backup is restored; then it is removed."}
              </p>
            </section>
          ) : null}
          {e.status === "failed" ? (
            <p className="alert error">
              The erasure failed{e.failure_code ? ` (${e.failure_code})` : ""}. Nothing is left half
              done; create a new request or contact the SCF operators.
            </p>
          ) : null}
        </div>
      ) : null}
      {confirming && e ? (
        <ConfirmDialog
          title="Erase this data permanently?"
          confirmLabel="Erase permanently"
          danger
          typeToConfirm="erase"
          busy={confirm.isPending}
          onConfirm={() => {
            setConfirming(false);
            confirm.mutate();
          }}
          onCancel={() => setConfirming(false)}
        >
          <p>{describeCriteria(e)}.</p>
          <p>
            {fmtInt(e.preview?.website_events)} website events and{" "}
            {fmtInt(e.preview?.api_metric_rows)} API metric rows will be erased. This cannot be
            undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
