#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-04 — reproduce everything:  ./run.sh            (= build item1 item2 item4 item4f item5 item5dial clean)
# or one step:                   ./run.sh build|item1|item2|item4|item4f|item5|item5dial|clean
# Output of each step is tee'd to evidence/<step>.txt.
# Needs: mise (Go 1.27.4), Docker Compose v5, python3, curl, network access to
# GitHub releases and proxy.golang.org. Host ports used: 127.0.0.1:184xx only.
set -uo pipefail
cd "$(dirname "$0")"
HERE=$PWD
REPO=$(cd ../.. && pwd)
eval "$(cd "$REPO" && mise env -s bash)"
export GOWORK=off CGO_ENABLED=0
export UID_GID="$(id -u):$(id -g)"
SCRATCH=${S04_SCRATCH:-/tmp/usagemap-spikes/s04}
OCB_VERSION=0.165.0
OCB_SHA256=6fd899cf8794803bb0d9ea0a055fdaabd2e7e8304de3872fd9aaec3f0cd7f18c   # ocb_0.165.0_linux_amd64
COSIGN_VERSION=v3.1.4
COSIGN_SHA256=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa   # cosign-linux-amd64 v3.1.4
DC=(docker compose -p scf-s04)
SEND=./work/bin/sendtest
AN=(python3 -I tools/analyze.py)
OUT=work/out
mkdir -p work/bin work/build "$OUT" evidence

say() { printf '\n=== %s\n' "$*"; }
metric() { curl -s "127.0.0.1:$1/metrics" | grep -E "$2" | grep -v '^#' || true; }
wait_health() { for _ in $(seq 60); do curl -sf "127.0.0.1:$1/" >/dev/null && return 0; sleep 0.5; done
  echo "health on :$1 never came up"; "${DC[@]}" --profile x ps -a --format '{{.Service}} {{.State}} {{.Status}}'
  "${DC[@]}" --profile x logs --tail 15 collector collector-x 2>&1 | cut -c1-400; return 1; }
wait_drained() { # port
  for _ in $(seq 120); do
    q=$(metric "$1" '^otelcol_exporter_queue_size' | awk '{s+=$2} END {print s+0}')
    [ "$q" = 0 ] && { sleep 1; return 0; }; sleep 0.5
  done; echo "queue never drained"; }
reset_sinks() { : >"$OUT/sink-a.jsonl"; : >"$OUT/sink-b.jsonl"; "${DC[@]}" up -d sink-a sink-b >/dev/null 2>&1; sleep 1
  for p in 18441 18442; do curl -s -XPOST "127.0.0.1:$p/control?status=200&delay_ms=0"; done; }
fresh_queue() { local d="queue-$1-$(date +%s%N)"; mkdir -p "work/$d"; echo "$d"; }

