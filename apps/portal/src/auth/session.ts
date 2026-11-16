// SPDX-License-Identifier: Apache-2.0
// Session state (ADR-0014, C-20). The session lives in an HttpOnly cookie the portal cannot read; the portal only asks
// `GET /v1/auth/session` what the cookie is worth: signed in or not, complete or waiting for an SCF operator's
// passkey (C-09), and until when recent authentication / step-up is valid (C-87, C-114).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { ApiError, api } from "../api/client.ts";

export type Session = ControlPlane.Session;

export const SESSION_KEY = ["session"] as const;

export async function fetchSession(): Promise<Session | null> {
  try {
    return await api.call("authGetSession", {});
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 30_000 });
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.call("getMe", {}),
    enabled,
    staleTime: 30_000,
  });
}

/** Whether recent authentication (or, for an SCF operator, a step-up) is still valid at `now`. */
export function recentAuthValid(s: Session | null | undefined, now = Date.now()): boolean {
  if (!s) return false;
  const until = s.kind === "operator" ? s.step_up_valid_until : s.recent_auth_valid_until;
  return !!until && Date.parse(until) > now;
}

export function useSetSession() {
  const qc = useQueryClient();
  return (s: Session | null) => {
    qc.setQueryData(SESSION_KEY, s);
    // Everything cached belongs to the previous session.
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
  };
}
