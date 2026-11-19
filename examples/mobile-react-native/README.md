# React Native and Expo

A one-screen Expo app that sends two named app events to UsageMap: `app_open` when it starts and `swap_started` when
you tap the button. The helper is one dependency-free file, `usagemap.ts`, a copy of `packages/mobile-rn/src/index.ts`.
Counts from apps are **self-attested** (no bot check is possible in an app). Guide:
[Mobile apps and Telegram Mini Apps](../../docs/onboarding/mobile.md#react-native-and-expo).

## Run it

1. **Install:** `cd examples/mobile-react-native && npm install` (Expo SDK 58; this app is outside the examples' pnpm
   workspace on purpose, so that the other examples do not install React Native).
2. **Set your key:** `export EXPO_PUBLIC_USAGEMAP_SITE=<22-character site key>` (portal: **Project → Websites**, the
   same public key as the web tag; optionally `EXPO_PUBLIC_USAGEMAP_ENDPOINT=https://<your ingest host>/v1/app-events`).
3. **Run:** `npx expo start`, then open the app in Expo Go on a phone (scan the QR code) or press `a` / `i` for an
   emulator. Tap **Start a swap**, then **Send now**.

## The lines that add UsageMap

`App.tsx`:

```tsx
import { createUsageMapApp } from "./usagemap";

// UsageMap: one instance for the whole app (site key from the portal: Project → Websites)
export const analytics = createUsageMapApp({
  siteKey: process.env.EXPO_PUBLIC_USAGEMAP_SITE ?? "YOUR_22_CHAR_SITE_KEY",
  platform: Platform.OS === "ios" ? "ios" : "android",
  appVersion: "1.0.0",
  endpoint: process.env.EXPO_PUBLIC_USAGEMAP_ENDPOINT, // default: https://e1.usagemap.dev/v1/app-events
});
```

`App.tsx`:

```tsx
    analytics.track("app_open");
    const sub = AppState.addEventListener("change", (s) => s === "background" && analytics.flush());
```

`App.tsx`:

```tsx
        onPress={() => analytics.track("swap_started", { pair_class: "stablecoin" })}
```

Events are sent in batches of 10 and on `flush()`. Network errors, `429` and `5xx` keep them in memory for the next
flush; nothing is written to disk.

## What you'll see in the portal

App events are stored as daily counts per event name, property value, platform and app version, labelled
**self-attested**, and never mixed into verified web visits, public statistics or snapshots. They are stored once the
operator has enabled app counts on the edge (`edge_counter_features` lists `app`). A tenant view of app counts in the
portal is **not built yet** (2026-11-19); until then the edge's answer (`202 {"accepted":n,"dropped":m}`) is your
confirmation.

## Test it without the app

```sh
curl -sS https://e1.usagemap.dev/v1/app-events -H 'content-type: application/json' --data-binary @- <<EOF
{"v":1,"k":"YOUR_22_CHAR_SITE_KEY","platform":"android","app_version":"1.0.0","sdk_version":"curl-test/0.1.0",
 "events":[{"ts":$(date +%s)000,"session":"k3J9xQ2mT7vR1aB8cD4eF6","name":"app_open"}]}
EOF
# → 202 {"accepted":1,"dropped":0}
```

## Tested by

`tests/quickstarts/integrations/tools.spec.ts` (`mobile-react-native`): checks that `usagemap.ts` is byte for byte
the package source, then runs it in Node with the options and the `track`/`flush` calls of `App.tsx` against a local
stand-in of `/v1/app-events`, and checks the request: method, `content-type`, the body's fields (`v`, `k`, `platform`,
`app_version`, `sdk_version`, `events[{ts, session, name, props}]`) and nothing else (no device, install, advertising or
user id). **Not run:** the Expo app itself on a device or emulator (no phone or Android/iOS SDK in the test suite). The Expo pins
(`expo` 58.0.25 with `react-native` 0.88.1 and `react` 19.3.0, as the SDK's `bundledNativeModules.json` lists them)
were read, not installed.
