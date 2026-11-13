#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-06b: reproduce every dual-export scenario and write evidence/report.md.
#   ./run.sh            all stacks          ./run.sh go|rust|java|dotnet   one stack (collector output is reset)
# Needs: Docker + Compose v5, python3, and Go 1.27.4 from mise in the repo root. Host ports 18610, 18620, 18640-18670.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
ONLY=${1:-all}
P=scf-s06b
NET=${P}_default
DC=(docker compose -p "$P" --profile tenantcol)
# Fake test credentials (not secrets): the UsageMap ingest token the test collector expects, and the "APM key".
export SCF_OTLP_TOKEN=scfa_ing_s06btest0000000000000000 APM_API_KEY=apm-test-key-s06b UID_GID="$(id -u):$(id -g)"
want() { [[ $ONLY == all || $ONLY == "$1" ]]; }
mark() { curl -s -X POST "http://127.0.0.1:18620/__scenario/$1" >/dev/null; echo "== scenario $1"; }

# ---------- infra ----------
"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf out && mkdir -p out/tls evidence
# Throwaway self-signed certificate so the proxy can also serve https://scf-proxy:4443 (Rust TLS test).
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=s06b-test-ca -keyout out/tls/ca.key -out out/tls/ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=scf-proxy -keyout out/tls/scf-proxy.key -out out/tls/scf-proxy.csr 2>/dev/null
openssl x509 -req -in out/tls/scf-proxy.csr -CA out/tls/ca.crt -CAkey out/tls/ca.key -days 2 \
  -extfile <(printf 'subjectAltName=DNS:scf-proxy\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth') \
  -out out/tls/scf-proxy.crt 2>/dev/null
