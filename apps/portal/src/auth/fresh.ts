// SPDX-License-Identifier: Apache-2.0
// Step-up before the action, not after a refusal (C-09, C-87, C-114): an SCF operator's state-changing action and a
// member's destructive action ask for the passkey (or a fresh sign-in) up front when the session's step-up / recent
// authentication has lapsed, so the person confirms once and the action runs once. The API client still handles a
// `403 step_up_required` / `recent_auth_required` that races with the expiry (it asks again and repeats the call).

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRequestReauth } from "./ReauthProvider.tsx";
import { recentAuthValid, SESSION_KEY, type Session } from "./session.ts";

/** Resolves true when a fresh confirmation is in place (already, or after the dialog); false when cancelled. */
export function useEnsureFresh(): () => Promise<boolean> {
  const qc = useQueryClient();
  const request = useRequestReauth();
  return useCallback(async () => {
    const s = qc.getQueryData<Session | null>(SESSION_KEY);
    if (recentAuthValid(s)) return true;
    return request(s?.kind === "operator" ? "step_up_required" : "recent_auth_required");
  }, [qc, request]);
}

/** Runs `action` after `useEnsureFresh` succeeded; a cancelled confirmation rejects with `StepUpCancelled`. */
export class StepUpCancelled extends Error {
  constructor() {
    super("Confirmation cancelled — nothing was changed.");
    this.name = "StepUpCancelled";
  }
}

export function useFreshAction() {
  const ensure = useEnsureFresh();
  return useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      if (!(await ensure())) throw new StepUpCancelled();
      return action();
    },
    [ensure],
  );
}
