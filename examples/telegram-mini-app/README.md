# Telegram Mini App

A Telegram Mini App page: `telegram-web-app.js` first, then the web tracker, which sends the **path only** — never the query or fragment where Telegram puts its launch parameters. Optionally, app-style counts per Telegram client (`tma_platform`) through the app-events endpoint, labelled self-attested. Guide: [Mobile apps and Telegram Mini Apps](../../docs/onboarding/mobile.md#telegram-mini-apps).

## Run it

1. **Install:** `pnpm --dir tracker run build && pnpm --dir examples install` (from the repository root; the
   tracker comes from this repository's build until the npm package is published).
2. **Set your key:** `export VITE_USAGEMAP_SITE=YOUR_22_CHAR_SITE_KEY` (portal: site → **Snippet**), add the Mini App's origin as the site's domain, and add `localhost` as a
   dev origin (site → **Settings** → **Dev origins**) so test traffic shows up and is never counted.
3. **Run:** `pnpm --dir examples/telegram-mini-app dev`, open http://localhost:5173; inside Telegram, point your bot's Mini App URL at a tunnel to it (BotFather → **Bot Settings** → **Configure Mini App**).

## The lines that add UsageMap

`index.html`:

```html
    <!-- Telegram first: it reads its launch parameters from the URL fragment -->
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
```

`src/main.ts`:

```ts
import { init } from "@usagemap/tracker";
import { createUsageMapApp, tmaPlatform } from "./usagemap"; // packages/mobile-rn/src/index.ts, copied
// …
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
```

## What you'll see in the portal

Page views appear like any website's (site → **Installation** first-event panel for `localhost`, then the dashboard). App events are stored as daily counts per name, property value, platform and Telegram client, labelled `self_attested`, never mixed into verified web visits; a tenant read view in the portal is not built yet (see the guide).

## Test it without the app

```sh
curl -sS https://e1.usagemap.dev/v1/app-events -H 'content-type: application/json' --data-binary @- <<'EOF'
{"v":1,"k":"YOUR_22_CHAR_SITE_KEY","platform":"web","app_version":"1.0.0","sdk_version":"curl-test/0.1.0","tma_platform":"desktop",
 "events":[{"ts":1795082400000,"session":"k3J9xQ2mT7vR1aB8cD4eF6","name":"mini_app_open"}]}
EOF
# → 202 {"accepted":1,"dropped":0}   (use a current `ts` in milliseconds; older than 24 h is dropped as stale)
```

The website test is the same as for any site: see [How the website test works](../../docs/onboarding/integrations.md#how-the-website-test-works).

## Tested by

`tests/quickstarts/integrations/browser/integrations.spec.ts` (run: `tests/quickstarts/integrations/browser/run.sh`): opened the way Telegram opens a Mini App (`?startapp=…` plus `#tgWebAppData=…`) with a stub of `telegram-web-app.js` that carries a user id and `initData` — the page view is `/` only, the app-events batch is exactly the §a.9 shape (`platform: web`, `tma_platform: desktop` for `tdesktop`, `mini_app_open` and `swap_started {tier: free}` in one in-memory session), and no user id, `initData`, query or fragment reaches either endpoint. `src/usagemap.ts` is a byte-for-byte copy of `packages/mobile-rn/src/index.ts`. **Not run for real:** the Telegram client itself.
