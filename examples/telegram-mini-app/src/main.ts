// SPDX-License-Identifier: Apache-2.0
// A Telegram Mini App page: telegram-web-app.js is loaded first (index.html), then the tracker.
import { init } from "@usagemap/tracker";
import { createUsageMapApp, tmaPlatform } from "./usagemap"; // packages/mobile-rn/src/index.ts, copied

const tg = (window as { Telegram?: { WebApp?: { platform?: string; ready(): void } } }).Telegram
  ?.WebApp;
tg?.ready();

// UsageMap: page views (the path only: Telegram's launch parameters in the query and fragment are never sent)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });

// Optional: app-style counts per Telegram client (self-attested). Never pass initData or the Telegram user.
const app = createUsageMapApp({
  siteKey: import.meta.env.VITE_USAGEMAP_SITE ?? "",
  platform: "web",
  appVersion: "1.0.0",
  tmaPlatform: tmaPlatform(tg?.platform),
  endpoint: import.meta.env.VITE_USAGEMAP_APP_EVENTS, // default: https://e1.usagemap.dev/v1/app-events
});
app.track("mini_app_open");
addEventListener("pagehide", () => void app.flush());

document.getElementById("swap")?.addEventListener("click", () => {
  app.track("swap_started", { tier: "free" });
  void app.flush();
  (document.getElementById("log") as HTMLElement).textContent = "swap: started";
});
