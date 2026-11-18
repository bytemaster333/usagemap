// SPDX-License-Identifier: Apache-2.0
// SCF operators (operatorListOperators / operatorGrant / operatorRevoke): the people who hold SCF operator access.
// Operators read the global view; operator admins can also remove projects, lift tombstones and change settings.
// Granting and revoking need an operator admin and a passkey step-up; the console opens only once an account has
// two registered passkeys (C-20), which the list shows.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { useFreshAction } from "../../auth/fresh.ts";
import { useMe } from "../../auth/session.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  QueryState,
  TableScroll,
  Tag,
} from "../../components/ui/index.ts";
import { fmtDay } from "../../lib/format.ts";
import { OpIntro, OpProblem, PName, useToast } from "./kit.tsx";
import { MIN_OPERATOR_PASSKEYS } from "./OperatorLayout.tsx";

type Role = ControlPlane.PlatformOperator["role"];

function initials(name: string | null | undefined): string {
  const parts = (name ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "·";
  return (
    (parts[0]?.[0] ?? "") +
    (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? ""))
  ).toUpperCase();
}

export function OperatorOperatorsPage() {
  useTitle("Operators");
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const me = useMe();
  const [toast, show] = useToast();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["op-operators"],
    queryFn: () => api.call("operatorListOperators", {}),
  });
  const grant = useMutation({
    mutationFn: () =>
      fresh(() =>
        api.call("operatorGrant", {
          body: { user_id: user.trim(), role, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    onSuccess: async () => {
      setOpen(false);
      setUser("");
      setNote("");
      await qc.invalidateQueries({ queryKey: ["op-operators"] });
      show("Access granted. They see the console after their next sign-in.");
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => fresh(() => api.call("operatorRevoke", { path: { userId: id } })),
    onSuccess: async () => {
      setAsk(null);
      await qc.invalidateQueries({ queryKey: ["op-operators"] });
      show("Access revoked");
    },
  });
  const admins = (list.data ?? []).filter((o) => o.role === "operator_admin").length;
  const myId = me.data?.user_id;
  return (
    <>
      <OpIntro
        title="Operators"
        lead="People who hold SCF operator access. Operators read the global view; operator admins can also remove projects, lift tombstones and change settings."
        aside={
          <Button
            variant="primary"
            size="sm"
            icon={open ? "x" : "plus"}
            onClick={() => setOpen((x) => !x)}
          >
            {open ? "Close" : "Grant access"}
          </Button>
        }
      />
      {open ? (
        <Card title="Grant operator access" tone="wallet">
          <form
            className="um-op-form"
            onSubmit={(e) => {
              e.preventDefault();
              grant.mutate();
            }}
          >
            <div className="um-op-row2">
              <div className="um-op-fld">
                <label htmlFor="op-grant-user">Account user ID</label>
                <input
                  id="op-grant-user"
                  className="um-inp um-inp--mono"
                  required
                  autoComplete="off"
                  placeholder="The account’s user ID"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
                <small>
                  The account needs {MIN_OPERATOR_PASSKEYS} registered passkeys before the console
                  opens.
                </small>
              </div>
              <div className="um-op-fld">
                <label htmlFor="op-grant-role">Role</label>
                <select
                  id="op-grant-role"
                  className="um-op-sel"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  <option value="operator">Operator</option>
                  <option value="operator_admin">Operator admin</option>
                </select>
              </div>
            </div>
            <div className="um-op-fld">
              <label htmlFor="op-grant-note">Note for the audit log</label>
              <input
                id="op-grant-note"
                className="um-inp"
                maxLength={500}
                placeholder="SCF review committee, Q1 2027"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <OpProblem error={grant.error} />
            <div className="um-op-lead-row">
              <span className="um-op-stepup">
                <Icon name="fingerprint" size="sm" />
                You confirm with your passkey.
              </span>
              <Button variant="primary" type="submit" disabled={grant.isPending || !user.trim()}>
                Grant access
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      <OpProblem error={revoke.error} />
      <Card
        title="Operators"
        flush
        className="um-op-card-flush"
        actions={
          list.data ? (
            <span className="um-card-sub">
              {list.data.length} {list.data.length === 1 ? "person" : "people"}
            </span>
          ) : null
        }
      >
        <QueryState
          query={list}
          plain
          isEmpty={(d) => d.length === 0}
          empty={<EmptyState plain title="No operators" />}
        >
          {(d) => (
            <TableScroll label="Operators" stickyFirst>
              <table className="um-table um-op-table" data-testid="op-operators">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col" className="um-r">
                      Passkeys
                    </th>
                    <th scope="col">Granted</th>
                    <th scope="col">
                      <span className="um-sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.map((o) => {
                    const mine = o.user_id === myId;
                    const lastAdmin = o.role === "operator_admin" && admins < 2;
                    const by = d.find((x) => x.user_id === o.granted_by)?.display_name;
                    return (
                      <tr key={o.user_id}>
                        <th scope="row">
                          <span className="um-op-who">
                            <span
                              className={mine ? "um-op-av um-op-av--me" : "um-op-av"}
                              aria-hidden="true"
                            >
                              {initials(o.display_name)}
                            </span>
                            <b>{o.display_name ?? "Unnamed account"}</b>
                            {mine ? <Tag>you</Tag> : null}
                          </span>
                        </th>
                        <td>
                          {o.role === "operator_admin" ? (
                            <span className="um-op-chip-adm">
                              <Icon name="shield" />
                              Operator admin
                            </span>
                          ) : (
                            <Chip kind="self">Operator</Chip>
                          )}
                        </td>
                        <td className="um-r">
                          {o.passkey_count === undefined ? (
                            "—"
                          ) : o.passkey_count < MIN_OPERATOR_PASSKEYS ? (
                            <span
                              className="um-op-chip-org"
                              title="Two passkeys are required before the console opens."
                            >
                              {o.passkey_count} of {MIN_OPERATOR_PASSKEYS}
                            </span>
                          ) : (
                            o.passkey_count
                          )}
                        </td>
                        <td>
                          <PName
                            sub={
                              by ? `by ${by}` : o.granted_by ? "by another operator" : "at setup"
                            }
                          >
                            <span>{fmtDay(o.granted_at)}</span>
                          </PName>
                        </td>
                        <td>
                          <div className="um-op-rowact">
                            {mine ? null : ask === o.user_id ? (
                              <span className="um-op-confirm">
                                Revoke access?
                                <Button
                                  variant="danger"
                                  size="sm"
                                  disabled={revoke.isPending}
                                  onClick={() => revoke.mutate(o.user_id)}
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
                                disabled={lastAdmin}
                                title={
                                  lastAdmin
                                    ? "At least one operator admin must remain. Grant another admin first."
                                    : undefined
                                }
                                aria-label={`Revoke access of ${o.display_name ?? "this account"}`}
                                onClick={() => setAsk(o.user_id)}
                              >
                                Revoke
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
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
