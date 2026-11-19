// SPDX-License-Identifier: Apache-2.0
// Keys (approved design): every credential of the project in one place.
//   - Ingest tokens (operator.api-global-access support for dashboard.api-*, isolation.api-dashboard, operator.api-*; C-21, wire-formats §k): at most five active per project, optionally
//     limited to some service names and to an expiry; the secret is shown once and only its display form afterwards;
//     revocation reaches the edge within 60 s; tokens older than 12 months carry a rotation reminder.
//   - Share keys (share.signed-usage-report, C-129): read-only access to the metrics document, for anyone you choose and AI assistants.
//   - Footprint registration keys (migration 0081): build tools register contracts after a deploy.
// Creating and revoking need recent authentication (C-119, C-129): the fresh sign-in or passkey is asked for up front
// (auth/fresh.ts). A viewer's refused write shows the read-only notice.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { type ReactNode, useState } from "react";
import { api } from "../api/client.ts";
import { useFreshAction } from "../auth/fresh.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { FootprintKeys } from "../components/FootprintKeys.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { SecretOnce } from "../components/SecretOnce.tsx";
import {
  AccessNotice,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  isForbidden,
  LoadingState,
  Note,
  PageHeader,
  StatusBadge,
} from "../components/ui/index.ts";
import { fmtDay, fmtDayTime } from "../lib/format.ts";
import { parseDay } from "../lib/range.ts";
import { ProjectFrame } from "./project/common.tsx";
import { useServices } from "./Services.tsx";

export const MAX_ACTIVE_TOKENS = 5;

export function useTokens(tenantId: string) {
  return useQuery({
    queryKey: ["ingest-tokens", tenantId],
    queryFn: () => api.call("listIngestTokens", { path: { tenantId } }),
  });
}

const isoDay = (d: Date | null) => (d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : null);

/** Creation form; the created token (with its secret) goes to `onCreated` and nowhere else. */
export function CreateToken({
  tenantId,
  defaultServices = [],
  onCreated,
  onCancel,
}: {
  tenantId: string;
  defaultServices?: string[];
  onCreated: (t: ControlPlane.IngestTokenCreated) => void;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const services = useServices(tenantId);
  const [label, setLabel] = useState("");
  const [limit, setLimit] = useState<string[]>(defaultServices);
  const [expires, setExpires] = useState("");
  const fresh = useFreshAction();
  const create = useMutation({
    mutationFn: () =>
      fresh(() =>
        api.call("createIngestToken", {
          path: { tenantId },
          body: {
            label: label.trim(),
            allowed_service_names: limit.length > 0 ? limit : null,
            expires_at: isoDay(expires ? parseDay(expires) : null),
          },
        }),
      ),
    onSuccess: async (t) => {
      setLabel("");
      await qc.invalidateQueries({ queryKey: ["ingest-tokens", tenantId] });
      onCreated(t);
    },
  });
  return (
    <form
      className="um-p-annform"
      aria-label="Create an ingest token"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="um-grid um-g2">
        <Field label="Label">
          <input
            className="um-inp"
            required
            maxLength={100}
            value={label}
            placeholder="production collector"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Expires on (optional, UTC)">
          <input
            className="um-inp"
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </Field>
      </div>
      {services.data && services.data.length > 0 ? (
        <fieldset className="um-p-fieldset">
          <legend>Limit to services (optional)</legend>
          {services.data.map((s) => (
            <label key={s.service_id} className="um-p-check">
              <input
                type="checkbox"
                checked={limit.includes(s.service_name)}
                onChange={(e) =>
                  setLimit((l) =>
                    e.target.checked
                      ? [...l, s.service_name]
                      : l.filter((x) => x !== s.service_name),
                  )
                }
              />
              {s.service_name}
            </label>
          ))}
          <p className="um-p-fine">
            Without a limit the token may send data for any service name (new names are registered
            automatically up to your service limit).
          </p>
        </fieldset>
      ) : null}
      <ProblemAlert error={create.error} />
      <div className="um-p-tools">
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
          Create token
        </Button>
      </div>
    </form>
  );
}

/** One credential row: label, display form, dates, state and the revoke action. */
function KeyRow({
  testId,
  label,
  display,
  meta,
  state,
  stateTestId,
  revoked,
  revokeName,
  onRevoke,
  error,
  dialog,
}: {
  testId: string;
  label: string;
  display: string;
  meta: ReactNode;
  state: ReactNode;
  stateTestId?: string | undefined;
  revoked: boolean;
  revokeName: string;
  onRevoke: () => void;
  error: unknown;
  dialog: ReactNode;
}) {
  return (
    <li data-testid={testId} className={revoked ? "um-p-revoked" : undefined}>
      <div>
        <b>{label}</b> <code>{display}</code>
        <div className="um-p-meta">
          {meta}
          <span data-testid={stateTestId}>{state}</span>
        </div>
        <ProblemAlert error={error} />
      </div>
      {revoked ? null : (
        <Button variant="ghost" size="sm" onClick={onRevoke}>
          Revoke<span className="um-sr"> {revokeName}</span>
        </Button>
      )}
      {dialog}
    </li>
  );
}

function TokenRow({ tenantId, t }: { tenantId: string; t: ControlPlane.IngestToken }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const fresh = useFreshAction();
  const revoke = useMutation({
    mutationFn: () =>
      fresh(() => api.call("revokeIngestToken", { path: { tenantId, tokenId: t.token_id } })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["ingest-tokens", tenantId] });
    },
  });
  const revoked = !!t.revoked_at;
  return (
    <KeyRow
      testId={`token-${t.label}`}
      label={t.label}
      display={t.display}
      revoked={revoked}
      revokeName={t.label}
      onRevoke={() => setConfirming(true)}
      error={revoke.error}
      meta={
        <>
          <span>{(t.allowed_service_names ?? []).join(", ") || "any service"}</span>
          <span>Created {fmtDay(t.created_at)}</span>
          <span>{t.last_used_at ? `Last used ${fmtDayTime(t.last_used_at)}` : "Never used"}</span>
          {t.rotation_reminder && !revoked ? (
            <StatusBadge status="wait">older than 12 months — rotate</StatusBadge>
          ) : null}
        </>
      }
      state={
        revoked ? (
          <StatusBadge status="off">revoked {fmtDay(t.revoked_at as string)}</StatusBadge>
        ) : t.expires_at ? (
          `expires ${fmtDay(t.expires_at)}`
        ) : (
          "active"
        )
      }
      dialog={
        confirming ? (
          <ConfirmDialog
            title={`Revoke “${t.label}”?`}
            confirmLabel="Revoke token"
            danger
            busy={revoke.isPending}
            onConfirm={() => {
              setConfirming(false);
              revoke.mutate();
            }}
            onCancel={() => setConfirming(false)}
          >
            <p>
              Exporters using <code>{t.display}</code> are refused within 60 seconds. This cannot be
              undone; create a new token first if a service still needs one.
            </p>
          </ConfirmDialog>
        ) : null
      }
    />
  );
}

