// SPDX-License-Identifier: Apache-2.0
// Pure parts of the Integrations page (integration plan I1.0): search parameters, labels, client-side filtering and
// the live-check rules that decide when a test has arrived.
//   web (dev_events)      the test arrived when the first-event panel lists an event received at or after the moment
//                         the live check started (the curl's page view of /usagemap-test, or a page of the app);
//   OTLP (otlp_baseline)  the test arrived when the service's baseline-point counter (`baseline_points_2d`) is above
//                         the value read when the live check started — the generated curl adds exactly one, which is
//                         never counted;
//   app (app_events)      the same comparison on the website's stale app-event drops (`app_stale_drops_2d`): the
//                         generated app event is two days old, so the edge drops it as stale and never counts it.

import type { ControlPlane } from "@usagemap/api-types";

export type Integration = ControlPlane.Integration;
export type IntegrationGroup = ControlPlane.IntegrationGroup;
export type IntegrationStatus = ControlPlane.IntegrationStatus;
export type DevEvent = ControlPlane.DevEvent;

export const GROUPS: ReadonlyArray<{ id: IntegrationGroup; label: string }> = [
  { id: "web", label: "Websites" },
  { id: "wallets", label: "Wallets" },
  { id: "api", label: "APIs" },
  { id: "mobile", label: "Mobile apps" },
  { id: "onchain", label: "On-chain" },
  { id: "tooling", label: "Developer tools" },
];

export const STATUS_TEXT: Record<IntegrationStatus, string> = {
  not_started: "Not started",
  configured: "Configured",
  test_received: "Test received",
  live_data_seen: "Live data seen",
  not_observable: "Runs locally",
};

export const STATUS_BADGE: Record<IntegrationStatus, string> = {
  not_started: "badge",
  configured: "badge good",
  test_received: "badge warn",
  live_data_seen: "badge good",
  not_observable: "badge",
};

export const AVAILABILITY_TEXT: Record<Integration["availability"], string> = {
  ready: "Ready",
  package_unpublished: "From the repository",
  beta: "Beta",
};

export const TEST_PATH = "/usagemap-test";
export const LIVE_POLL_MS = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[a-z][a-z0-9_]{1,47}$/;

export interface IntegrationsSearch {
  group?: IntegrationGroup;
  site?: string;
  service?: string;
  card?: string;
  q?: string;
}

export function parseIntegrationsSearch(s: Record<string, unknown>): IntegrationsSearch {
  const out: IntegrationsSearch = {};
  if (typeof s.group === "string" && GROUPS.some((g) => g.id === s.group))
    out.group = s.group as IntegrationGroup;
  if (typeof s.site === "string" && UUID.test(s.site)) out.site = s.site.toLowerCase();
  if (typeof s.service === "string" && UUID.test(s.service)) out.service = s.service.toLowerCase();
  if (typeof s.card === "string" && ID.test(s.card)) out.card = s.card;
  if (typeof s.q === "string" && s.q.trim() !== "") out.q = s.q.trim().slice(0, 60);
  return out;
}

/** Text filter over title, summary and stack tags (case-insensitive, every word must match). */
export function matches(c: Integration, q: string | undefined): boolean {
  if (!q) return true;
  const hay = `${c.title} ${c.summary} ${c.stacks.join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Recommended first, then in catalogue order. */
export function ordered(cards: readonly Integration[]): Integration[] {
  return [...cards]
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) => Number(b.c.recommended !== null) - Number(a.c.recommended !== null) || a.i - b.i,
    )
    .map((x) => x.c);
}

export function webTestArrived(events: readonly DevEvent[], sinceMs: number): DevEvent | null {
  // received_at has second precision at most; allow one second of clock skew between browser and server
  return events.find((e) => Date.parse(e.received_at) >= sinceMs - 1000) ?? null;
}

export function otlpTestArrived(baseline: number | null, current: number | undefined): boolean {
  return baseline !== null && current !== undefined && current > baseline;
}

/** The app test arrived when the website's stale drops rose above the value read when the live check started. */
export const appTestArrived = otlpTestArrived;

/** Whether the web test needs `localhost` added to the website's dev origins first. */
export function needsLocalhost(devOrigins: readonly string[]): boolean {
  return !devOrigins.includes("localhost"); // the test curl claims http://localhost:5173
}
