// SPDX-License-Identifier: Apache-2.0
// RFC 9457 problem details with the closed `ProblemCode` catalogue of the OpenAPI document.

import type { ControlPlane } from "@usagemap/api-types";

export type ProblemCode = ControlPlane.ProblemCode;

export const PROBLEM_STATUS: Record<ProblemCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  csrf_failed: 403,
  step_up_required: 403,
  recent_auth_required: 403,
  not_found: 404,
  not_acceptable: 406,
  conflict: 409,
  quota_exceeded: 409,
  precondition_failed: 412,
  unprocessable: 422,
  rate_limited: 429,
  internal_error: 500,
  not_implemented: 501,
  unavailable: 503,
};

const TITLES: Record<ProblemCode, string> = {
  validation_failed: "Invalid request",
  unauthenticated: "Not signed in, session expired, or invalid key",
  forbidden: "Forbidden",
  csrf_failed: "CSRF check failed",
  step_up_required: "Passkey step-up required",
  recent_auth_required: "Fresh sign-in required",
  not_found: "Not found",
  not_acceptable: "Not acceptable",
  conflict: "Conflict",
  quota_exceeded: "Quota exceeded",
  precondition_failed: "Precondition failed",
  unprocessable: "Unprocessable",
  rate_limited: "Too many requests",
  internal_error: "Internal error",
  not_implemented: "Not implemented yet",
  unavailable: "Temporarily unavailable",
};

export interface FieldError {
  pointer: string;
  detail: string;
}

/** An error that the HTTP layer turns into a problem response. `detail` must never contain secrets or internals. */
export class ApiError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;
  readonly retryAfter: number | undefined;
  /** Response headers the problem response must still carry (e.g. a failed sign-out clears the session cookie). */
  readonly headers: Record<string, string> | undefined;
  constructor(
    code: ProblemCode,
    detail?: string,
    opts: { errors?: FieldError[]; retryAfter?: number; headers?: Record<string, string> } = {},
  ) {
    super(detail ?? code);
    this.name = "ApiError";
    this.code = code;
    this.status = PROBLEM_STATUS[code];
    this.detail = detail;
    this.errors = opts.errors;
    this.retryAfter = opts.retryAfter;
    this.headers = opts.headers;
  }
}

export function problemBody(
  err: ApiError,
  base: string,
  requestId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: `${base}${err.code}`,
    title: TITLES[err.code],
    status: err.status,
    code: err.code,
    request_id: requestId,
  };
  if (err.detail) body.detail = err.detail;
  if (err.errors?.length) body.errors = err.errors;
  return body;
}