function CreateShareKey({
  tenantId,
  onCreated,
  onCancel,
}: {
  tenantId: string;
  onCreated: (k: ControlPlane.ShareKeyCreated) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [label, setLabel] = useState("");
  const [expires, setExpires] = useState("");
  const create = useMutation({
    mutationFn: () =>
      fresh(() =>
        api.call("createShareKey", {
          path: { tenantId },
          body: { label: label.trim(), expires_at: isoDay(expires ? parseDay(expires) : null) },
        }),
      ),
    onSuccess: async (k) => {
      setLabel("");
      setExpires("");
      await qc.invalidateQueries({ queryKey: ["share-keys", tenantId] });
      onCreated(k);
    },
  });
  return (
    <form
      className="um-p-annform"
      aria-label="Create a share key"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="um-grid um-g2">
        <Field label="Share key label">
          <input
            className="um-inp"
            required
            maxLength={100}
            value={label}
            placeholder="Grant programme"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Share key expires on (optional, UTC)">
          <input
            className="um-inp"
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </Field>
      </div>
      <p className="um-p-fine">Creating a share key asks you to confirm your sign-in.</p>
      <ProblemAlert error={create.error} />
      <div className="um-p-tools">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
          Create share key
        </Button>
      </div>
    </form>
  );
}

function ShareKeyRow({ tenantId, k }: { tenantId: string; k: ControlPlane.ShareKey }) {
  const qc = useQueryClient();
  const fresh = useFreshAction();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () =>
      fresh(() => api.call("revokeShareKey", { path: { tenantId, keyId: k.key_id } })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["share-keys", tenantId] });
    },
  });
  const revoked = !!k.revoked_at;
  const expired = !revoked && !!k.expires_at && Date.parse(k.expires_at) <= Date.now();
  return (
    <KeyRow
      testId={`share-key-${k.label}`}
      label={k.label}
      display={k.display}
      revoked={revoked || expired}
      revokeName={`share key ${k.label}`}
      onRevoke={() => setConfirming(true)}
      error={revoke.error}
      stateTestId="share-key-state"
      meta={
        <>
          <span>Created {fmtDay(k.created_at)}</span>
          <span>{k.last_used_at ? `Last used ${fmtDayTime(k.last_used_at)}` : "Never used"}</span>
        </>
      }
      state={
        revoked
          ? `revoked ${fmtDay(k.revoked_at as string)}`
          : expired
            ? `expired ${fmtDay(k.expires_at as string)}`
            : k.expires_at
              ? `expires ${fmtDay(k.expires_at)}`
              : "active"
      }
      dialog={
        confirming ? (
          <ConfirmDialog
            title={`Revoke “${k.label}”?`}
            confirmLabel="Revoke share key"
            danger
            busy={revoke.isPending}
            onConfirm={() => {
              setConfirming(false);
              revoke.mutate();
            }}
            onCancel={() => setConfirming(false)}
          >
            <p>
              Anyone using <code>{k.display}</code> loses access to your metrics document at once.
              This cannot be undone.
            </p>
          </ConfirmDialog>
        ) : null
      }
    />
  );
}

