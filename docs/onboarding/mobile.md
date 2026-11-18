# Mobile apps and Telegram Mini Apps

Native apps (React Native, Expo, Flutter, Swift, Kotlin) cannot load the web tracker, and a Telegram Mini App may want
app-style counts next to its page views. Both send **named events** to the edge endpoint `POST /v1/app-events` with
your site's public key — the same 22-character key as in the web tag (`data-site`). No new key, no account on a
third-party service.

**Read this first — what these numbers are.** The web tracker proves each visit with a browser proof of work and
browser checks; an app cannot. App events are therefore **self-attested**: UsageMap stores and shows them as your
app's own report, labelled `self_attested`, and never mixes them into verified web visits, the verified-event quota,
trust scores, public statistics, traction snapshots or the Usage Map. Use them to understand your app; do not present
them as independently verified usage.

**Availability (2026-11-19):** the endpoint and both helpers are in the repository with tests. The helpers are not
published to npm or pub.dev yet (that waits for the public repository); copy the single source file meanwhile. App
counts are stored once the operator lists `app` in the platform setting `edge_counter_features`; a tenant read view
in the portal is not built yet.

## What is sent — and what never is

| Sent | Never sent (no field exists for it) |
|---|---|
| your site key, `platform` (`ios`, `android`, `web`), your app's version, the helper's version | device id, install id, advertising id (IDFA/GAID), user id, e-mail |
| per event: time, a **random session id held in memory** (new at the latest every 30 minutes), the event name, up to 8 enum-like properties | wallet addresses, transaction hashes, amounts, free text, numbers, Telegram `initData` or user object |

- The edge never reads your app's User-Agent and never stores an IP address; the connection's address is used in
  memory for rate limiting only, as on the web path.
- The session id is never stored. The edge keeps a keyed hash for 35 minutes to count each session once per day.
- Property values must look like enum values: a lower-case letter, then lower-case letters, digits or `_`, at most 32
  characters (`pro`, `usdc`, `step_2`). A value with six or more digits in a row, a hex-like value or anything else
  is dropped by the edge (and counted as dropped, so you see it).
- Event names follow the web rule: letters, digits and `_ . : -`, up to 50 characters, starting with a letter or digit.

## React Native and Expo

`packages/mobile-rn/src/index.ts` — zero dependencies, uses `fetch`.

```ts
import { Platform, AppState } from "react-native";
import { createUsageMapApp } from "./usagemap"; // @usagemap/mobile-rn once published

export const analytics = createUsageMapApp({
  siteKey: "YOUR_22_CHAR_SITE_KEY",
  platform: Platform.OS === "ios" ? "ios" : "android",
  appVersion: "1.4.2", // e.g. expo-application's nativeApplicationVersion
  endpoint: "https://ingest-a.example-analytics.org/v1/app-events", // your ingest host (default: the UsageMap edge)
});

analytics.track("app_open");
analytics.track("swap_started", { pair_class: "stablecoin", tier: "pro" });
AppState.addEventListener("change", (s) => s === "background" && analytics.flush());
```

- `track()` returns `false` and drops the event if the name or a property would be refused.
- Events are sent in batches (10 by default, at most 20 per request) and on `flush()`. Network errors, `429` and
  `5xx` keep the events in memory for the next flush (at most 100); other answers drop them. Nothing is written to
  disk, so events still queued when the app is killed are lost — by design.

## Flutter and Dart

`packages/mobile-flutter/lib/usagemap_app_events.dart` (+ `io_transport.dart` for iOS, Android and desktop) — no
dependencies.

```dart
import 'dart:io' show Platform;
import 'usagemap_app_events.dart';
import 'io_transport.dart';

final analytics = UsageMapApp(
  siteKey: 'YOUR_22_CHAR_SITE_KEY',
  platform: Platform.isIOS ? 'ios' : 'android',
  appVersion: '1.4.2', // e.g. package_info_plus
  transport: ioTransport(),
  endpoint: Uri.parse('https://ingest-a.example-analytics.org/v1/app-events'), // your ingest host
);

analytics.track('app_open');
analytics.track('swap_started', {'tier': 'pro'});
// in a WidgetsBindingObserver: on AppLifecycleState.paused → analytics.flush();
```

