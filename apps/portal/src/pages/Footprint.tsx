// SPDX-License-Identifier: Apache-2.0
// Registered Footprint, set-up step (C-135, C-136, C-137): only the contract part is
// built so far. A project registers the Soroban contracts it controls (`addFootprintItem` kind `contract`), asks
// for the ownership check (`deployer_admin_match`: the deployer or admin of the contract is the project's verified
// Stellar account), or declares that it has no Stellar footprint. A contract verified for two projects is flagged for
// both ("conflict — under review") and counted nowhere until an SCF operator resolves it. Accounts and WASM hashes stay
// in the contract but are not offered here until they are counted, so nothing is collected that would not be counted.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { FootprintKeys } from "../components/FootprintKeys.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { fmtDay, fmtDayTime } from "../lib/format.ts";
import { OnchainHeader, OnchainTabs } from "./project/Onchain.tsx";
import { TenantNav } from "./TenantNav.tsx";

type Item = ControlPlane.FootprintItem;

export const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

export const REJECTED_TEXT: Record<NonNullable<Item["rejected_reason"]>, string> = {
  not_listed_in_toml: "not listed in your stellar.toml",
  toml_unreachable: "your stellar.toml could not be read",
  no_verified_domain: "the project has no verified domain",
  signature_invalid: "the signature did not verify",
  challenge_expired: "the challenge expired",
  not_deployer_or_admin:
    "neither its deployer nor its admin is a Stellar account your project has proven",
  not_found_on_ledger: "the contract was not found on the ledger",
  claimed_by_other_tenant: "an SCF operator assigned it to another project",
};

/** The state a person reads: conflict first (it overrides `verified`), then the status. */
export function itemState(i: Item): { text: string; tone: "good" | "warn" | "bad" | "" } {
  if (i.conflict_since) return { text: "conflict — under review", tone: "warn" };
  if (i.status === "verified") return { text: "verified", tone: "good" };
  if (i.status === "rejected")
    return {
      text: `rejected${i.rejected_reason ? `: ${REJECTED_TEXT[i.rejected_reason]}` : ""}`,
      tone: "bad",
    };
  return { text: "claimed, not yet verified", tone: "" };
}

