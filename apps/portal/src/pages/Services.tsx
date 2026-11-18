// SPDX-License-Identifier: Apache-2.0
// The project's "API" entry (dashboard.api-tenant): opens the first API service's dashboard, or — before any service exists —
// says how to start and offers registering one. Registering a service is also on Settings → API services. The
// service name is what the OpenTelemetry SDK sends as `service.name`.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useState } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import {
  Button,
  buttonClass,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  LoadingState,
  PageHeader,
} from "../components/ui/index.ts";
import { ProjectFrame } from "./project/common.tsx";

export function useServices(tenantId: string) {
  return useQuery({
    queryKey: ["services", tenantId],
    queryFn: () => api.call("listServices", { path: { tenantId } }),
  });
}

export const STREAM_KIND_TEXT: Record<string, string> = {
  sdk_stable: "SDK metric (stable conventions)",
  sdk_legacy: "SDK metric (old conventions)",
  span_derived: "derived from SERVER spans",
  mixed: "several stream groups",
};

export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** Registration form; `onCreated` decides where to go next (service page or the wizard's next step). */
export function RegisterService({
  tenantId,
  onCreated,
}: {
  tenantId: string;
  onCreated: (s: ControlPlane.Service) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [display, setDisplay] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.call("createService", {
        path: { tenantId },
        body: {
          service_name: name.trim(),
          ...(display.trim() ? { display_name: display.trim() } : {}),
          ...(baseUrl.trim() ? { declared_base_url: baseUrl.trim() } : {}),
          read_only_api: readOnly,
        },
      }),
    onSuccess: async (s) => {
      await qc.invalidateQueries({ queryKey: ["services", tenantId] });
      onCreated(s);
    },
  });
  const nameOk = SERVICE_NAME_RE.test(name.trim());
  return (
    <Card title="Register an API service" icon="server">
      <form
        className="um-p-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (nameOk) create.mutate();
        }}
      >
        <Field
          label="Service name (OpenTelemetry service.name)"
          hint={
            <>
              Lower-case letters, digits, “.”, “_” and “-”. Must equal the <code>service.name</code>{" "}
              your SDK sends.
            </>
          }
          error={name && !nameOk ? "That is not a valid service name." : undefined}
        >
          <input
            className="um-inp um-inp--mono"
            required
            maxLength={63}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <div className="um-grid um-g2">
          <Field label="Display name (optional)">
            <input
              className="um-inp"
              maxLength={120}
              value={display}
              onChange={(e) => setDisplay(e.target.value)}
            />
          </Field>
          <Field
            label="Public base URL (optional)"
            hint="Lets SCF probe the API from outside to raise its assurance level (A2)."
          >
            <input
              className="um-inp um-inp--mono"
              type="url"
              placeholder="https://api.example.org"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
        </div>
        <label className="um-p-check">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          Read-only API (no state-changing endpoints)
        </label>
        <ProblemAlert error={create.error} />
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={create.isPending || !nameOk}>
            Register service
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** /t/:id/services — the API page: the first service, or how to start. */
export function ServicesPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/services" });
  const navigate = useNavigate();
  const services = useServices(tenantId);
  useTitle("API");
  if (services.isPending) return <LoadingState block label="Loading your API services…" />;
  if (services.error)
    return <ErrorState error={services.error} onRetry={() => void services.refetch()} />;
  const first = services.data.find((s) => s.status === "active") ?? services.data[0];
  if (first)
    return (
      <Navigate
        to="/t/$tenantId/services/$serviceId"
        params={{ tenantId, serviceId: first.service_id }}
        search={{ range: "30d", compare: false, sort: "-requests" }}
        replace
      />
    );
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader title="API" sub="Numbers your servers report" badges={<Chip kind="self" />} />
      <EmptyState
        title="No API service yet"
        icon="server"
        action={
          <Link
            to="/t/$tenantId/integrations"
            params={{ tenantId }}
            search={{ group: "api" }}
            className={buttonClass("primary", { size: "sm" })}
          >
            <Icon name="plug" />
            Pick your stack
          </Link>
        }
      >
        Your servers export request durations with OpenTelemetry. UsageMap keeps per-route counts
        and latency histograms, never requests, traces or logs.
      </EmptyState>
      <RegisterService
        tenantId={tenantId}
        onCreated={(s) =>
          void navigate({
            to: "/t/$tenantId/services/$serviceId/setup",
            params: { tenantId, serviceId: s.service_id },
            search: { stack: "node" },
          })
        }
      />
    </ProjectFrame>
  );
}
