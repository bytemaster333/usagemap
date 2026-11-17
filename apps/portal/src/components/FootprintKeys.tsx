// SPDX-License-Identifier: Apache-2.0
// Footprint registration keys `scfa_reg_…` (migration 0081): a build tool — the Scaffold Stellar
// post-deploy extension — registers the contracts it deploys as claims, without a portal session. A key has one scope,
// `footprint:register`: it can add `claimed` contracts to this project (optionally on one network) and nothing else; it
// never verifies, removes or reads. Created and revoked by an admin or owner (recent sign-in); shown once; stored as a
// hash. Members and viewers see why they cannot manage keys (the API answers 403).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { ApiError, api } from "../api/client.ts";
import { useFreshAction } from "../auth/fresh.ts";
import { fmtDay, fmtDayTime } from "../lib/format.ts";
import { parseDay } from "../lib/range.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { ProblemAlert } from "./ProblemAlert.tsx";
import { SecretOnce } from "./SecretOnce.tsx";
import { Card } from "./ui/basics.tsx";
import { AccessNotice } from "./ui/states.tsx";

type Key = ControlPlane.FootprintKey;
type Network = "mainnet" | "testnet";

/** The shell lines for the Scaffold Stellar extension (templates/scaffold-stellar). */
export function scaffoldEnv(tenantId: string, key: string): string {
  return `export USAGEMAP_TENANT_ID=${tenantId}\nexport SCF_FOOTPRINT_KEY=${key}`;
}

export function keyState(k: Key, now = Date.now()): string {
  if (k.revoked_at) return `revoked ${fmtDay(k.revoked_at)}`;
  if (k.expires_at && Date.parse(k.expires_at) <= now) return `expired ${fmtDay(k.expires_at)}`;
  if (k.expires_at) return `expires ${fmtDay(k.expires_at)}`;
  return "active";
}

function KeyRow({ tenantId, k }: { tenantId: string; k: Key }) {
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () =>
      fresh(() => api.call("revokeFootprintKey", { path: { tenantId, keyId: k.key_id } })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["footprint-keys", tenantId] });
    },
  });
  const state = keyState(k);
  return (
    <tr
      className={state === "active" || state.startsWith("expires") ? undefined : "muted"}
      data-testid={`footprint-key-${k.label}`}
    >
      <td>{k.label}</td>
      <td>
        <code>{k.display}</code>
      </td>
      <td>{k.network ?? "either"}</td>
      <td>{fmtDay(k.created_at)}</td>
      <td>{k.last_used_at ? fmtDayTime(k.last_used_at) : "never"}</td>
      <td data-testid="footprint-key-state">{state}</td>
      <td>
        {k.revoked_at ? null : (
          <button
            type="button"
            className="um-btn um-btn--ghost um-btn--sm"
            onClick={() => setConfirming(true)}
          >
            Revoke<span className="um-sr"> registration key {k.label}</span>
          </button>
        )}
        <ProblemAlert error={revoke.error} />
        {confirming ? (
          <ConfirmDialog
            title={`Revoke “${k.label}”?`}
            confirmLabel="Revoke registration key"
            danger
            busy={revoke.isPending}
            onConfirm={() => {
              setConfirming(false);
              revoke.mutate();
            }}
            onCancel={() => setConfirming(false)}
          >
            <p>
              Deployments using <code>{k.display}</code> stop registering contracts at once.
              Contracts it already registered stay. This cannot be undone.
            </p>
          </ConfirmDialog>
        ) : null}
      </td>
    </tr>
  );
}

