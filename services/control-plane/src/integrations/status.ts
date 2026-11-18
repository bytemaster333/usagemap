// SPDX-License-Identifier: Apache-2.0
// Status of each integration: not started → test received → live data seen, from facts the
// platform already stores. UsageMap cannot tell which of two web integrations of one website produced an event, so a
// card's status is that of its target (website, API service or project), refined by the kind of event the integration
// produces (wallet and passkey events for the wallet cards). Stated in the portal.
//
//   web cards       test received = an event from a dev origin in the last 24 hours (web_dev_events, never counted);
//                   live data seen = counted (verified or suspect) events at the edge in the last 7 UTC days;
//   wallet cards    the same with wallet (kind `stellar`) dev events and counted wallet/passkey property rows;
//   API cards       test received = any data-quality counter of the service in the last 7 UTC days (the OTLP test
//                   point is one: `cumulative_first_point`); live data seen = stored request metrics in 7 days;
//   browser RPC     test received = any dev event of the website (the test's page view: dev aggregates are dropped
//                   in memory); live data seen = stored per-site RPC/Horizon totals in the last 7 UTC days;
//   app events      test received = a `stale` drop of the website's app events today or yesterday (the test event) or
//                   any app-event row in 7 days; live data seen = accepted (self-attested) app events in 7 days;
//   badges          configured = the project's statistics are public (the badge endpoints answer 404 otherwise);
//   contracts       configured = at least one registered contract or footprint item;
//   local tools     not observable (they run on the developer's machine and send nothing).

import type { Def, Status } from "./catalogue.ts";

export interface SiteSignals {
  site_id: string;
  dev_origins: string[];
  dev_events_24h: number;
  wallet_dev_events_24h: number;
  test_events_24h: number;
  last_dev_event_at: string | null;
  counted_7d: boolean;
  wallet_counted_7d: boolean;
  passkey_counted_7d: boolean;
  wallets_kit_seen_7d: boolean;
  /** stored browser RPC/Horizon aggregate cells (web_rpc_client_daily) in the last 7 UTC days */
  rpc_counted_7d: boolean;
  /** accepted app events (app_event_daily `_total` of tenant names) in the last 7 UTC days */
  app_events_7d: number;
  /** app events dropped as `stale` today and yesterday (UTC): the app test adds exactly one */
  app_stale_drops_2d: number;
  /** any app-event row (events, sessions or drops) in the last 7 UTC days */
  app_reports_7d: number;
}

export interface ServiceSignals {
  service_id: string;
  service_name: string;
  /** `cumulative_first_point` counters over today and yesterday (UTC): the live check compares it before and after */
  baseline_points_2d: number;
  reports_7d: number;
  counted_7d: boolean;
}

export interface Signals {
  site: SiteSignals | null;
  service: ServiceSignals | null;
  footprint_items: number;
  /** the project's statistics are public (badges and the metrics document answer) */
  public_stats: boolean;
}

export interface StatusOut {
  id: string;
  status: Status;
  detail: string;
}

const PASSKEY = "wallet_passkeys";
const BROWSER_RPC = "wallet_browser_rpc";

export function statusOf(
  d: Pick<Def, "id" | "group" | "target" | "live_check">,
  s: Signals,
): StatusOut {
  const out = (status: Status, detail: string) => ({ id: d.id, status, detail });
  if (d.live_check === "public_badge")
    return s.public_stats
      ? out("configured", "The statistics are public: the badges answer.")
      : out(
          "not_started",
          "The statistics are private: the badge endpoints answer 404 until you make them public.",
        );
  if (d.live_check === "app_events") {
    const w = s.site;
    if (!w) return out("not_started", "No website yet: app events use its public key.");
    if (w.app_events_7d > 0)
      return out(
        "live_data_seen",
        `${w.app_events_7d} app event(s) in the last 7 days (self-attested).`,
      );
    if (w.app_stale_drops_2d > 0 || w.app_reports_7d > 0)
      return out(
        "test_received",
        "App events reached the edge (the test event is dropped as stale, never counted).",
      );
    return out("not_started", "No app event received yet.");
  }
  if (d.id === BROWSER_RPC) {
    const w = s.site;
    if (!w) return out("not_started", "No website yet.");
    if (w.rpc_counted_7d)
      return out("live_data_seen", "RPC/Horizon call totals stored in the last 7 days.");
    if (w.dev_events_24h > 0)
      return out(
        "test_received",
        "Events from a dev origin in the last 24 hours (aggregates from dev origins are not stored).",
      );
    return out("not_started", "No event received yet.");
  }
  switch (d.target) {
    case "local":
      return out("not_observable", "Runs on your machine and sends nothing to UsageMap.");
    case "tenant":
      return s.footprint_items > 0
        ? out("configured", `${s.footprint_items} contract(s) or account(s) registered.`)
        : out("not_started", "Nothing registered yet.");
    case "service": {
      const v = s.service;
      if (!v) return out("not_started", "No API service registered yet.");
      if (v.counted_7d)
        return out("live_data_seen", `Requests of ${v.service_name} stored in the last 7 days.`);
      if (v.reports_7d > 0)
        return out(
          "test_received",
          `Data reached ${v.service_name} (data-quality counters), but no request has been counted yet.`,
        );
      return out("not_started", `Nothing received for ${v.service_name} in the last 7 days.`);
    }
    case "site": {
      const w = s.site;
      if (!w) return out("not_started", "No website yet.");
      if (d.group === "wallets") {
        const live = d.id === PASSKEY ? w.passkey_counted_7d : w.wallet_counted_7d;
        if (live) return out("live_data_seen", "Counted wallet events in the last 7 days.");
        if (w.wallet_dev_events_24h > 0)
          return out(
            "test_received",
            "Wallet events from a dev origin in the last 24 hours (not counted).",
          );
        return out("not_started", "No wallet event received yet.");
      }
      if (w.counted_7d)
        return out("live_data_seen", "Counted events on this website in the last 7 days.");
      if (w.dev_events_24h > 0)
        return out("test_received", "Events from a dev origin in the last 24 hours (not counted).");
      return out("not_started", "No event received yet.");
    }
  }
}

/** The card the portal should suggest first, with the reason; null when nothing stands out. */
export function recommendation(d: Pick<Def, "id">, s: Signals): string | null {
  if (d.id === "wallet_wallets_kit" && s.site?.wallets_kit_seen_7d && !s.site.wallet_counted_7d)
    return "The Stellar Wallets Kit was seen on your pages, but no wallet event is counted yet.";
  if (d.id === "web_script_tag" && s.site && !s.site.counted_7d && s.site.dev_events_24h === 0)
    return "Start here: the fastest way to see your first event.";
  if (d.id === "api_otel_node" && s.service && !s.service.counted_7d && s.service.reports_7d === 0)
    return "Your service is registered but nothing has arrived yet.";
  if (d.id === "onchain_contracts" && s.footprint_items === 0 && s.site?.wallet_counted_7d)
    return "Your dApp has wallet activity: register its contracts to correlate it with on-chain usage.";
  return null;
}
