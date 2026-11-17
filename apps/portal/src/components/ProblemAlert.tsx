// SPDX-License-Identifier: Apache-2.0
// Displays an RFC 9457 problem (or any error) in a way a person can act on: title, detail, the fields at fault,
// when to retry and the request id to quote to support. Internal identifiers are never shown because the API never
// sends them.

import { ApiError, type ProblemCode } from "../api/client.ts";
import { Icon } from "./ui/basics.tsx";
import { AccessNotice, isForbidden } from "./ui/states.tsx";

const HINTS: Partial<Record<ProblemCode, string>> = {
  csrf_failed: "The request did not come from this portal page. Reload the page and try again.",
  recent_auth_required: "This action needs a fresh sign-in from the last 10 minutes.",
  step_up_required: "This action needs a passkey confirmation from the last 10 minutes.",
  not_implemented: "This part of the service is not available yet.",
  unavailable: "The service is temporarily read-only or unavailable.",
  rate_limited: "Too many requests.",
  quota_exceeded: "A quota for your project has been reached.",
};

export function errorSummary(error: unknown): {
  title: string;
  detail?: string | undefined;
  hint?: string | undefined;
  fields: { pointer: string; detail: string }[];
  requestId?: string | undefined;
  retryAfter?: number | undefined;
} {
  if (error instanceof ApiError) {
    const p = error.problem;
    return {
      title: p.title,
      detail: p.detail,
      hint: p.code ? HINTS[p.code] : undefined,
      fields: p.errors ?? [],
      requestId: p.request_id,
      retryAfter: error.retryAfter,
    };
  }
  if (error instanceof TypeError) {
    return {
      title: "The portal could not reach the service",
      hint: "Check your connection.",
      fields: [],
    };
  }
  return { title: error instanceof Error ? error.message : "Something went wrong", fields: [] };
}

export function ProblemAlert({ error }: { error: unknown }) {
  if (!error) return null;
  // A refused write (viewer role, read-only operator) is not a failure: say plainly what the role allows.
  if (isForbidden(error)) return <AccessNotice kind="read-only" />;
  const s = errorSummary(error);
  return (
    <div className="um-note um-note--bad" role="alert">
      <Icon name="alert" />
      <div className="um-note-b">
        <strong>{s.title}</strong>
        {s.detail && s.detail !== s.title ? <p>{s.detail}</p> : null}
        {s.hint ? <p>{s.hint}</p> : null}
        {s.fields.length > 0 ? (
          <ul>
            {s.fields.map((f) => (
              <li key={f.pointer}>
                <code>{f.pointer || "/"}</code>: {f.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {s.retryAfter !== undefined ? <p>Try again in {s.retryAfter} seconds.</p> : null}
        {s.requestId ? <p className="um-note-meta">Request id: {s.requestId}</p> : null}
      </div>
    </div>
  );
}