chmod 644 out/tls/*
"${DC[@]}" up -d --wait 2>/dev/null || "${DC[@]}" up -d
sleep 3

# ---------- builds ----------
if want go; then
  (cd ../.. && eval "$(mise env -s bash)" && cd "$HERE/apps/go-nethttp" && GOWORK=off go build -o "$HERE/out/s06b-go" .)
fi
want rust && docker build -q -t scf-s06b/rust-axum:dev apps/rust-axum >/dev/null
want java && docker build -q -t scf-s06b/java-spring:dev apps/java-spring >/dev/null
want dotnet && docker build -q -t scf-s06b/dotnet-minimal:dev apps/dotnet-minimal >/dev/null

# ---------- runners ----------
run_go() { # scenario, env...
  local sc=$1; shift
  mark "$sc"
  env -i PATH="$PATH" OTEL_SERVICE_NAME="$sc" OTEL_METRIC_EXPORT_INTERVAL=5000 LISTEN=127.0.0.1:18640 \
    SCF_OTLP_ENDPOINT=http://127.0.0.1:18620 SCF_OTLP_TOKEN="$SCF_OTLP_TOKEN" APM_API_KEY="$APM_API_KEY" \
    APM_ENDPOINT=http://127.0.0.1:18610 "$@" out/s06b-go >"out/$sc.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 50); do grep -q listening "out/$sc.log" && break; kill -0 $pid 2>/dev/null || break; sleep 0.2; done
  if kill -0 $pid 2>/dev/null; then
    bash tools/traffic.sh http://127.0.0.1:18640; sleep 7; kill -TERM $pid; wait $pid || true
  else
    wait $pid || true
  fi
  tail -2 "out/$sc.log"
}

run_ctr() { # scenario, image, host-port, ready-regex, docker-run args...
  local sc=$1 img=$2 port=$3 ready=$4; shift 4
  mark "$sc"
  docker rm -f "$P-app" >/dev/null 2>&1 || true
  docker run -d --name "$P-app" --network "$NET" -p "127.0.0.1:$port:8080" \
    -e OTEL_SERVICE_NAME="$sc" -e OTEL_METRIC_EXPORT_INTERVAL=5000 \
    -e APM_ENDPOINT=http://apm:4318 -e SCF_OTLP_ENDPOINT=http://scf-proxy:4318 \
    -e SCF_OTLP_TOKEN="$SCF_OTLP_TOKEN" -e APM_API_KEY="$APM_API_KEY" "$@" "$img" >/dev/null
  for _ in $(seq 1 120); do docker logs "$P-app" 2>&1 | grep -Eq "$ready" && break; sleep 0.5; done
  bash tools/traffic.sh "http://127.0.0.1:$port"
  sleep 7
  docker stop -t 30 "$P-app" >/dev/null
  docker logs "$P-app" >"out/$sc.log" 2>&1
  docker rm "$P-app" >/dev/null
  grep -iE 'error|warn|401|unauthor' "out/$sc.log" | grep -v 'canary' | head -4 || true
}

# ---------- 1. Go ----------
if want go; then
  run_go s06b-go-code OTEL_SETUP=code OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:18610 \
    OTEL_EXPORTER_OTLP_HEADERS="api-key=$APM_API_KEY"
  run_go s06b-go-code-envhazard OTEL_SETUP=code OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:18610 \
    OTEL_EXPORTER_OTLP_HEADERS="api-key=$APM_API_KEY,authorization=Bearer%20WRONG"
  run_go s06b-go-code-servername OTEL_SETUP=code OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:18610 \
    OTEL_EXPORTER_OTLP_HEADERS="api-key=$APM_API_KEY" HTTP_SERVER_NAME=accounts-api
  run_go s06b-go-code-servername-port OTEL_SETUP=code OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:18610 \
    OTEL_EXPORTER_OTLP_HEADERS="api-key=$APM_API_KEY" HTTP_SERVER_NAME=accounts-api:443
  run_go s06b-go-otelconf OTEL_SETUP=otelconf OTEL_CONFIG_FILE=apps/go-nethttp/sdk.yaml \
    OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20WRONG"
  run_go s06b-go-otelconf-deprecated-var OTEL_SETUP=otelconf OTEL_EXPERIMENTAL_CONFIG_FILE=apps/go-nethttp/sdk.yaml
fi

# ---------- 2. Rust ----------
if want rust; then
  R=scf-s06b/rust-axum:dev
  # Rust has no instance-id detector: the recipe sets service.instance.id through OTEL_RESOURCE_ATTRIBUTES.
  run_ctr s06b-rust-tower "$R" 18650 'listening' -e RUST_OTEL_MODE=tower \
    -e OTEL_RESOURCE_ATTRIBUTES=service.instance.id=rust-tower-replica-1
  run_ctr s06b-rust-tower-envleak "$R" 18650 'listening' -e RUST_OTEL_MODE=tower \
    -e OTEL_EXPORTER_OTLP_HEADERS="api-key=$APM_API_KEY"
  run_ctr s06b-rust-tower-envhazard "$R" 18650 'listening' -e RUST_OTEL_MODE=tower \
    -e OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20WRONG"
  run_ctr s06b-rust-tracing "$R" 18650 'listening' -e RUST_OTEL_MODE=tracing
  run_ctr s06b-rust-tracing-infofilter "$R" 18650 'listening' -e RUST_OTEL_MODE=tracing -e RUST_LOG=info
  # TLS: UsageMap exporter -> https://scf-proxy:4443 (self-signed cert trusted via SSL_CERT_FILE), default build vs tls build.
  TLSA=(-e SCF_OTLP_ENDPOINT=https://scf-proxy:4443 -e SSL_CERT_FILE=/tls/ca.crt -v "$HERE/out/tls:/tls:ro")
  run_ctr s06b-rust-https-default "$R" 18650 'listening' -e RUST_OTEL_MODE=tower "${TLSA[@]}" \
    -e RUST_LOG=warn,opentelemetry_otlp=debug,opentelemetry-otlp=debug,opentelemetry_http=debug
  run_ctr s06b-rust-https-tlsfeature "$R" 18650 'listening' -e RUST_OTEL_MODE=tower "${TLSA[@]}" \
    --entrypoint /usr/local/bin/s06b-rust-axum-tls
  # Same TLS build with an empty CA directory (as in an image without ca-certificates): exporter build fails.
  echo "== s06b-rust-tls-no-ca-bundle"
  docker run --rm --network "$NET" -e RUST_OTEL_MODE=tower -e APM_ENDPOINT=http://apm:4318 \
    -e SCF_OTLP_ENDPOINT=https://scf-proxy:4318 --tmpfs /etc/ssl/certs --entrypoint /usr/local/bin/s06b-rust-axum-tls \
    "$R" >out/s06b-rust-tls-no-ca-bundle.log 2>&1 || echo "exit=$?" >>out/s06b-rust-tls-no-ca-bundle.log
  cat out/s06b-rust-tls-no-ca-bundle.log
fi

# ---------- 3. Java ----------
if want java; then
  J=scf-s06b/java-spring:dev
  # 3a. agent + declarative config file with two metric readers; env headers set to a wrong token on purpose.
  run_ctr s06b-java-otelconf "$J" 18660 'Started App' -e OTEL_CONFIG_FILE=/app/otel/sdk.yaml \
    -e OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20WRONG"
  # 3b. agent with plain env config -> tenant-side Collector (recipe A) -> APM + UsageMap.
  run_ctr s06b-java-tenantcol "$J" 18660 'Started App' -e OTEL_EXPORTER_OTLP_ENDPOINT=http://tenant-col:4318
fi

# ---------- 4. .NET ----------
if want dotnet; then
  D=scf-s06b/dotnet-minimal:dev
  run_ctr s06b-dotnet "$D" 18670 'Now listening|Application started'
  run_ctr s06b-dotnet-envhazard "$D" 18670 'Now listening|Application started' \
    -e OTEL_EXPORTER_OTLP_HEADERS="api-key=$APM_API_KEY,authorization=Bearer%20WRONG"
fi

# ---------- report + cleanup ----------
sleep 3
"${DC[@]}" logs tenant-col >out/tenant-col.log 2>&1 || true
python3 -I tools/analyze.py out >"evidence/report-$ONLY.md"
"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
echo "report: evidence/report-$ONLY.md"
