// SPDX-License-Identifier: Apache-2.0
// Secret-seed leak warning (2026-11-19 product improvements): when Stellar secret seeds appeared in the project's API
// request paths, every project page shows how many, since when and in which services, with what to do. The seeds were
// redacted by the Collector before anything was stored; the platform never had more than a count. A tenant admin
// acknowledges the warning once the keys are rotated; seeds seen afterwards raise it again.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../api/client.ts";
import { fmtDay } from "../lib/format.ts";
import { useTenants } from "./AppShell.tsx";
import { ProblemAlert } from "./ProblemAlert.tsx";

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Stellar's own guide to rotating a key: add a new signer, then remove (weight 0) the leaked one. */
export const ROTATION_GUIDE_URL =
  "https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig";

/** "3 secret seeds appeared in your API request paths since 4 Nov 2026 — rotate those keys". */
export function seedWarningHeadline(
  w: Pick<ControlPlane.SecretSeedWarning, "count" | "since">,
): string {
  const n = INT.format(w.count);
  const noun = w.count === 1 ? "secret seed" : "secret seeds";
  const since = w.since ? ` since ${fmtDay(`${w.since}T00:00:00Z`)}` : "";
  return `${n} Stellar ${noun} appeared in your API request paths${since} — rotate those keys`;
}

export function SecretSeedWarningView({
  warning,
  canAcknowledge,
  onAcknowledge,
  pending,
}: {
  warning: ControlPlane.SecretSeedWarning;
  canAcknowledge: boolean;
  onAcknowledge?: () => void;
  pending?: boolean;
}) {
  if (warning.count <= 0) return null;
  return (
    <section
      className="alert error stack"
      aria-label="Secret-seed warning"
      data-testid="seed-warning"
    >
      <strong>{seedWarningHeadline(warning)}</strong>
      <p className="small">
        A secret seed (starting with <code>S</code>) controls a Stellar account. Anyone who saw
        those requests — proxies, load balancers, server logs, browser history — may hold it. We
        replaced each seed with <code>{"{redacted}"}</code> before storing anything; we keep only
        this count, never the seed or any part of it.
        {warning.last_seen ? ` Last seen ${fmtDay(`${warning.last_seen}T00:00:00Z`)}.` : ""}
      </p>
      {warning.services.length > 0 && (
        <ul className="small" data-testid="seed-warning-services">
          {warning.services.map((s) => (
            <li key={s.service_id}>
              {s.service_name ?? "a service that is not registered (or no longer)"}:{" "}
              {INT.format(s.count)}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>What to do</summary>
        <ol className="small">
          <li>
            For each affected account, add a new signer (or move the funds to a new account) and
            then remove the leaked key by setting its weight to 0 —{" "}
            <a href={ROTATION_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              Stellar’s guide to signers
            </a>
            .
          </li>
          <li>
            Change the client that sent it: a seed belongs in a server-side secret store, never in a
            URL, a query string or a path. Sign transactions where the key lives and send only the
            signed transaction.
          </li>
          <li>Ask whoever runs your proxies and log storage to purge those request logs.</li>
          <li>
            When the keys are rotated, acknowledge this warning; new seeds will raise it again.
          </li>
        </ol>
      </details>
      {canAcknowledge ? (
        <div>
          <button type="button" onClick={onAcknowledge} disabled={pending}>
            Keys rotated — acknowledge
          </button>
        </div>
      ) : (
        <p className="small muted">
          A project admin can acknowledge this warning once the keys are rotated.
        </p>
      )}
    </section>
  );
}

export function SecretSeedBanner({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const role = useTenants().data?.find((t) => t.tenant_id === tenantId)?.role;
  const warning = useQuery({
    queryKey: ["secret-seed-warning", tenantId],
    queryFn: () => api.call("getSecretSeedWarning", { path: { tenantId } }),
    staleTime: 60_000,
  });
  const ack = useMutation({
    mutationFn: () => api.call("acknowledgeSecretSeedWarning", { path: { tenantId } }),
    onSuccess: (w) => qc.setQueryData(["secret-seed-warning", tenantId], w),
  });
  // A failed read shows nothing: the banner must never block the page it sits on.
  if (!warning.data) return null;
  return (
    <>
      <SecretSeedWarningView
        warning={warning.data}
        canAcknowledge={role === "owner" || role === "admin"}
        onAcknowledge={() => ack.mutate()}
        pending={ack.isPending}
      />
      {ack.error && <ProblemAlert error={ack.error} />}
    </>
  );
}