build() {
  say "ocb $OCB_VERSION: download, SHA-256, cosign bundle"
  mkdir -p "$SCRATCH/dl" "$SCRATCH/bin" "$SCRATCH/cosign"
  local base="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/cmd%2Fbuilder%2Fv$OCB_VERSION"
  local f="ocb_${OCB_VERSION}_linux_amd64"
  for x in "$f" "$f.sha256" "$f.sigstore.json"; do [ -f "$SCRATCH/dl/$x" ] || curl -sSL -o "$SCRATCH/dl/$x" "$base/$x"; done
  echo "published sha256: $(cat "$SCRATCH/dl/$f.sha256")"
  echo "$OCB_SHA256  $SCRATCH/dl/$f" | sha256sum -c - || return 1
  [ -f "$SCRATCH/cosign/cosign" ] || curl -sSL -o "$SCRATCH/cosign/cosign" "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-amd64"
  echo "$COSIGN_SHA256  $SCRATCH/cosign/cosign" | sha256sum -c - || return 1
  chmod +x "$SCRATCH/cosign/cosign"
  "$SCRATCH/cosign/cosign" verify-blob --bundle "$SCRATCH/dl/$f.sigstore.json" \
    --certificate-identity "https://github.com/open-telemetry/opentelemetry-collector-releases/.github/workflows/base-binary-release.yaml@refs/tags/v$OCB_VERSION" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "$SCRATCH/dl/$f" || return 1
  install -m 0755 "$SCRATCH/dl/$f" "$SCRATCH/bin/ocb"
  "$SCRATCH/bin/ocb" version
  go version

  say "ocb build: minimal distribution (builder-config.yaml)"
  ( time "$SCRATCH/bin/ocb" --config builder-config.yaml ) >work/ocb-minimal.log 2>&1 || { tail -30 work/ocb-minimal.log; return 1; }
  grep -E "Compiled|real" work/ocb-minimal.log
  say "ocb build: test-only distribution (builder-config-s04test.yaml)"
  ( time "$SCRATCH/bin/ocb" --config builder-config-s04test.yaml ) >work/ocb-s04test.log 2>&1 || { tail -30 work/ocb-s04test.log; return 1; }
  grep -E "Compiled|real" work/ocb-s04test.log
  cp work/build/scf-otelcol/scf-otelcol work/build/scf-otelcol-s04test/scf-otelcol-s04test work/bin/

  say "test programs (tools/)"
  (cd tools && go build -o ../work/bin/ ./cmd/...) || return 1
  (cd scfsanitizeprocessor && go vet ./...) || return 1

  say "images (FROM scratch)"
  docker build -q -t scf-s04/scf-otelcol:0.0.0-s04 -f docker/Dockerfile.collector work/bin
  docker build -q -t scf-s04/scf-otelcol-s04test:0.0.0-s04 --build-arg BIN=scf-otelcol-s04test -f docker/Dockerfile.collector work/bin
  docker build -q -t scf-s04/sink:0.0.0-s04 -f docker/Dockerfile.sink work/bin
  docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep '^scf-s04/'
}

item1() {
  say "binary"
  ls -l work/bin/scf-otelcol work/bin/scf-otelcol-s04test
  file work/bin/scf-otelcol
  echo "gzip -9 size: $(gzip -9c work/bin/scf-otelcol | wc -c) bytes"
  echo "modules in generated go.mod (require lines): $(grep -cE '^\s+[a-z].* v' work/build/scf-otelcol/go.mod)"
  go version -m work/bin/scf-otelcol | grep -E '^\s+(build|go)|otlpreceiver|otlphttp|memorylimiter|filterprocessor|transformprocessor|signaltometrics|filestorage|healthcheck|scfsanitize|=>|collector/otelcol '
  say "components (minimal build)"
  work/bin/scf-otelcol components
  say "config validation"
  SINK_ENDPOINT=http://sink-a:4319 work/bin/scf-otelcol validate --config config.yaml && echo "config.yaml: valid"
  FAILOVER_RETRY_INTERVAL=10s LAST_LEVEL_MAX_ELAPSED=3s work/bin/scf-otelcol-s04test validate --config config-failover.yaml && echo "config-failover.yaml: valid"
}