Flutter web: pass a `transport` built on `package:http` or the browser's `fetch`.

## Telegram Mini Apps

A Mini App is a web page in Telegram's WebView, so the **web tracker works there unchanged** and is the right default
(add the Mini App's origin as the site's domain; load `telegram-web-app.js` first, then the tag). The tracker sends the
path only, never the query or fragment where Telegram puts its launch parameters.

If you also want app-style counts per Telegram client, use the same endpoint with `platform: "web"` and the closed
`tma_platform` class:

```ts
import { createUsageMapApp, tmaPlatform } from "./usagemap";

const analytics = createUsageMapApp({
  siteKey: "YOUR_22_CHAR_SITE_KEY",
  platform: "web",
  appVersion: "2.0.0",
  tmaPlatform: tmaPlatform(window.Telegram?.WebApp?.platform), // android | ios | macos | desktop | web | other
});
analytics.track("mini_app_open");
```

`tmaPlatform()` maps `android`/`android_x` → `android`, `tdesktop`/`unigram` → `desktop`, `weba`/`webk` → `web`,
`ios`, `macos` and `web` to themselves, anything else → `other`. **Never** read or send `initData`,
`initDataUnsafe` or the Telegram user object; the request format has no field that could carry them, and a property
value cannot hold a user id (digit runs are dropped).

## Any other language (Swift, Kotlin, curl)

It is one JSON POST:

```sh
curl -sS https://ingest-a.example-analytics.org/v1/app-events -H 'content-type: application/json' --data-binary @- <<'EOF'
{"v":1,"k":"YOUR_22_CHAR_SITE_KEY","platform":"ios","app_version":"1.4.2","sdk_version":"curl-test/0.1.0",
 "events":[{"ts":1795082400000,"session":"k3J9xQ2mT7vR1aB8cD4eF6","name":"app_open"}]}
EOF
# → 202 {"accepted":1,"dropped":0}
```

Generate the session id from a random generator (16–64 characters of `A–Z a–z 0–9 _ -`), keep it in memory only, and
replace it at the latest after 30 minutes. `ts` is milliseconds since the epoch; events older than 24 hours or more
than 5 minutes in the future are dropped as `stale`. Unknown fields make the whole request `400`.

## Answers

| Status | Meaning |
|---|---|
| `202 {"accepted":n,"dropped":m}` | stored as counts; dropped events are counted under `_dropped` with a reason (`unsafe`, `value_shape`, `stale`, `cardinality`) |
| `400 malformed`, `413 too_large`, `415 content_type` | the request shape is wrong (unknown fields too); fix the integration |
| `404 unknown_site` | wrong site key |
| `403 tenant_pending` / `tenant_suspended` | your project is not approved yet, or suspended |
| `429 rate_limited` / `quota_exceeded` | too many requests, or the day's app-event budget (same size as your web quota) is used; honour `Retry-After` |
| `503` | try again later (`Retry-After`) |

## What you get, and known limits

Per day and platform: events per name, counts per property value, sessions, sessions by app version, by helper
version and (Mini Apps) by Telegram client, and dropped events by reason — all labelled self-attested.

- A session that spans midnight counts on both days; with more than one edge node, a session seen by two nodes counts
  twice (UsageMap v1 runs one node).
- Per site and day an edge node accepts at most 100 distinct event names and 1,000 distinct property values; beyond
  that events are dropped as `cardinality`. Keep names and values to a fixed list.
- Counts are aggregated in memory and written to the edge's durable spool once a minute; if the node dies, up to a
  minute of counts can be lost (the same rule as the web verdict counters).
- No bot check is possible for apps. Anyone who has your public key can send app events for your site; that is why
  these counts are self-attested and kept apart.
