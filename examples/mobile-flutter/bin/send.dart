// SPDX-License-Identifier: Apache-2.0
// The app's events without Flutter: the same helper, the same calls as lib/main.dart, from the command line.
//   USAGEMAP_SITE=<site key> [USAGEMAP_ENDPOINT=https://<ingest host>/v1/app-events] dart bin/send.dart
import 'dart:io';

import '../lib/io_transport.dart';
import '../lib/usagemap_app_events.dart';

Future<void> main() async {
  final env = Platform.environment;
  final endpoint = env['USAGEMAP_ENDPOINT'];
  final analytics = UsageMapApp(
    siteKey: env['USAGEMAP_SITE'] ?? 'YOUR_22_CHAR_SITE_KEY',
    platform: 'android',
    appVersion: '1.0.0',
    transport: ioTransport(),
    endpoint: endpoint == null ? null : Uri.parse(endpoint),
  );
  analytics.track('app_open');
  analytics.track('swap_started', {'pair_class': 'stablecoin'});
  await analytics.flush();
  stdout.writeln(analytics.pending == 0 ? 'sent 2 events' : 'not sent (${analytics.pending} queued)');
  exit(analytics.pending == 0 ? 0 : 1);
}