item2() {
  reset_sinks
  export Q; Q=$(fresh_queue main); export OVERLAY=overlay-none.yaml
  "${DC[@]}" up -d --force-recreate collector >/dev/null 2>&1; wait_health 18433 || return 1

  say "2a. logs: no logs pipeline (minimal build, config.yaml)"
  $SEND logs

  say "2b. what the Go SDK puts on the wire (spans posted straight to sink-a, no Collector)"
  $SEND spans -proto http -http 127.0.0.1:18441 >/dev/null
  "${AN[@]}" spans "$OUT/sink-a.jsonl"
  : >"$OUT/sink-a.jsonl"

  say "2c. same spans through the Collector, over HTTP and over gRPC"
  $SEND spans -proto http; $SEND spans -proto grpc
  sleep 2
  "${AN[@]}" dump "$OUT/sink-a.jsonl"
  python3 -I -c 'import json,sys; r=json.loads(open(sys.argv[1]).readline()); json.dump(r, open(sys.argv[2],"w"), indent=1)' "$OUT/sink-a.jsonl" evidence/item2-exported-span-derived.json
  echo "-- requests the sink received per path:"; grep -o '"path":"[^"]*"' "$OUT/sink-a.jsonl" | sort | uniq -c
  echo "-- Collector self-metrics:"
  metric 18488 '^otelcol_(receiver_accepted_spans|processor_filter_spans_filtered|exporter_sent_spans|exporter_sent_metric_points|connector_|processor_incoming_items|processor_outgoing_items)'
  echo "-- scfsanitize log lines:"; "${DC[@]}" logs collector 2>&1 | grep -o 'service_not_allowed.*"spans": [0-9]*' | sed 's/{"resource.*otelcol.signal": //' || true
  : >"$OUT/sink-a.jsonl"

  say "2d. SDK metrics through the Collector, over HTTP and over gRPC"
  $SEND metrics -proto http; $SEND metrics -proto grpc
  sleep 2
  "${AN[@]}" dump "$OUT/sink-a.jsonl"
  python3 -I -c 'import json,sys; r=json.loads(open(sys.argv[1]).readline()); json.dump(r, open(sys.argv[2],"w"), indent=1)' "$OUT/sink-a.jsonl" evidence/item2-exported-sdk-metrics.json

  say "3. request without x-scf-tenant-id"
  $SEND notenant
  sleep 1; "${DC[@]}" logs collector 2>&1 | grep -o 'no tenant metadata on request; dropping payload' | head -1

  say "canary search (spans/logs/PII canaries must not reach the queue directory or the sink)"
  for c in CANARY-LOG-7f3a CANARY-EVENT CANARY-HOST-9b1c CANARY-UA-55aa CANARY-QUERY-1234 CANARY-USER FORGED-TENANT 203.0.113.77 /users/42; do
    printf '  %-18s queue-dir:%s  sink-files:%s\n' "$c" "$(grep -rac -- "$c" "work/$Q" | awk -F: '{s+=$NF} END {print s+0}')" "$(cat "$OUT"/*.jsonl | grep -c -- "$c")"
  done
  "${DC[@]}" stop collector >/dev/null 2>&1
}

