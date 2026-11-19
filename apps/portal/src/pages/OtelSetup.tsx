// SPDX-License-Identifier: Apache-2.0
// OpenTelemetry dual-export configuration per stack (ADR-0009, C-102, C-105, wire-formats §f.2): the files,
// environment and notes the control plane generates (`getOtelConfig`), with the ingest token as a placeholder — the
// token itself is shown once, at creation, and never again. The tenant keeps exporting everything to its own APM; SCF
// receives only the HTTP server duration metric (or, for span-only stacks, local-root SERVER spans turned into that
// metric inside SCF's Collector).

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useId } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { OTEL_STACKS, type OtelStack } from "../lib/search.ts";
import { useService } from "./ServiceLayout.tsx";

export const STACK_LABELS: Record<OtelStack, string> = {
  node: "Node.js / Express",
  nextjs: "Next.js",
  fastapi: "Python / FastAPI",
  go: "Go (net/http)",
  rust: "Rust (axum)",
  java: "Java (OpenTelemetry agent)",
  dotnet: ".NET (ASP.NET Core)",
  collector: "Your own OpenTelemetry Collector",
};

/** `KEY=value` lines; values with spaces are quoted for a POSIX shell. */
export function envLines(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(
      ([k, v]) => `${k}=${/[^A-Za-z0-9_./:@,=+-]/.test(v) ? `'${v.replace(/'/g, "'\\''")}'` : v}`,
    )
    .join("\n");
}

export function OtelConfigPanel({
  tenantId,
  serviceId,
  stack,
  onStack,
}: {
  tenantId: string;
  serviceId: string;
  stack: OtelStack;
  onStack: (s: OtelStack) => void;
}) {
  const id = useId();
  const cfg = useQuery({
    queryKey: ["otel-config", tenantId, serviceId, stack],
    queryFn: () => api.call("getOtelConfig", { path: { tenantId, serviceId }, query: { stack } }),
  });
  const env = envLines(cfg.data?.env);
  return (
    <section className="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>OpenTelemetry configuration</h2>
      <p>
        Your services keep sending traces, metrics and logs to your own APM. The configuration adds
        a second export to SCF that carries only the request-duration metric — never traces, logs,
        request headers or query strings.
      </p>
      <div>
        <label htmlFor={`${id}-s`}>Your stack</label>
        <select id={`${id}-s`} value={stack} onChange={(e) => onStack(e.target.value as OtelStack)}>
          {OTEL_STACKS.map((s) => (
            <option key={s} value={s}>
              {STACK_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <ProblemAlert error={cfg.error} />
      {cfg.data ? (
        <div className="stack" data-testid="otel-config">
          {(cfg.data.notes ?? []).length > 0 ? (
            <div className="alert warn" data-testid="otel-notes">
              <strong>Before you start</strong>
              <ul>
                {(cfg.data.notes ?? []).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {cfg.data.files.map((f) => (
            <div key={f.filename} className="card">
              <h3>{f.filename}</h3>
              <pre className="code" data-testid={`otel-file-${f.filename}`}>
                <code>{f.content}</code>
              </pre>
              <CopyButton text={f.content} label={`Copy ${f.filename}`} />
            </div>
          ))}
          {env ? (
            <div className="card">
              <h3>Environment</h3>
              <pre className="code" data-testid="otel-env">
                <code>{env}</code>
              </pre>
              <CopyButton text={env} label="Copy environment" />
              <p className="small muted">
                Replace <code>&lt;INGEST_TOKEN&gt;</code> with an ingest token of this project. Keep
                it in your secret store, never in source code or a URL.
              </p>
            </div>
          ) : null}
        </div>
      ) : cfg.isLoading ? (
        <p className="muted">Loading configuration…</p>
      ) : null}
    </section>
  );
}

export function OtelSetupPage() {
  const { tenantId, serviceId } = useParams({ from: "/app/t/$tenantId/services/$serviceId/setup" });
  const search = useSearch({ from: "/app/t/$tenantId/services/$serviceId/setup" });
  const navigate = useNavigate();
  const svc = useService(tenantId, serviceId);
  useTitle(svc.data ? `${svc.data.service_name} OpenTelemetry set-up` : "OpenTelemetry set-up");
  return (
    <OtelConfigPanel
      tenantId={tenantId}
      serviceId={serviceId}
      stack={search.stack}
      onStack={(stack) =>
        void navigate({
          to: "/t/$tenantId/services/$serviceId/setup",
          params: { tenantId, serviceId },
          search: { stack },
          replace: true,
        })
      }
    />
  );
}
