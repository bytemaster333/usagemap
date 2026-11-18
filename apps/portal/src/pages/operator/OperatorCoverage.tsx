// SPDX-License-Identifier: Apache-2.0
// SCF operator: registry coverage (operatorRegistryCoverage, audited) — which SCF-awarded projects of the public
// registry are in UsageMap: not enrolled / enrolled / verified / measuring (data in the last N days), with the project
// counts behind each status and an invite link per project that the operator copies and shares themselves. The
// platform never contacts a project.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  Button,
  Card,
  EmptyState,
  QueryState,
  StatusBadge,
  TableScroll,
} from "../../components/ui/index.ts";
import { COVERAGE_TEXT, type CoverageStatus } from "../onboard/model.ts";
import { OpIntro, PName, SearchBox, Sel, useToast } from "./kit.tsx";
import { awardLine } from "./model.ts";

const ORDER: CoverageStatus[] = ["not_enrolled", "enrolled", "verified", "measuring"];
const KIND: Record<CoverageStatus, "off" | "wait" | "run" | "live"> = {
  not_enrolled: "off",
  enrolled: "wait",
  verified: "run",
  measuring: "live",
};

export function OperatorCoveragePage() {
  useTitle("Registry coverage");
  const search = useSearch({ from: "/app/operator/onboarding" });
  const navigate = useNavigate();
  const [toast, show] = useToast();
  const [copied, setCopied] = useState<string | null>(null);
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
      search: { ...(next.status ? { status: next.status } : {}), ...(next.q ? { q: next.q } : {}) },
      replace: true,
    });
  const d = cov.data;
  return (
    <>
      <OpIntro
        title="Registry coverage"
        lead="Which SCF-awarded projects are in UsageMap. Copy an invite link for projects that have not enrolled yet and share it yourself; nothing is sent from here."
      />
      <Card
        title="From registry to measuring"
        sub={d ? `Measuring = data in the last ${d.measuring_days} days` : undefined}
      >
        <QueryState query={cov}>
          {(x) => {
            const rows: [string, number, string][] = [
              ["SCF registry projects", x.totals.projects, "um-op-fn-n"],
              ["Enrolled", x.totals.enrolled + x.totals.verified + x.totals.measuring, ""],
              ["Verified", x.totals.verified + x.totals.measuring, "um-op-fn-y"],
              ["Measuring", x.totals.measuring, "um-op-fn-g"],
            ];
            const max = Math.max(1, x.totals.projects);
            return (
              <dl className="um-op-funnel" data-testid="coverage-totals">
                {rows.map(([k, v, cls]) => (
                  <div
                    className="um-op-fn-row"
                    key={k}
                    data-testid={`coverage-${k.toLowerCase().replaceAll(" ", "-")}`}
                  >
                    <dt>{k}</dt>
                    <dd>
                      <svg
                        className={`um-op-fn-trk ${cls}`}
                        viewBox="0 0 100 10"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <rect className="um-op-trk-bg" x="0" y="0" width="100" height="10" />
                        <rect
                          className="um-op-trk-fill"
                          x="0"
                          y="0"
                          width={v > 0 ? Math.max(2, (v / max) * 100) : 0}
                          height="10"
                        />
                      </svg>
                      <span className="um-op-fn-cv">{v}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            );
          }}
        </QueryState>
      </Card>
      <Card title="Registry projects" flush className="um-op-card-flush">
        <div className="um-op-filters">
          <Sel
            label="Status"
            value={search.status ?? ""}
            onChange={(v) =>
              set({ status: (v || undefined) as CoverageStatus | undefined, q: search.q })
            }
          >
            <option value="">Any status</option>
            {ORDER.map((s) => (
              <option key={s} value={s}>
                {COVERAGE_TEXT[s]}
              </option>
            ))}
          </Sel>
          <SearchBox
            value={search.q ?? ""}
            onChange={(v) => set({ status: search.status, q: v || undefined })}
            placeholder="Name or website"
            label="Name or website"
          />
          <span className="um-op-grow" />
          {d ? <span className="um-op-fcount">{d.items.length} projects</span> : null}
        </div>
        <QueryState
          query={cov}
          plain
          isEmpty={(x) => x.items.length === 0}
          empty={<EmptyState plain title="No registry projects match" />}
        >
          {(x) => (
            <TableScroll label="Registry projects" stickyFirst>
              <table className="um-table um-op-table" data-testid="coverage-table">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="um-r">
                      Enrolled
                    </th>
                    <th scope="col" className="um-r">
                      Verified
                    </th>
                    <th scope="col" className="um-r">
                      Measuring
                    </th>
                    <th scope="col">
                      <span className="um-sr">Invite</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {x.items.map((i) => (
                    <tr key={i.project.registry_project_id}>
                      <th scope="row">
                        <PName
                          sub={[awardLine(i.project), i.project.domain].filter(Boolean).join(" · ")}
                        >
                          <b>{i.project.name}</b>
                        </PName>
                      </th>
                      <td>
                        <StatusBadge status={KIND[i.status]}>{COVERAGE_TEXT[i.status]}</StatusBadge>
                      </td>
                      <td className="um-r">{i.tenants_enrolled}</td>
                      <td className="um-r">{i.tenants_verified}</td>
                      <td className="um-r">{i.tenants_measuring}</td>
                      <td>
                        <div className="um-op-rowact">
                          <Button
                            size="sm"
                            icon={copied === i.project.registry_project_id ? "check" : "copy"}
                            aria-label={`Copy invite link for ${i.project.name}`}
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(i.invite_url);
                                setCopied(i.project.registry_project_id);
                                show("Invite link copied");
                              } catch {
                                show(
                                  "Copy failed. Open the project in the registry and share the link from there.",
                                );
                              }
                            }}
                          >
                            {copied === i.project.registry_project_id ? "Copied" : "Copy invite"}
                          </Button>
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
