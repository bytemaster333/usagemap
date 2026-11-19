#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The package's own suite (test/usagemap_app_events_test.dart, no package:test) and `dart analyze --fatal-infos`, in the
# pinned Dart image (same digest as tests/quickstarts/integrations/tools.spec.ts). The package is mounted read-only
# and copied to a tmpfs inside the container, so no .dart_tool/ or pubspec.lock lands in the checkout; no network (the
# package has no dependencies). DART_IMAGE overrides the image; DART=host runs the host's `dart` instead.
set -euo pipefail
pkg="$(cd "$(dirname "$0")/.." && pwd)"
image="${DART_IMAGE:-dart:3.14.1@sha256:36176bf7b6400bdc4aa77ba07b733b2eabf22640f71afd1b83eba679a26d5698}"
suite='set -eu
cp -R /src/. /work && cd /work
dart --version
dart --suppress-analytics analyze --fatal-infos
dart --suppress-analytics run test/usagemap_app_events_test.dart'
if [[ "${DART:-}" == host ]]; then
  work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
  cp -R "$pkg/." "$work"
  cd "$work"
  dart --suppress-analytics analyze --fatal-infos
  dart --suppress-analytics run test/usagemap_app_events_test.dart
  exit 0
fi
exec docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" -e HOME=/work -e PUB_CACHE=/work/.pub-cache \
  --tmpfs "/work:rw,exec,size=512m,uid=$(id -u),gid=$(id -g)" -v "$pkg:/src:ro" -w /work \
  "$image" sh -c "$suite"