item4() {
  export OVERLAY=overlay-none.yaml
  local N=${N:-1000}
  say "4a. N=$N single-point requests while the sink is DOWN, kill -9, restart, sink up"
  reset_sinks; export Q; Q=$(fresh_queue d)
  "${DC[@]}" up -d --force-recreate collector >/dev/null 2>&1; wait_health 18433 || return 1
  "${DC[@]}" stop sink-a >/dev/null 2>&1
  $SEND burst -n "$N" -prefix d1
  sleep 2; metric 18488 '^otelcol_exporter_(queue_size|send_failed_metric_points|enqueue_failed)'
  ls -l "work/$Q"
  echo "canary request header in the on-disk queue (x-canary-hdr: CANARY-HDR-0c1d): $(grep -ac CANARY-HDR-0c1d work/"$Q"/* | awk -F: '{s+=$NF} END {print s+0}') matching blocks"
  "${DC[@]}" kill -s SIGKILL collector 2>&1 | tail -1
  "${DC[@]}" ps -a --format '{{.Service}} {{.State}} {{.Status}}' | grep collector
  "${DC[@]}" start collector >/dev/null 2>&1; wait_health 18433; sleep 3
  echo "-- restarted, sink still down:"; metric 18488 '^otelcol_exporter_queue_size'
  "${DC[@]}" start sink-a >/dev/null 2>&1; wait_drained 18488
  "${AN[@]}" routes d1 "$OUT/sink-a.jsonl"

  say "4b. duplicates: sink records each request, then holds the 200 for 5 s; kill -9 meanwhile"
  : >"$OUT/sink-a.jsonl"; curl -s -XPOST '127.0.0.1:18441/control?status=200&delay_ms=5000'
  $SEND burst -n 50 -prefix d2; sleep 2
  echo "requests recorded by the sink before the kill: $(wc -l <"$OUT/sink-a.jsonl")"
  "${DC[@]}" kill -s SIGKILL collector 2>&1 | tail -1; curl -s -XPOST '127.0.0.1:18441/control?delay_ms=0'
  "${DC[@]}" start collector 2>&1 | tail -1; wait_health 18433; wait_drained 18488
  "${AN[@]}" routes d2 "$OUT/sink-a.jsonl"

  say "4c. in-process retries: sink answers 503 three times per request"
  : >"$OUT/sink-a.jsonl"; curl -s -XPOST '127.0.0.1:18441/control?status=503&count=6'
  $SEND burst -n 2 -prefix d3; sleep 1; wait_drained 18488
  "${AN[@]}" batches d3 "$OUT/sink-a.jsonl"; "${AN[@]}" routes d3 "$OUT/sink-a.jsonl"

  say "4d. same as 4b, with sending_queue.batch (overlay-batch.yaml), N=95 (not a multiple of the batch size)"
  export OVERLAY=overlay-batch.yaml; Q=$(fresh_queue b)
  "${DC[@]}" up -d --force-recreate collector >/dev/null 2>&1; wait_health 18433
  : >"$OUT/sink-a.jsonl"; curl -s -XPOST '127.0.0.1:18441/control?status=200&delay_ms=5000'
  $SEND burst -n 95 -prefix b2; sleep 4
  "${DC[@]}" kill -s SIGKILL collector >/dev/null 2>&1; curl -s -XPOST '127.0.0.1:18441/control?delay_ms=0'
  "${DC[@]}" start collector >/dev/null 2>&1; wait_health 18433; wait_drained 18488
  "${AN[@]}" batches b2 "$OUT/sink-a.jsonl"; "${AN[@]}" routes b2 "$OUT/sink-a.jsonl"
  "${DC[@]}" stop collector >/dev/null 2>&1

  say "4e. does request metadata survive the persistent queue? (test build + headers_setter, overlay-meta.yaml)"
  reset_sinks; export QX; QX=$(fresh_queue meta); export XCONFIG=config.yaml XOVERLAY=overlay-meta.yaml
  "${DC[@]}" --profile x up -d --force-recreate collector-x >/dev/null 2>&1; wait_health 18434
  $SEND burst -n 3 -prefix m0 -http 127.0.0.1:18428; sleep 2
  "${DC[@]}" stop sink-a >/dev/null 2>&1
  $SEND burst -n 20 -prefix m1 -http 127.0.0.1:18428; sleep 2
  "${DC[@]}" kill -s SIGKILL collector-x >/dev/null 2>&1; "${DC[@]}" start sink-a >/dev/null 2>&1
  "${DC[@]}" --profile x start collector-x >/dev/null 2>&1; wait_health 18434; wait_drained 18489
  python3 -I - "$OUT/sink-a.jsonl" <<'EOF'
import json, sys, collections
c = collections.Counter()
for l in open(sys.argv[1]):
    r = json.loads(l)
    for rm in r["body"]["resourceMetrics"]:
        dp = rm["scopeMetrics"][0]["metrics"][0]["histogram"]["dataPoints"][0]
        rt = [a["value"]["stringValue"] for a in dp["attributes"] if a["key"] == "http.route"][0]
        c[(rt.split("/")[2], r["headers"].get("X-Scf-Tenant-Id"), r["headers"].get("X-Scf-Node"), r["status"])] += 1
for (p, t, n, s), v in sorted(c.items()):
    print(f"  prefix={p} ({'before crash, sink up' if p == 'm0' else 'queued across kill -9'}): X-Scf-Tenant-Id={t} X-Scf-Node={n} status={s} requests={v}")
EOF
  "${DC[@]}" --profile x stop collector-x >/dev/null 2>&1
}

