// SPDX-License-Identifier: Apache-2.0
// Tenant API dashboard additions (2026-11-19 product improvements): requests by Stellar surface (Horizon resources,
// Stellar RPC methods, SEP endpoints — the versioned mapping the API echoes), the SLO / error-budget card against the
// service's objective (default 99.5 %, set by a member), and the per-route CSV download.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { MetricInfo, MetricTile } from "../components/MetricInfo.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { DEFAULT_SLO_TARGET_PCT, fmtMs, fmtRate, sloView } from "../lib/apiFormat.ts";
import { fmtInt } from "../lib/format.ts";

const PCT3 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const PCT1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function SurfacesTable({ data }: { data: ControlPlane.ApiSurfaces }) {
  const total = data.surfaces.reduce((a, s) => a + s.requests, 0);
  return (
    <section className="card" aria-labelledby="surf-h" data-testid="api-surfaces">
      <div className="tile-head">
        <h2 id="surf-h">By Stellar surface</h2>
        <MetricInfo metric="api_surfaces" />
      </div>
      {data.surfaces.length === 0 ? (
        <p className="muted">No requests in this range.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Requests by Stellar surface and group</caption>
            <thead>
              <tr>
                <th scope="col">Surface / group</th>
                <th scope="col" className="num">
                  Requests
                </th>
                <th scope="col" className="num">
                  Share
                </th>
                <th scope="col" className="num">
                  5xx rate
                </th>
                <th scope="col" className="num">
                  p95
                </th>
              </tr>
            </thead>
            {data.surfaces.map((s) => (
              <tbody key={s.surface} data-testid={`surface-${s.surface}`}>
                <tr>
                  <th scope="row">
                    <strong>{s.label}</strong>
                  </th>
                  <td className="num">{fmtInt(s.requests)}</td>
                  <td className="num">{total > 0 ? fmtRate(s.requests / total) : "—"}</td>
                  <td className="num">{fmtRate(s.error_rate_5xx)}</td>
                  <td className="num">{fmtMs(s.latency.p95_ms, s.latency.accuracy_class)}</td>
                </tr>
                {s.groups.map((g) => (
                  <tr key={g.group}>
                    <th scope="row" className="indent">
                      <code>{g.group}</code>
                    </th>
                    <td className="num">{fmtInt(g.requests)}</td>
                    <td className="num">{total > 0 ? fmtRate(g.requests / total) : "—"}</td>
                    <td className="num">{fmtRate(g.error_rate_5xx)}</td>
                    <td className="num">{fmtMs(g.latency.p95_ms, g.latency.accuracy_class)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      <p className="small muted">
        Routes are grouped by mapping <code>{data.mapping_version}</code>: Horizon by resource,
        Stellar RPC by JSON-RPC method (switch on the service's RPC method dimension to see
        methods), SEP endpoints by SEP number. Percentiles are merged per group from the stored
        histograms.
      </p>
    </section>
  );
}

export function SloCard({
  tenantId,
  service,
  summary,
  points,
  canEdit,
}: {
  tenantId: string;
  service: ControlPlane.Service;
  summary: ControlPlane.ApiSummary;
  points: ReadonlyArray<{ t: string; requests: number }>;
  canEdit: boolean;
}) {
  const id = useId();
  const qc = useQueryClient();
  const target = service.slo_target_pct ?? DEFAULT_SLO_TARGET_PCT;
  const v = sloView(summary.status, target, points);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(target));
  const save = useMutation({
    mutationFn: (pct: number) =>
      api.call("updateService", {
        path: { tenantId, serviceId: service.service_id },
        body: { slo_target_pct: pct },
      }),
    onSuccess: (s) => {
      qc.setQueryData(["service", tenantId, service.service_id], s);
      setEditing(false);
    },
  });
  const burnedText =
    v.burned === null
      ? "—"
      : Number.isFinite(v.burned)
        ? `${PCT1.format(v.burned * 100)} %`
        : "budget is zero";
  return (
    <section className="card stack" aria-labelledby={`${id}-h`} data-testid="slo-card">
      <h2 id={`${id}-h`}>Availability objective</h2>
      <div className="tiles">
        <MetricTile
          metric="slo_availability"
          testId="slo-availability"
          label="Availability"
          value={v.availability === null ? "—" : `${PCT3.format(v.availability * 100)} %`}
          sub={`objective ${PCT3.format(target)} %${v.met === null ? "" : v.met ? " · met" : " · missed"}`}
        />
        <MetricTile
          metric="slo_error_budget"
          testId="slo-budget"
          label="Error budget used"
          value={burnedText}
          sub={`${fmtInt(v.bad)} of ${fmtInt(Math.floor(v.budget))} allowed 5xx responses`}
        />
        <MetricTile
          metric="slo_coverage"
          testId="slo-coverage"
          label="Coverage"
          value={v.coverage === null ? "—" : `${PCT1.format(v.coverage * 100)} %`}
          sub={`${v.daysWithData} of ${v.days} days with data`}
        />
      </div>
      <p className="small muted" data-testid="slo-honesty">
        Measured only from the telemetry this service sent (self-attested): good = requests with a
        status code that were not 5xx. Days without data count neither as up nor as down
        {v.noStatus > 0
          ? `; ${fmtInt(v.noStatus)} requests without a status code are left out of the measure`
          : ""}
        {summary.range.sampled_lower_bound
          ? "; span-derived counts are a lower bound (sampling)"
          : ""}
        . This is not an uptime probe.
      </p>
      {canEdit ? (
        editing ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(Number(value));
            }}
          >
            <div>
              <label htmlFor={`${id}-t`}>Objective (%)</label>
              <input
                id={`${id}-t`}
                type="number"
                min={90}
                max={99.999}
                step={0.001}
                required
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div>
              <button type="submit" disabled={save.isPending}>
                Save objective
              </button>{" "}
              <button type="button" className="secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <p>
            <button type="button" className="secondary" onClick={() => setEditing(true)}>
              Change objective
            </button>
          </p>
        )
      ) : null}
      <ProblemAlert error={save.error} />
    </section>
  );
}
