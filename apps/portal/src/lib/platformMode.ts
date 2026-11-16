// SPDX-License-Identifier: Apache-2.0
// The platform's read-only mode (ops.end-of-window-read-only), as published by GET /public/v1/thresholds: the setting `read_only_mode`
// with the value {"enabled": boolean, "ingest": "accept" | "pause"}. Anything else (absent, malformed) means "off":
// the banner never claims a mode the server did not state.

export interface PlatformMode {
  readOnly: boolean;
  ingestPaused: boolean;
}

export const NORMAL_MODE: PlatformMode = { readOnly: false, ingestPaused: false };

export function platformModeOf(settings: unknown): PlatformMode {
  if (!Array.isArray(settings)) return NORMAL_MODE;
  const s = settings.find(
    (x): x is { key: string; value: unknown } =>
      typeof x === "object" && x !== null && (x as { key?: unknown }).key === "read_only_mode",
  );
  const v = s?.value as { enabled?: unknown; ingest?: unknown } | null | undefined;
  if (!v || typeof v !== "object" || v.enabled !== true) return NORMAL_MODE;
  return { readOnly: true, ingestPaused: v.ingest === "pause" };
}

export function readOnlyText(m: PlatformMode): string {
  return m.ingestPaused
    ? "Read-only mode: the platform accepts no changes, and data collection is paused (new page views, events and API telemetry are not recorded). Existing figures stay readable and exportable."
    : "Read-only mode: the platform accepts no changes. Data collection continues, and existing figures stay readable and exportable.";
}