export function IngestTokensPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/ingest-tokens" });
  useTitle("Keys");
  const tokens = useTokens(tenantId);
  const shareKeys = useQuery({
    queryKey: ["share-keys", tenantId],
    queryFn: () => api.call("listShareKeys", { path: { tenantId } }),
  });
  const [form, setForm] = useState<"" | "ingest" | "share">("");
  const [created, setCreated] = useState<ControlPlane.IngestTokenCreated | null>(null);
  const [createdShare, setCreatedShare] = useState<ControlPlane.ShareKeyCreated | null>(null);
  const active = (tokens.data ?? []).filter((t) => !t.revoked_at).length;
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader
        title="Keys"
        sub="For your servers, build tools, readers you choose and AI assistants"
      />
      <Card
        title="Ingest tokens"
        sub="Your servers use these to send API metrics. A token can only send data; it cannot read anything."
        icon="server"
        actions={
          <Button
            size="sm"
            icon="plus"
            aria-expanded={form === "ingest"}
            onClick={() => setForm(form === "ingest" ? "" : "ingest")}
          >
            New token
          </Button>
        }
      >
        {tokens.data ? (
          <p className="um-p-fine" data-testid="token-count">
            {active} of {MAX_ACTIVE_TOKENS} active tokens in use.
          </p>
        ) : null}
        {active >= MAX_ACTIVE_TOKENS ? (
          <Note tone="warn">
            <p>
              All {MAX_ACTIVE_TOKENS} active tokens are in use; revoke one before creating another.
            </p>
          </Note>
        ) : null}
        {form === "ingest" && active < MAX_ACTIVE_TOKENS ? (
          <CreateToken
            tenantId={tenantId}
            onCancel={() => setForm("")}
            onCreated={(t) => {
              setCreated(t);
              setForm("");
            }}
          />
        ) : null}
        {created ? (
          <SecretOnce
            label={`New token “${created.label}”`}
            secret={created.token}
            onDismiss={() => setCreated(null)}
          />
        ) : null}
        {isForbidden(tokens.error) ? (
          <AccessNotice kind="read-only" title="Only the project's owner and admins see its keys">
            Ingest tokens are credentials. Your role can see the project's numbers but not its keys.
          </AccessNotice>
        ) : tokens.error ? (
          <ErrorState error={tokens.error} plain onRetry={() => void tokens.refetch()} />
        ) : tokens.isPending ? (
          <LoadingState />
        ) : tokens.data.length === 0 ? (
          <EmptyState plain title="No ingest tokens yet" icon="key" />
        ) : (
          <ul className="um-p-keyrows" aria-label="Ingest tokens">
            {tokens.data.map((t) => (
              <TokenRow key={t.token_id} tenantId={tenantId} t={t} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Share keys"
        sub="Read-only access to metrics.json, for readers you choose and AI assistants"
        icon="share"
        actions={
          <Button
            size="sm"
            icon="plus"
            aria-expanded={form === "share"}
            onClick={() => setForm(form === "share" ? "" : "share")}
          >
            New share key
          </Button>
        }
      >
        {form === "share" ? (
          <CreateShareKey
            tenantId={tenantId}
            onCancel={() => setForm("")}
            onCreated={(k) => {
              setCreatedShare(k);
              setForm("");
            }}
          />
        ) : null}
        {createdShare ? (
          <SecretOnce
            label={`New share key “${createdShare.label}”`}
            secret={createdShare.key}
            onDismiss={() => setCreatedShare(null)}
          >
            <p className="um-p-fine">
              Readers send it as <code>Authorization: Bearer &lt;key&gt;</code> when fetching the
              metrics document, or paste it into the project's public page. Never put it in a URL.
            </p>
          </SecretOnce>
        ) : null}
        {isForbidden(shareKeys.error) ? (
          <AccessNotice kind="read-only" title="Only the project's owner and admins see its keys">
            Share keys are credentials. Your role can see the project's numbers but not its keys.
          </AccessNotice>
        ) : shareKeys.error ? (
          <ErrorState error={shareKeys.error} plain onRetry={() => void shareKeys.refetch()} />
        ) : shareKeys.isPending ? (
          <LoadingState />
        ) : shareKeys.data.length === 0 ? (
          <EmptyState plain title="No share keys yet." icon="share" />
        ) : (
          <ul className="um-p-keyrows" aria-label="Share keys" data-testid="share-keys">
            {shareKeys.data.map((k) => (
              <ShareKeyRow key={k.key_id} tenantId={tenantId} k={k} />
            ))}
          </ul>
        )}
      </Card>

      <FootprintKeys tenantId={tenantId} />

      <Note icon="bot">
        <p>
          A new key is shown once. Store it in your secret manager; UsageMap keeps only a hash. AI
          assistants you connected with your own account are listed under{" "}
          <Link className="um-link" to="/oauth/apps">
            Account → Connected apps
          </Link>
          .
        </p>
      </Note>
    </ProjectFrame>
  );
}
