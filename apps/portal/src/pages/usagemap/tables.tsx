// SPDX-License-Identifier: Apache-2.0
// Usage Map tables shared by the SCF operator's project detail and the tenant's own Usage Map: the SCF Growth Hack
// weekly series and the calls per contract function by caller kind (account: top-level invocations; contract: calls
// by other contracts, a lower bound). A withheld or missing count (null) reads "—", never zero.

import type { ControlPlane } from "@usagemap/api-types";
import type { ReactNode } from "react";
import { fmtInt, fmtShare } from "../../lib/format.ts";
import { shortContract } from "../operator/usagemap/model.ts";

export function UsageWeeklyTable({
  weekly,
  caption,
  testId,
}: {
  weekly: readonly ControlPlane.UsageMapWeek[];
  caption: ReactNode;
  testId: string;
}) {
  return (
    <div className="table-wrap">
      <table data-testid={testId}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col" className="num">
              Active accounts
            </th>
            <th scope="col" className="num">
              Successful only
            </th>
            <th scope="col" className="num">
              Invocations
            </th>
            <th scope="col" className="num">
              Contract calls
            </th>
          </tr>
        </thead>
        <tbody>
          {weekly.length === 0 ? (
            <tr>
              <td colSpan={5}>No complete week in this window yet.</td>
            </tr>
          ) : (
            weekly.map((w) => (
              <tr key={w.week_start}>
                <th scope="row">{w.week_start}</th>
                <td className="num">{fmtInt(w.active_accounts)}</td>
                <td className="num">{fmtInt(w.active_accounts_successful)}</td>
                <td className="num">{fmtInt(w.invocations)}</td>
                <td className="num">{fmtInt(w.contract_calls)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function UsageFunctionsTable({
  functions,
  testId,
}: {
  functions: readonly ControlPlane.UsageMapFunction[];
  testId: string;
}) {
  return (
    <div className="table-wrap">
      <table data-testid={testId}>
        <caption>Calls per contract function</caption>
        <thead>
          <tr>
            <th scope="col">Contract</th>
            <th scope="col">Function</th>
            <th scope="col">Caller</th>
            <th scope="col" className="num">
              Calls
            </th>
            <th scope="col" className="num">
              Success
            </th>
          </tr>
        </thead>
        <tbody>
          {functions.length === 0 ? (
            <tr>
              <td colSpan={5}>No contract function was called in this window.</td>
            </tr>
          ) : (
            functions.map((f) => (
              <tr key={`${f.contract_id}/${f.function}/${f.caller_kind}`}>
                <td>
                  <code title={f.contract_id}>{shortContract(f.contract_id)}</code>
                </td>
                <th scope="row">
                  <code>{f.function}</code>
                </th>
                <td>{f.caller_kind === "account" ? "account" : "another contract"}</td>
                <td className="num">{fmtInt(f.calls)}</td>
                <td className="num">
                  {fmtShare(f.calls > 0 ? f.successful_calls / f.calls : null)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
