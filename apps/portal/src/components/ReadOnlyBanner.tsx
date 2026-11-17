// SPDX-License-Identifier: Apache-2.0
// Persistent banner while the platform is in read-only mode (ops.end-of-window-read-only). The mode is read once at start from the public
// thresholds and re-read whenever a write is refused with the read-only detail (the operator may have switched it on
// since the page loaded).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api/client.ts";
import { platformModeOf, readOnlyText } from "../lib/platformMode.ts";

export const PLATFORM_MODE_KEY = ["platform-mode"] as const;

export function ReadOnlyBanner() {
  const queryClient = useQueryClient();
  const mode = useQuery({
    queryKey: PLATFORM_MODE_KEY,
    queryFn: async () => platformModeOf(await api.call("getPublishedThresholds", {})),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  useEffect(
    () =>
      api.onReadOnly(() => {
        void queryClient.invalidateQueries({ queryKey: PLATFORM_MODE_KEY });
      }),
    [queryClient],
  );
  if (!mode.data?.readOnly) return null;
  return (
    <div className="read-only-banner" role="status" data-testid="read-only-banner">
      {readOnlyText(mode.data)}
    </div>
  );
}
