// SPDX-License-Identifier: Apache-2.0
// The dart:io transport (iOS, Android, desktop). Flutter web: pass a transport built on package:http or fetch.
library;

import 'dart:convert';
import 'dart:io';

import 'usagemap_app_events.dart';

/// POSTs the body with a 10-second timeout and returns the status (0 on any network error). Sends no cookies and no
/// User-Agent beyond the platform default; the edge never reads it.
Transport ioTransport({HttpClient? client}) {
  final c = client ?? (HttpClient()..connectionTimeout = const Duration(seconds: 10));
  return (Uri endpoint, String jsonBody) async {
    try {
      final req = await c.postUrl(endpoint).timeout(const Duration(seconds: 10));
      req.headers.contentType = ContentType.json;
      req.add(utf8.encode(jsonBody));
      final res = await req.close().timeout(const Duration(seconds: 10));
      await res.drain<void>();
      return res.statusCode;
    } catch (_) {
      return 0;
    }
  };
}
