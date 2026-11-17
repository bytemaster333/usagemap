// SPDX-License-Identifier: Apache-2.0
// UsageMap UI kit: loading, empty, error and access (403 / read-only) states, and QueryState, which picks the right
// one for a TanStack Query result. Every widget that shows API data renders through these, so no widget ever shows a
// made-up number while it waits or fails.

import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError, isReadOnlyRefusal } from "../../api/client.ts";
import { errorSummary } from "../ProblemAlert.tsx";
import { Button, cx, Icon, type IconName } from "./basics.tsx";

/**
 * True for a 403 that re-authentication cannot fix: the account's role does not allow it. The platform's read-only
 * mode (ops.end-of-window-read-only) is not a role problem and keeps its own explanation.
 */
export function isForbidden(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    !isReadOnlyRefusal(error.status, error.problem) &&
    error.code !== "step_up_required" &&
    error.code !== "recent_auth_required" &&
    error.code !== "csrf_failed"
  );
}

export function LoadingState({
  label = "Loading…",
  block = false,
}: {
  label?: string | undefined;
  /** a chart-sized block instead of text lines */
  block?: boolean | undefined;
}) {
  return (
    <div role="status" aria-live="polite" className="um-loading">
      <span className="um-sr">{label}</span>
      <div className={cx("um-skel", block && "um-skel--block")} aria-hidden="true">
        <i />
        {block ? null : (
          <>
            <i />
            <i />
          </>
        )}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon = "info",
  action,
  plain = false,
}: {
  title: ReactNode;
  children?: ReactNode | undefined;
  icon?: IconName | undefined;
  action?: ReactNode | undefined;
  /** no dashed frame (inside a card that already frames it) */
  plain?: boolean | undefined;
}) {
  return (
    <div className={cx("um-state", plain && "um-state--plain")}>
      <span className="um-state-ic">
        <Icon name={icon} />
      </span>
      <p className="um-state-t">{title}</p>
      {children ? <p className="um-state-d">{children}</p> : null}
      {action ? <div className="um-state-act">{action}</div> : null}
    </div>
  );
}

/**
 * A friendly notice for a 403. `read-only`: the account may look but not change (viewer role, read-only operator);
 * `forbidden`: the account may not open this at all.
 */
export function AccessNotice({
  kind = "read-only",
  title,
  children,
}: {
  kind?: "read-only" | "forbidden" | undefined;
  title?: ReactNode | undefined;
  children?: ReactNode | undefined;
}) {
  const t =
    title ??
    (kind === "read-only"
      ? "You have read-only access here"
      : "This page is not open to your account");
  const d =
    children ??
    (kind === "read-only"
      ? "Your role lets you see everything on this page, but not change it. An owner or admin of the project can make this change or give you a role that can."
      : "Your account has no access to this page. If you think it should, ask the project's owner or the UsageMap operator team.");
  return (
    <div className="um-access" role="status" data-testid="access-notice">
      <span className="um-access-ic">
        <Icon name="lock" />
      </span>
      <div>
        <b>{t}</b>
        <p>{d}</p>
      </div>
    </div>
  );
}

/** An error the person can act on; 403s become an AccessNotice. `onRetry` adds a "Try again" button. */
export function ErrorState({
  error,
  onRetry,
  plain = false,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
  plain?: boolean | undefined;
}) {
  if (isForbidden(error)) return <AccessNotice kind="forbidden" />;
  const s = errorSummary(error);
  return (
    <div className={cx("um-state", plain && "um-state--plain")} role="alert">
      <span className="um-state-ic um-state-ic--bad">
        <Icon name="alert" />
      </span>
      <p className="um-state-t">{s.title}</p>
      {s.detail && s.detail !== s.title ? <p className="um-state-d">{s.detail}</p> : null}
      {s.hint ? <p className="um-state-d">{s.hint}</p> : null}
      {s.retryAfter !== undefined ? (
        <p className="um-state-d">Try again in {s.retryAfter} seconds.</p>
      ) : null}
      {onRetry ? (
        <div className="um-state-act">
          <Button size="sm" icon="repeat" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {s.requestId ? <p className="um-note-meta">Request id: {s.requestId}</p> : null}
    </div>
  );
}

/**
 * Renders a query's loading, error and empty states, and `children(data)` once there is data.
 * `isEmpty(data)` decides when the empty state shows (default: an empty array).
 */
export function QueryState<T>({
  query,
  children,
  isEmpty,
  empty,
  loading,
  plain,
}: {
  query: Pick<UseQueryResult<T>, "data" | "error" | "isPending" | "refetch">;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean | undefined;
  /** what to show when there is nothing (an <EmptyState/>) */
  empty?: ReactNode | undefined;
  loading?: ReactNode | undefined;
  plain?: boolean | undefined;
}) {
  if (query.isPending) return <>{loading ?? <LoadingState />}</>;
  if (query.error)
    return <ErrorState error={query.error} plain={plain} onRetry={() => void query.refetch()} />;
  const data = query.data as T;
  const none = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (none) return <>{empty ?? <EmptyState title="Nothing here yet" plain={plain} />}</>;
  return <>{children(data)}</>;
}
