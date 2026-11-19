// SPDX-License-Identifier: Apache-2.0
// SCF operator: onboarding coverage of the SCF-awarded registry projects (operatorRegistryCoverage, audited) —
// not enrolled / enrolled / verified / measuring, with the tenant counts behind each status and an invite link per
// project that the operator copies and shares themselves. The platform never contacts a project.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState } from "react";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { CopyButton } from "../../components/CopyButton.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import { ProjectFacts } from "./FindProject.tsx";
import { COVERAGE_TEXT, type CoverageStatus } from "./model.ts";

const ORDER: CoverageStatus[] = ["not_enrolled", "enrolled", "verified", "measuring"];

export function CoveragePage() {
  const id = useId();
  useTitle("Onboarding coverage");
  const search = useSearch({ from: "/app/operator/onboarding" });
  const navigate = useNavigate();
  const [q, setQ] = useState(search.q ?? "");
  const cov = useQuery({
    queryKey: ["op-coverage", search.status ?? null, search.q ?? null],
    queryFn: () =>
      api.call("operatorRegistryCoverage", {
        query: {
          ...(search.status ? { status: search.status } : {}),
          ...(search.q ? { q: search.q } : {}),
        },
      }),
  });
  const set = (next: { status?: CoverageStatus | undefined; q?: string | undefined }) =>
    void navigate({
      to: "/operator/onboarding",
      search: {
        ...(next.status ? { status: next.status } : {}),
        ...(next.q ? { q: next.q } : {}),
      },
    });
  const d = cov.data;
  return (
    <>
      <h1>Onboarding coverage</h1>
      <p>
        Every SCF-awarded project in the public registry and how far it is: enrolled (a project
        declared its domain), verified (domain proven or registry match confirmed), measuring
        (verified, with data in the last {d?.measuring_days ?? 7} days). Copy an invite link to
        share it yourself — nothing is sent from here.
      </p>
      <ProblemAlert error={cov.error} />
      {d ? (
        <div className="tiles" data-testid="coverage-totals">
          <div className="tile">
            <span className="small muted">Projects</span>
            <span className="tile-value">{d.totals.projects}</span>
          </div>
          {ORDER.map((s) => (
            <div className="tile" key={s} data-testid={`coverage-${s}`}>
              <span className="small muted">{COVERAGE_TEXT[s]}</span>
              <span className="tile-value">{d.totals[s]}</span>
            </div>
          ))}
        </div>
      ) : null}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          set({ status: search.status, q: q.trim() || undefined });
        }}
      >
        <div>
          <label htmlFor={`${id}-q`}>Name or domain</label>
          <input id={`${id}-q`} value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${id}-s`}>Status</label>
          <select
            id={`${id}-s`}
            value={search.status ?? ""}
            onChange={(e) =>
              set({
                status: (e.target.value || undefined) as CoverageStatus | undefined,
                q: search.q,
              })
            }
          >
            <option value="">Any</option>
            {ORDER.map((s) => (
              <option key={s} value={s}>
                {COVERAGE_TEXT[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Filter</button>
      </form>
      {d ? (
        <div className="table-wrap">
          <table data-testid="coverage-table">
            <caption>Registry projects ({d.items.length})</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Tenants enrolled
                </th>
                <th scope="col" className="num">
                  Verified
                </th>
                <th scope="col" className="num">
                  Measuring
                </th>
                <th scope="col">Invite link</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.project.registry_project_id}>
                  <td>
                    <strong>{i.project.name}</strong>
                    <ProjectFacts p={i.project} />
                  </td>
                  <td>{COVERAGE_TEXT[i.status]}</td>
                  <td className="num">{i.tenants_enrolled}</td>
                  <td className="num">{i.tenants_verified}</td>
                  <td className="num">{i.tenants_measuring}</td>
                  <td>
                    <CopyButton
                      text={i.invite_url}
                      label={`Copy invite link for ${i.project.name}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