function ContractRow({ tenantId, item }: { tenantId: string; item: Item }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["footprint", tenantId] });
  const verify = useMutation({
    mutationFn: () =>
      api.call("verifyFootprintItem", {
        path: { tenantId, itemId: item.item_id },
        body: { method: "deployer_admin_match" },
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.call("removeFootprintItem", { path: { tenantId, itemId: item.item_id } }),
    onSuccess: refresh,
  });
  const state = itemState(item);
  const short = item.subject ? `${item.subject.slice(0, 6)}…${item.subject.slice(-4)}` : "—";
  return (
    <tr data-testid={`footprint-${item.subject ?? item.item_id}`}>
      <td>
        <code title={item.subject ?? undefined}>{short}</code>
        {item.label ? <span className="small muted"> {item.label}</span> : null}
      </td>
      <td>{item.network}</td>
      <td>
        <span
          className={state.tone ? `badge ${state.tone}` : "badge"}
          data-testid="footprint-state"
        >
          {state.text}
        </span>
        {item.conflict_since ? (
          <p className="small muted" data-testid="footprint-conflict">
            Since {fmtDay(item.conflict_since)} this contract is verified for another project too.
            It is counted for neither until an SCF operator decides; you need not do anything.
          </p>
        ) : null}
        {item.verified_at ? (
          <p className="small muted">verified {fmtDayTime(item.verified_at)}</p>
        ) : null}
      </td>
      <td>
        <div className="row">
          {item.status !== "verified" ? (
            <button type="button" onClick={() => verify.mutate()} disabled={verify.isPending}>
              Check ownership<span className="sr-only"> of {short}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="secondary"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            Remove<span className="sr-only"> {short}</span>
          </button>
        </div>
        <ProblemAlert error={verify.error ?? remove.error} />
      </td>
    </tr>
  );
}

export function FootprintStep({ tenantId }: { tenantId: string }) {
  const id = useId();
  const qc = useQueryClient();
  const tenant = useQuery({
    queryKey: ["tenant", tenantId],
    queryFn: () => api.call("getTenant", { path: { tenantId } }),
  });
  const items = useQuery({
    queryKey: ["footprint", tenantId],
    queryFn: () => api.call("listFootprint", { path: { tenantId } }),
  });
  const [contract, setContract] = useState("");
  const [network, setNetwork] = useState<"mainnet" | "testnet">("mainnet");
  const [label, setLabel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.call("addFootprintItem", {
        path: { tenantId },
        body: {
          kind: "contract",
          subject: contract.trim(),
          network,
          ...(label.trim() ? { label: label.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      setContract("");
      setLabel("");
      await qc.invalidateQueries({ queryKey: ["footprint", tenantId] });
      await qc.invalidateQueries({ queryKey: ["tenant", tenantId] });
    },
  });
  const none = useMutation({
    mutationFn: (v: boolean) =>
      api.call("updateTenant", { path: { tenantId }, body: { footprint_none_declared: v } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tenant", tenantId] });
    },
  });
  // Contracts only (C-137); other kinds are not shown until they are counted.
  const contracts = (items.data ?? []).filter((i) => i.kind === "contract");
  const declaredNone = tenant.data?.footprint_none_declared === true;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`} data-testid="footprint-step">
      <h2 id={`${id}-h`}>Your Stellar contracts</h2>
      <p>
        Register the Soroban contracts your project deploys or administers, so its on-chain activity
        can be counted next to its web and API figures. Register{" "}
        <strong>only addresses your project controls</strong> — never the addresses of your users.
        We check ownership on the ledger: the contract's deployer or admin must be a Stellar account
        your project has proven (see Verification).
      </p>
      <ProblemAlert error={items.error ?? tenant.error} />
      {tenant.data?.footprint_status ? (
        <p data-testid="footprint-status">
          Step status:{" "}
          <strong>
            {
              {
                missing: "not done yet",
                none_declared: "no Stellar footprint declared",
                claimed: "contracts registered, none verified yet",
                verified: "at least one contract verified",
              }[tenant.data.footprint_status]
            }
          </strong>
        </p>
      ) : null}
      {contracts.length > 0 ? (
        <div className="table-wrap">
          <table data-testid="footprint-contracts">
            <caption className="sr-only">Registered contracts</caption>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Network</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((i) => (
                <ContractRow key={i.item_id} tenantId={tenantId} item={i} />
              ))}
            </tbody>
          </table>
        </div>
      ) : items.data ? (
        <p>No contracts registered yet.</p>
      ) : null}
      <form
        className="stack"
        aria-label="Register a contract"
        onSubmit={(e) => {
          e.preventDefault();
          if (!CONTRACT_ID.test(contract.trim()))
            return setFormError("A contract id is 56 characters starting with C (strkey).");
          setFormError(null);
          add.mutate();
        }}
      >
        <div className="row">
          <div>
            <label htmlFor={`${id}-c`}>Contract id</label>
            <input
              id={`${id}-c`}
              value={contract}
              spellCheck={false}
              autoComplete="off"
              placeholder="C…"
              onChange={(e) => setContract(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label htmlFor={`${id}-n`}>Network</label>
            <select
              id={`${id}-n`}
              value={network}
              onChange={(e) => setNetwork(e.target.value as "mainnet" | "testnet")}
            >
              <option value="mainnet">Mainnet</option>
              <option value="testnet">Testnet</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-l`}>Label (optional)</label>
            <input
              id={`${id}-l`}
              value={label}
              maxLength={100}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <button type="submit" disabled={add.isPending}>
            Register contract
          </button>
        </div>
        {formError ? (
          <p className="alert error" role="alert">
            {formError}
          </p>
        ) : null}
        <ProblemAlert error={add.error} />
      </form>
      <label className="inline">
        <input
          type="checkbox"
          checked={declaredNone}
          disabled={none.isPending || contracts.length > 0}
          onChange={(e) => none.mutate(e.target.checked)}
        />
        My project has no Stellar contracts (for example a pure web or API product)
      </label>
      <ProblemAlert error={none.error} />
      <p className="small muted">
        Only verified contracts are counted, on mainnet and testnet separately. Testnet activity is
        never shown as usage.
      </p>
    </section>
  );
}

export function FootprintWizardPage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  useTitle("Footprint");
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <OnchainHeader sub="Footprint · the contracts and accounts that count as your project" />
      <OnchainTabs tenantId={tenantId} />
      <h2 className="um-sr">Register your Stellar contracts</h2>
      <FootprintStep tenantId={tenantId} />
      <FootprintKeys tenantId={tenantId} />
    </>
  );
}
