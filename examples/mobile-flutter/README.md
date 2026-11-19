# Flutter and Dart

A one-screen Flutter app that sends two named app events to UsageMap: `app_open` when it starts and `swap_started`
when you tap the button. The helper is two dependency-free files in `lib/`, copies of `packages/mobile-flutter/lib`.
`bin/send.dart` sends the same events from the command line with plain Dart, no Flutter needed. Counts from apps are
**self-attested** (no bot check is possible in an app). Guide:
[Mobile apps and Telegram Mini Apps](../../docs/onboarding/mobile.md#flutter-and-dart).

## Run it

1. **Install:** `cd examples/mobile-flutter && flutter create --project-name usagemap_example .` (adds the
   `android/` and `ios/` folders and keeps the existing files), then `flutter pub get`.
2. **Set your key:** pass the 22-character site key from the portal (**Project → Websites**, the same public key as
   the web tag) at build time: `--dart-define=USAGEMAP_SITE=<site key>`.
3. **Run:** `flutter run --dart-define=USAGEMAP_SITE=<site key>` on a device or emulator; tap **Start a swap**, then
   **Send now**. Without Flutter: `USAGEMAP_SITE=<site key> dart bin/send.dart` prints `sent 2 events`.

## The lines that add UsageMap

`lib/main.dart`:

```dart
import 'io_transport.dart';
import 'usagemap_app_events.dart';

// UsageMap: one instance for the whole app (site key from the portal: Project → Websites)
final analytics = UsageMapApp(
  siteKey: const String.fromEnvironment('USAGEMAP_SITE', defaultValue: 'YOUR_22_CHAR_SITE_KEY'),
  platform: Platform.isIOS ? 'ios' : 'android',
  appVersion: '1.0.0',
  transport: ioTransport(),
);
```

`lib/main.dart`:

```dart
  analytics.track('app_open');
```

`lib/main.dart`:

```dart
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) analytics.flush();
  }
```

`lib/main.dart`:

```dart
                onPressed: () => analytics.track('swap_started', {'pair_class': 'stablecoin'}),
```

The default endpoint is `https://e1.usagemap.dev/v1/app-events`; pass `endpoint: Uri.parse(...)` for another
deployment. Flutter web needs a `transport` built on `package:http` or the browser's `fetch` instead of
`ioTransport()`.

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

`tests/quickstarts/integrations/tools.spec.ts` (`mobile-flutter`): checks that the two files in `lib/` are byte for
byte the package's, then runs `bin/send.dart` in the pinned `dart:3.14.1` image (Docker, host network) against a local
stand-in of `/v1/app-events` and checks the request: method, `content-type`, the body's fields (`v`, `k`, `platform`,
`app_version`, `sdk_version: mobile-flutter/0.1.0`, `events[{ts, session, name, props}]`) and nothing else. **Not
run:** the Flutter UI in `lib/main.dart` (no Flutter SDK, device or emulator in the test suite); it uses the same helper and the
same calls as `bin/send.dart`.
