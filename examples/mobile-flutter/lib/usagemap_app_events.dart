// SPDX-License-Identifier: Apache-2.0
// UsageMap app events (wire-formats §a.9) for Flutter and Dart. No dependencies: the transport is a function, and
// `ioTransport` (dart:io, iOS/Android/desktop) is provided in `io_transport.dart`. Counts are self-attested. Nothing
// persistent: the session id is random, kept in memory and replaced at the latest after 30 minutes; the API has no
// place for a device id, install id, advertising id, user id or wallet address.
library;

import 'dart:convert';
import 'dart:math';

/// Sends one JSON body and returns the HTTP status (0 = network error).
typedef Transport = Future<int> Function(Uri endpoint, String jsonBody);

const String sdkVersion = 'mobile-flutter/0.1.0';
const Duration _sessionLife = Duration(minutes: 30);
const int _maxQueue = 100;
final RegExp _name = RegExp(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$');
final RegExp _token = RegExp(r'^[a-z][a-z0-9_]{0,31}$');
const Set<String> _platforms = {'ios', 'android', 'web'};

/// Maps Telegram's `WebApp.platform` to the closed class of §a.9 (for a Flutter-web Mini App).
String tmaPlatform(String? raw) => switch (raw) {
      'android' || 'android_x' => 'android',
      'ios' || 'macos' || 'web' => raw!,
      'tdesktop' || 'unigram' => 'desktop',
      'weba' || 'webk' => 'web',
      _ => 'other',
    };

class UsageMapApp {
  UsageMapApp({
    required this.siteKey,
    required this.platform,
    required this.appVersion,
    required this.transport,
    Uri? endpoint,
    this.tmaPlatform,
    int batchSize = 10,
    DateTime Function()? now,
    Random? random,
  })  : endpoint = endpoint ?? Uri.parse('https://e1.usagemap.dev/v1/app-events'),
        batchSize = batchSize.clamp(1, 20),
        _now = now ?? DateTime.now,
        _random = random ?? Random.secure() {
    if (!_platforms.contains(platform)) throw ArgumentError.value(platform, 'platform', 'ios | android | web');
  }

  final String siteKey, platform, appVersion;
  final String? tmaPlatform;
  final Transport transport;
  final Uri endpoint;
  final int batchSize;
  final DateTime Function() _now;
  final Random _random;
  final List<Map<String, Object>> _queue = [];
  String _session = '';
  DateTime _sessionStart = DateTime.fromMillisecondsSinceEpoch(0);
  Future<void>? _inFlight;

  int get pending => _queue.length;

  /// Queues one event; false (dropped) when the name or a property is not allowed. Values are enum tokens only.
  bool track(String name, [Map<String, String> props = const {}]) {
    if (!_name.hasMatch(name) || props.length > 8) return false;
    if (props.entries.any((e) => !_token.hasMatch(e.key) || !_token.hasMatch(e.value))) return false;
    final t = _now();
    if (_session.isEmpty || t.difference(_sessionStart) >= _sessionLife) {
      const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      _session = String.fromCharCodes(List.generate(22, (_) => abc.codeUnitAt(_random.nextInt(64))));
      _sessionStart = t;
    }
    _queue.add({
      'ts': t.millisecondsSinceEpoch,
      'session': _session,
      'name': name,
      if (props.isNotEmpty) 'props': Map<String, String>.of(props),
    });
    if (_queue.length > _maxQueue) _queue.removeRange(0, _queue.length - _maxQueue);
    if (_queue.length >= batchSize) flush();
    return true;
  }

  /// Sends the queue in batches of ≤ 20; network errors, 429 and 5xx keep the events for the next flush.
  Future<void> flush() => _inFlight ??= _drain().whenComplete(() => _inFlight = null);

  Future<void> _drain() async {
    while (_queue.isNotEmpty) {
      final events = _queue.take(20).toList();
      final body = jsonEncode({
        'v': 1,
        'k': siteKey,
        'platform': platform,
        'app_version': appVersion,
        'sdk_version': sdkVersion,
        if (tmaPlatform != null) 'tma_platform': tmaPlatform,
        'events': events,
      });
      var status = 0;
      try {
        status = await transport(endpoint, body);
      } catch (_) {}
      if (status == 0 || status == 429 || status >= 500) return;
      _queue.removeWhere((e) => events.any((s) => identical(s, e))); // 2xx, or a 4xx never accepted
    }
  }
}
