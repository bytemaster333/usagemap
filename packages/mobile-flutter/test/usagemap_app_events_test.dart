// SPDX-License-Identifier: Apache-2.0
// Self-contained tests (no package:test, so the package stays dependency-free): `dart run test/usagemap_app_events_test.dart`.
// Exit code 0 = all passed.

import 'dart:convert';
import 'dart:io';

import '../lib/io_transport.dart';
import '../lib/usagemap_app_events.dart';

const key = 'AAAAAAAAAAAAAAAAAAAAAA';
var failures = 0;
void check(bool ok, String what) {
  if (!ok) {
    failures++;
    stderr.writeln('FAIL: $what');
  }
}

Future<void> main() async {
  var t = DateTime.utc(2026, 11, 19, 10);
  final bodies = <Map<String, dynamic>>[];
  final statuses = <int>[];
  Future<int> fake(Uri u, String b) async {
    bodies.add(jsonDecode(b) as Map<String, dynamic>);
    return statuses.isEmpty ? 202 : statuses.removeAt(0);
  }

  // Batch shape (§a.9), no identifier beyond the rotating session.
  var app = UsageMapApp(siteKey: key, platform: 'ios', appVersion: '1.4.2', transport: fake, now: () => t);
  check(app.track('swap_started', {'tier': 'pro'}), 'track ok');
  check(app.track('app_open'), 'track no props');
  await app.flush();
  final b = bodies.single;
  check(
    (b.keys.toList()..sort()).join(',') == 'app_version,events,k,platform,sdk_version,v',
    'top-level keys ${b.keys}',
  );
  check(b['k'] == key && b['platform'] == 'ios' && b['sdk_version'] == sdkVersion && b['v'] == 1, 'header fields');
  final evs = (b['events'] as List).cast<Map<String, dynamic>>();
  check(evs[0]['name'] == 'swap_started' && (evs[0]['props'] as Map)['tier'] == 'pro', 'event 0');
  check(!evs[1].containsKey('props'), 'no empty props');
  check(RegExp(r'^[A-Za-z0-9_-]{16,64}$').hasMatch(evs[0]['session'] as String), 'session shape');
  check(evs[0]['session'] == evs[1]['session'], 'same session');
  check(app.pending == 0, 'drained');

  // Rotation at 30 minutes.
  bodies.clear();
  app.track('a');
  t = t.add(const Duration(minutes: 29));
  app.track('b');
  t = t.add(const Duration(minutes: 1));
  app.track('c');
  await app.flush();
  final s = (bodies.single['events'] as List).map((e) => (e as Map)['session']).toList();
  check(s[0] == s[1] && s[1] != s[2], 'rotation $s');

  // Refusals.
  check(!app.track('_x') && !app.track('a b'), 'bad names');
  check(!app.track('ok', {'memo': 'Hello world'}) && !app.track('ok', {'Tier': 'pro'}), 'bad props');
  check(!app.track('ok', {for (var i = 0; i < 9; i++) 'k$i': 'v'}), 'too many props');
  check(app.pending == 0, 'refused events not queued');

  // Retry semantics.
  statuses.addAll([0, 429, 503, 400]);
  app = UsageMapApp(siteKey: key, platform: 'android', appVersion: '2.0', transport: fake, batchSize: 20);
  app.track('a');
  for (var i = 0; i < 3; i++) {
    await app.flush();
    check(app.pending == 1, 'kept after retryable status $i');
  }
  await app.flush();
  check(app.pending == 0, 'dropped after 400');

  // Queue cap and batching.
  bodies.clear();
  statuses.add(500);
  app = UsageMapApp(siteKey: key, platform: 'android', appVersion: '2.0', transport: fake, batchSize: 20);
  for (var i = 0; i < 130; i++) {
    app.track('e_${i % 7}');
  }
  await app.flush();
  check(app.pending == 100, 'capped at 100 (${app.pending})');
  await app.flush();
  check(app.pending == 0 && bodies.every((b) => (b['events'] as List).length <= 20), 'batches of ≤ 20');

  // Telegram Mini App class.
  check(
    [
          'android',
          'android_x',
          'ios',
          'macos',
          'tdesktop',
          'unigram',
          'weba',
          'webk',
          'web',
          'unknown',
          null,
        ].map(tmaPlatform).join(',') ==
        'android,android,ios,macos,desktop,desktop,web,web,web,other,other',
    'tmaPlatform',
  );
  var threw = false;
  try {
    UsageMapApp(siteKey: key, platform: 'windows', appVersion: '1', transport: fake);
  } on ArgumentError {
    threw = true;
  }
  check(threw, 'platform closed set');

  // Real dart:io transport against a local server.
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final got = <String>[];
  server.listen((r) async {
    got.add('${r.method} ${r.headers.contentType?.mimeType} ${await utf8.decodeStream(r)}');
    r.response.statusCode = 202;
    await r.response.close();
  });
  app = UsageMapApp(
    siteKey: key,
    platform: 'ios',
    appVersion: '1.0',
    transport: ioTransport(),
    endpoint: Uri.parse('http://127.0.0.1:${server.port}/v1/app-events'),
  );
  app.track('app_open');
  await app.flush();
  check(got.length == 1 && got[0].startsWith('POST application/json {"v":1'), 'io transport: $got');
  check(app.pending == 0, 'io transport drained');
  final port = server.port;
  await server.close(force: true);
  final dead = await ioTransport()(Uri.parse('http://127.0.0.1:$port/'), '{}');
  check(dead == 0, 'network error → 0');

  // Conformance fixture (parsed by the gateway's Go tests).
  bodies.clear();
  app = UsageMapApp(
      siteKey: key,
      platform: 'android',
      appVersion: '2.0.1+77',
      transport: fake,
      now: () => DateTime.utc(2026, 11, 19, 10));
  app.track('swap_started', {'tier': 'pro'});
  app.track('app_open');
  await app.flush();
  // Re-encoded compactly (key order kept), so the shared fixture may be formatted like the other JSON files.
  final fixture = jsonEncode(jsonDecode(File.fromUri(Platform.script.resolve('fixtures/batch.json')).readAsStringSync()));
  final produced =
      jsonEncode(bodies.single).replaceAll(RegExp(r'"session":"[A-Za-z0-9_-]+"'), '"session":"SESSIONSESSIONSESSION0"');
  check(produced == fixture, 'fixture\n$produced\n$fixture');

  if (failures > 0) exit(1);
  stdout.writeln('all passed');
  exit(0);
}