item4f() {
  say "4f. is fsync really on? wall time of 2000 sequential acknowledged requests, sink down (queue only grows)"
  "${DC[@]}" up -d sink-a >/dev/null 2>&1; "${DC[@]}" stop sink-a >/dev/null 2>&1
  for ov in overlay-none.yaml overlay-nofsync.yaml; do
    export OVERLAY=$ov Q; Q=$(fresh_queue fs)
    "${DC[@]}" up -d --force-recreate collector >/dev/null 2>&1; wait_health 18433
    local t0=$EPOCHREALTIME; $SEND burst -n 2000 -prefix fs >/dev/null; local t1=$EPOCHREALTIME
    printf '  %-22s fsync=%-5s 2000 requests in %s s\n' "$ov" "$([ $ov = overlay-none.yaml ] && echo true || echo false)" "$(awk -v a="$t0" -v b="$t1" 'BEGIN {printf "%.2f", b-a}')"
    "${DC[@]}" stop collector >/dev/null 2>&1
  done
  echo "  disk under work/: $(df -h --output=source,fstype "$HERE/work" | tail -1)"
}

item5() {
  export XCONFIG=config-failover.yaml XOVERLAY=overlay-none.yaml
  local H=(-http 127.0.0.1:18428)

  say "5A-1. failover connector, both exporters with finite retries (core_b max_elapsed_time 3s), retry_interval 10s"
  reset_sinks; export QX; QX=$(fresh_queue fo1); export LAST_LEVEL_MAX_ELAPSED=3s FAILOVER_RETRY_INTERVAL=10s
  "${DC[@]}" --profile x up -d --force-recreate collector-x >/dev/null 2>&1; wait_health 18434 || return 1
  $SEND burst -n 20 -prefix f1 "${H[@]}"; sleep 2
  "${DC[@]}" kill sink-a >/dev/null 2>&1; echo "t+0: sink-a killed"
  $SEND burst -n 20 -prefix f2 "${H[@]}"; sleep 10
  "${DC[@]}" kill sink-b >/dev/null 2>&1; echo "sink-b killed too (no writer up)"
  $SEND burst -n 20 -prefix f3 "${H[@]}"; sleep 15
  "${DC[@]}" start sink-a sink-b >/dev/null 2>&1; echo "both sinks back; waiting 25 s (> retry_interval)"; sleep 25
  $SEND burst -n 20 -prefix f4 "${H[@]}"; sleep 5
  "${AN[@]}" sinks "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl"
  echo "-- connector queue / drops:"; metric 18489 '^otelcol_exporter_(queue_size|send_failed_metric_points|sent_metric_points)'
  "${DC[@]}" logs collector-x 2>&1 | grep -E 'Exporting failed. Dropping data|All provided pipelines' | head -2 | cut -c1-260

  say "5A-2. failover connector, last level retries forever (core_b max_elapsed_time 0); kill -9 while no writer is up"
  reset_sinks; QX=$(fresh_queue fo2); export LAST_LEVEL_MAX_ELAPSED=0s FAILOVER_RETRY_INTERVAL=10s
  "${DC[@]}" --profile x up -d --force-recreate collector-x >/dev/null 2>&1; wait_health 18434
  "${DC[@]}" kill sink-a sink-b >/dev/null 2>&1; echo "both sinks down"
  $SEND burst -n 30 -prefix g1 "${H[@]}"; sleep 8
  metric 18489 '^otelcol_exporter_(queue_size|send_failed_metric_points)'
  "${DC[@]}" kill -s SIGKILL collector-x >/dev/null 2>&1; echo "collector-x kill -9"
  "${DC[@]}" --profile x start collector-x >/dev/null 2>&1; wait_health 18434; echo "restarted; 15 s with no writer up"; sleep 15
  metric 18489 '^otelcol_exporter_(queue_size|send_failed_metric_points)'
  "${DC[@]}" start sink-a >/dev/null 2>&1; echo "only sink-a (priority 1) back; 30 s"; sleep 30
  "${AN[@]}" sinks "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl"; "${AN[@]}" routes g1 "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl"
  metric 18489 '^otelcol_exporter_queue_size'
  "${DC[@]}" start sink-b >/dev/null 2>&1; echo "sink-b back too; 15 s"; sleep 15
  "${AN[@]}" sinks "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl"; "${AN[@]}" routes g1 "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl"
  metric 18489 '^otelcol_exporter_queue_size'
  "${DC[@]}" --profile x stop collector-x >/dev/null 2>&1

  say "5B. one otlp_http exporter, endpoint http://writers:4319, /etc/hosts gives 'writers' both sink IPs (Go dialer tries each address)"
  reset_sinks
  export WRITER_A_IP WRITER_B_IP
  WRITER_A_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' scf-s04-sink-a-1)
  WRITER_B_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' scf-s04-sink-b-1)
  QX=$(fresh_queue dns); export XCONFIG=config.yaml XOVERLAY=overlay-none.yaml SINK_ENDPOINT=http://writers:4319
  "${DC[@]}" --profile x up -d --force-recreate collector-x >/dev/null 2>&1; wait_health 18434
  echo "-- extra_hosts of the Collector container: $(docker inspect -f '{{.HostConfig.ExtraHosts}}' scf-s04-collector-x-1)"
  $SEND burst -n 20 -prefix h1 "${H[@]}"; sleep 2
  "${DC[@]}" kill sink-a >/dev/null 2>&1; echo "sink-a killed (container gone: pooled keep-alive connections to it are now half-open)"
  $SEND burst -n 20 -prefix h2 "${H[@]}"; sleep 40
  "${AN[@]}" sinks "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl"
  "${DC[@]}" kill sink-b >/dev/null 2>&1; "${DC[@]}" start sink-a >/dev/null 2>&1; echo "sink-b killed, sink-a back"
  $SEND burst -n 20 -prefix h3 "${H[@]}"; sleep 40
  "${DC[@]}" start sink-b >/dev/null 2>&1
  "${AN[@]}" sinks "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl"
  for p in h1 h2 h3; do "${AN[@]}" routes $p "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl"; done
  metric 18489 '^otelcol_exporter_(queue_size|send_failed_metric_points)'
  echo "-- retry log lines (error text only):"
  "${DC[@]}" logs collector-x 2>&1 | grep 'Will retry' | grep -oE '"error": "([^"\\]|\\.)*"' | sed -E 's/Post \\"[^"]*\\": //' | sort | uniq -c
  echo "-- first/last delivery per phase (sink receive time):"
  python3 -I - "$OUT/sink-a.jsonl" "$OUT/sink-b.jsonl" <<'EOF2'
import json, sys
rows = []
for f in sys.argv[1:]:
    for l in open(f):
        r = json.loads(l)
        dp = r["body"]["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["histogram"]["dataPoints"][0]
        rt = [a["value"]["stringValue"] for a in dp["attributes"] if a["key"] == "http.route"][0]
        if rt.endswith("/0") or rt.endswith("/19"):
            rows.append((r["time"], r["sink"], rt, r["status"]))
for row in sorted(rows):
    print("  ", *row)
EOF2
  unset SINK_ENDPOINT
  "${DC[@]}" --profile x stop collector-x >/dev/null 2>&1
}

item5dial() {
  say "5B diagnostics: Go resolver + dialer inside a scratch container, 'writers' -> two addresses, first one gone"
  reset_sinks
  local A B
  A=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' scf-s04-sink-a-1)
  B=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' scf-s04-sink-b-1)
  "${DC[@]}" kill sink-a >/dev/null 2>&1
  docker run --rm --network scf-s04_default --add-host "writers:$A" --add-host "writers:$B" \
    -v "$HERE/work/bin/dialtest:/dialtest:ro" --entrypoint /dialtest scf-s04/sink:0.0.0-s04 writers:4319
  "${DC[@]}" start sink-a >/dev/null 2>&1
}

clean() {
  say "clean up (containers, networks, volumes; images kept)"
  "${DC[@]}" --profile x down -v --remove-orphans 2>&1 | tail -3
}

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(build item1 item2 item4 item4f item5 item5dial clean)
for s in "${steps[@]}"; do
  { echo "# ./run.sh $s — $(date -u +%FT%TZ)"; "$s"; } 2>&1 | tee "evidence/$s.txt"
done