function CreateKey({
  tenantId,
  onCreated,
}: {
  tenantId: string;
  onCreated: (k: ControlPlane.FootprintKeyCreated) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [label, setLabel] = useState("");
  const [network, setNetwork] = useState<"" | Network>("");
  const [expires, setExpires] = useState("");
  const expiryDay = expires ? parseDay(expires) : null;
  const create = useMutation({
    mutationFn: () =>
      fresh(() =>
        api.call("createFootprintKey", {
          path: { tenantId },
          body: {
            label: label.trim(),
            network: network === "" ? null : network,
            expires_at: expiryDay ? expiryDay.toISOString().replace(/\.\d{3}Z$/, "Z") : null,
          },
        }),
      ),
    onSuccess: async (k) => {
      setLabel("");
      setExpires("");
      await qc.invalidateQueries({ queryKey: ["footprint-keys", tenantId] });
      onCreated(k);
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
      <h3 id={`${id}-h`}>Create a registration key</h3>
      <div className="um-p-filters">
        <div>
          <label className="um-p-inline" htmlFor={`${id}-l`}>
            Key label
          </label>
          <input
            className="um-inp"
            id={`${id}-l`}
            required
            maxLength={100}
            value={label}
            placeholder="CI deploys"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div>
          <label className="um-p-inline" htmlFor={`${id}-n`}>
            Key network
          </label>
          <select
            className="um-inp"
            id={`${id}-n`}
            value={network}
            onChange={(e) => setNetwork(e.target.value as "" | Network)}
          >
            <option value="">Mainnet and testnet</option>
            <option value="testnet">Testnet only</option>
            <option value="mainnet">Mainnet only</option>
          </select>
        </div>
        <div>
          <label className="um-p-inline" htmlFor={`${id}-e`}>
            Key expires on (optional, UTC)
          </label>
          <input
            className="um-inp"
            id={`${id}-e`}
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </div>
      </div>
      <p className="um-p-fine">Creating a key asks you to confirm your sign-in.</p>
      <ProblemAlert error={create.error} />
      <p>
        <button
          className="um-btn um-btn--primary um-btn--sm"
          type="submit"
          disabled={create.isPending}
        >
          Create registration key
        </button>
      </p>
    </form>
  );
}

export function FootprintKeys({ tenantId }: { tenantId: string }) {
  const keys = useQuery({
    queryKey: ["footprint-keys", tenantId],
    queryFn: () => api.call("listFootprintKeys", { path: { tenantId } }),
    retry: false,
  });
  const [created, setCreated] = useState<ControlPlane.FootprintKeyCreated | null>(null);
  const forbidden = keys.error instanceof ApiError && keys.error.status === 403;
  return (
    <Card
      title="Registration keys for build tools"
      sub="Your deploy step registers each contract it deploys (Scaffold Stellar extension)"
      icon="code"
      data-testid="footprint-keys"
    >
      <p className="um-p-fine">
        The Scaffold Stellar extension sends each contract it deploys to testnet or mainnet as a
        claim. A registration key can only add claims to this project; it cannot verify, remove or
        read anything. You still prove ownership here.
      </p>
      {forbidden ? (
        <AccessNotice
          kind="read-only"
          title="Only the project's owner and admins manage registration keys"
        >
          <span data-testid="footprint-keys-forbidden">
            Registration keys are credentials. Your role can see the project's numbers but not its
            keys.
          </span>
        </AccessNotice>
      ) : (
        <>
          <ProblemAlert error={keys.error} />
          {created ? (
            <SecretOnce
              label={`New registration key “${created.label}”`}
              secret={created.key}
              onDismiss={() => setCreated(null)}
            >
              <p className="um-p-fine">
                Set these in your shell or CI secrets (never in <code>app/.env</code>), and set{" "}
                <code>register: true</code> under <code>extensions.usagemap</code> in{" "}
                <code>scaffold.yml</code>. Without them the extension only prints what it would
                send.
              </p>
              <pre className="um-secret-v">
                <code data-testid="footprint-key-env">{scaffoldEnv(tenantId, created.key)}</code>
              </pre>
              <CopyButton text={scaffoldEnv(tenantId, created.key)} label="Copy both lines" />
            </SecretOnce>
          ) : null}
          {keys.data && keys.data.length > 0 ? (
            <div className="um-tw-scroll">
              <table className="um-table" data-testid="footprint-key-list">
                <caption className="sr-only">Registration keys</caption>
                <thead>
                  <tr>
                    <th scope="col">Label</th>
                    <th scope="col">Key</th>
                    <th scope="col">Network</th>
                    <th scope="col">Created</th>
                    <th scope="col">Last used</th>
                    <th scope="col">State</th>
                    <th scope="col">
                      <span className="um-sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {keys.data.map((k) => (
                    <KeyRow key={k.key_id} tenantId={tenantId} k={k} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : keys.data ? (
            <p className="um-muted">No registration keys yet.</p>
          ) : null}
          {keys.data ? <CreateKey tenantId={tenantId} onCreated={setCreated} /> : null}
          <p className="um-p-fine">
            Project id for <code>USAGEMAP_TENANT_ID</code>: <code>{tenantId}</code>{" "}
            <CopyButton text={tenantId} label="Copy project id" />
          </p>
        </>
      )}
    </Card>
  );
}
