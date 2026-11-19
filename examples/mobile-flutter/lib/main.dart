// SPDX-License-Identifier: Apache-2.0
// A one-screen Flutter app that reports two named events to UsageMap: `app_open` on start and `swap_started` on a
// tap. The queue is flushed when the app is paused. No device id, user id or address exists in the API.
import 'dart:io' show Platform;

import 'package:flutter/material.dart';

import 'io_transport.dart';
import 'usagemap_app_events.dart';

// UsageMap: one instance for the whole app (site key from the portal: Project → Websites)
final analytics = UsageMapApp(
  siteKey: const String.fromEnvironment('USAGEMAP_SITE', defaultValue: 'YOUR_22_CHAR_SITE_KEY'),
  platform: Platform.isIOS ? 'ios' : 'android',
  appVersion: '1.0.0',
  transport: ioTransport(),
);

void main() {
  analytics.track('app_open');
  runApp(const ExampleApp());
}

class ExampleApp extends StatefulWidget {
  const ExampleApp({super.key});

  @override
  State<ExampleApp> createState() => _ExampleAppState();
}

class _ExampleAppState extends State<ExampleApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) analytics.flush();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text('UsageMap app events'),
              ElevatedButton(
                onPressed: () => analytics.track('swap_started', {'pair_class': 'stablecoin'}),
                child: const Text('Start a swap'),
              ),
              ElevatedButton(onPressed: analytics.flush, child: const Text('Send now')),
            ]),
          ),
        ),
      );
}
