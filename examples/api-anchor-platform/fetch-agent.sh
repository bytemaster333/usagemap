#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Downloads the OpenTelemetry Java agent 2.33.1 from Maven Central into the given directory and checks its SHA-256.
set -eu
dir="${1:-./otel}"
version=2.33.1
sha256=e43a270df53c6f423e0ab157be9c27ccc01d5dc3232e162fe54777573db2f149
mkdir -p "$dir"
curl -fsSL -o "$dir/opentelemetry-javaagent.jar.part" \
  "https://repo1.maven.org/maven2/io/opentelemetry/javaagent/opentelemetry-javaagent/$version/opentelemetry-javaagent-$version.jar"
echo "$sha256  $dir/opentelemetry-javaagent.jar.part" | sha256sum -c - >/dev/null
mv "$dir/opentelemetry-javaagent.jar.part" "$dir/opentelemetry-javaagent.jar"
echo "$dir/opentelemetry-javaagent.jar"
