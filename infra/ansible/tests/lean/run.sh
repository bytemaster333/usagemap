#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Lean-profile role test (C-123): playbooks/lean.yml applied over SSH to a Debian 13 "VM" container (systemd, sshd,
# privileged so Docker runs inside it), then the whole Compose stack brought up by the role and checked from outside:
#
#   1. syntax-check + ansible-lint (production profile) of the lean playbook and its roles
#   2. run 1 with scf_stack_up=false (host baseline, firewall, pinned Docker Engine from download.docker.com, PKI,
#      secrets, TLS, release, rendered configuration, `docker compose config`)
#   2b. negative runs: the role refuses a deploy while a required Alertmanager receiver has no channel, and a tracker
#      release whose files do not match its SHA256SUMS (inputs from tests/lean/prepare.py)
#   3. the release images are loaded into the VM's Docker (no registry in a test) under test release names
#      (scf-lean.test/<name>:release) that no Compose default uses, so an unpinned service cannot pass by accident
#   4. run 2: the stack comes up (`up --wait`), restore-drill timer installed
#   5. checks from a client on the two front networks: TLS on the ingest and portal names with the right
#      certificates, tracker file, OTLP without a token → 401, no dev/test fixture (compose.dev.yaml) in the stack,
#      the portal and its API proxy, the snapshot keys, the status host; nothing but 443 answers on the front addresses; host firewall rules; Docker daemon settings and
#      held packages; secret file modes; the backup scheduler's first full backups in both repositories (pgBackRest,
#      single mode without Patroni) and their metrics through the node exporter into Prometheus; a restore drill run
#      by the role's systemd unit → PASS; every container on a release or digest-pinned image, no dev-settings; the
#      range-list timer and its recorded result; certificate validity metrics in Prometheus; TLS key directories split
#      per consumer; Alertmanager with the deployment's receivers; no secret value in any container log
#   6. run 3: idempotency (reports the number of changed tasks)
#
# Substitutes (the only ones): certificates from the private CA instead of ACME, two local pgBackRest repositories
# instead of Azure Blob (scf_backup_repo_type=posix), images loaded instead of pulled. Docker objects: scf-az-*
# (no host ports). KEEP=1 leaves the VM running.
#
#   infra/ansible/tests/lean/run.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)" # infra/ansible
REPO="$(cd "$HERE/../.." && pwd)"
TOOL=usagemap/ansible-tools:2.22.0 VMIMG=usagemap/az-testvm:trixie VM=scf-az-vm
NET1=scf-az-front NET2=scf-az-front2 WORK=scf-az-work SRV=scf-az-srv
INGEST_IP=172.31.250.10 PORTAL_IP=172.31.251.11
AGE_TEST=age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq # test recipient, no identity exists
PASS=0 FAIL=0
LOG=$(mktemp "${TMPDIR:-/tmp}/scf-lean-test.XXXXXX")
say() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG"; }
ok() { PASS=$((PASS + 1)); say "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); say "FAIL $1${2:+: $2}"; }
check() { local name=$1; shift; if "$@" >>"$LOG" 2>&1; then ok "$name"; else bad "$name"; fi; }
cleanup() {
  [ "${KEEP:-0}" = 1 ] && { say "KEEP=1: $VM left running"; return; }
  docker rm -f "$VM" >/dev/null 2>&1
  docker network rm "$NET1" "$NET2" >/dev/null 2>&1
  docker volume rm -f "$WORK" "$SRV" >/dev/null 2>&1
  true
}
trap cleanup EXIT
KEEP=0 cleanup; KEEP=${KEEP:-0}
tool() {
  docker run --rm --network "$NET1" -v "$WORK:/tmp/scf-lean-test" -v "$REPO:/repo:ro" -e HOME=/tmp \
    -e ANSIBLE_CONFIG=/repo/infra/ansible/ansible.cfg -e ANSIBLE_VARS_ENABLED=host_group_vars \
    -e ANSIBLE_LOCAL_TEMP=/tmp/.ansible-tmp -e ANSIBLE_FORCE_COLOR=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo \
    -w /repo/infra/ansible "$TOOL" "$@"
}
vm() { docker exec "$VM" "$@"; }
client() { # client NET CMD… — a throwaway client on a front network with the test CA
  local net=$1; shift
  docker run --rm --network "$net" -v "$WORK:/w:ro" --entrypoint "$1" "$VMIMG" "${@:2}"
}
play() { tool ansible-playbook -i tests/lean/inventory.yml -e @group_vars/all.yml -e @tests/lean/vars.yml \
  -e @/tmp/scf-lean-test/secrets.yml "$@" playbooks/lean.yml; }

say "== build the tool image and the test VM"
docker build -q -t "$TOOL" -f "$HERE/tools/Dockerfile" "$HERE" >/dev/null || { bad "tool image"; exit 1; }
docker network create --subnet 172.31.250.0/24 "$NET1" >/dev/null
docker network create --subnet 172.31.251.0/24 "$NET2" >/dev/null
docker volume create "$WORK" >/dev/null && docker volume create "$SRV" >/dev/null
docker run --rm -v "$WORK:/w" --entrypoint chown "$TOOL" 1000:1000 /w 2>/dev/null ||
  docker run --rm --user 0 -v "$WORK:/w" --entrypoint chown "$TOOL" 1000:1000 /w
tool sh -c 'umask 077; rm -f /tmp/scf-lean-test/id_ed25519* /tmp/scf-lean-test/secrets.yml; ssh-keygen -q -t ed25519 -N "" -C scf-lean-test -f /tmp/scf-lean-test/id_ed25519 &&
  /repo/infra/ansible/scripts/gen-stack-secrets.sh --age-recipient '"$AGE_TEST"' -o /tmp/scf-lean-test/secrets.yml' ||
  { bad "test key and secrets"; exit 1; }
tool python3 -I /repo/infra/ansible/tests/lean/prepare.py >>"$LOG" 2>&1 ||
  { bad "test alert channels and tracker release directories (tests/lean/prepare.py)"; exit 1; }
PUB=$(tool cat /tmp/scf-lean-test/id_ed25519.pub)
docker build -q -t "$VMIMG" --build-arg TEST_PUBKEY="$PUB" -f "$HERE/tests/lean/Dockerfile.vm" "$HERE/tests/lean" >/dev/null ||
  { bad "VM image"; exit 1; }
docker run -d --name "$VM" --hostname app-1 --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  -v "$SRV:/srv/scf" --network "$NET1" --ip "$INGEST_IP" "$VMIMG" >/dev/null
docker network connect --ip "$PORTAL_IP" "$NET2" "$VM"
for _ in $(seq 60); do vm systemctl is-active -q ssh 2>/dev/null && break; sleep 1; done

say "== 1. syntax-check and ansible-lint"
check "syntax-check playbooks/lean.yml" tool ansible-playbook -i tests/lean/inventory.yml playbooks/lean.yml --syntax-check
check "ansible-lint (production profile): lean playbook and roles" tool ansible-lint playbooks/lean.yml roles/compose_stack roles/docker_engine roles/common roles/restore_drill roles/pki

say "== 2. run 1: baseline, Docker, PKI, secrets, configuration (stack not started)"
t0=$(date +%s)
if play -e '{"scf_stack_up": false}' >>"$LOG" 2>&1; then ok "run 1 ($(($(date +%s) - t0)) s)"; else bad "run 1"; tail -n 40 "$LOG"; exit 1; fi

say "== 2b. negative runs: the role refuses a deploy without alert channels, or with a tampered tracker release"
out=$(play -e '{"scf_stack_up": false, "scf_alert_receivers_required": ["maintainers-critical", "maintainers-warning", "security-responders", "portal-notices"]}' 2>&1)
echo "$out" >>"$LOG"
check "no deploy while a required receiver has no channel (portal-notices required here, none given)" \
  bash -c 'grep -q "Alertmanager would drop alerts" <<<"$1" && grep -q "failed=1" <<<"$1"' _ "$out"
out=$(play -e '{"scf_stack_up": false, "scf_tracker_releases": ["/tmp/scf-lean-test/tracker-tampered/1.0.0", "/tmp/scf-lean-test/tracker-tampered/1.1.0", "/tmp/scf-lean-test/tracker-tampered/1.2.0"]}' 2>&1)
echo "$out" >>"$LOG"
check "no deploy with a tracker release whose files do not match its SHA256SUMS" \
  bash -c 'grep -q "Tracker release directories are complete" <<<"$1" && grep -q "FAILED" <<<"$1" && grep -q "failed=1" <<<"$1"' _ "$out"

say "== 3. load the release images into the VM's Docker (under the test release names of vars.yml)"
n=0
while read -r dst src; do
  docker tag "$src" "$dst" && docker save "$dst" | docker exec -i "$VM" docker load -q >>"$LOG" 2>&1 || bad "load $src as $dst"
  docker rmi "$dst" >/dev/null 2>&1; n=$((n + 1))
done <<'IMAGES'
scf-lean.test/postgres-ha:release usagemap/postgres-ha:18.7-pgbr2.60.0-patroni4.1.5
scf-lean.test/db-migrate:release usagemap/db-migrate:dev
scf-lean.test/umami:release usagemap/umami:3.5.0-d3c62a8
scf-lean.test/umami-migrate:release usagemap/umami-migrate:3.5.0-d3c62a8
scf-lean.test/engine-proxy:release usagemap/engine-proxy:dev
scf-lean.test/control-plane:release usagemap/control-plane:dev
scf-lean.test/portal:release usagemap/portal:dev
scf-lean.test/jobs:release usagemap/jobs:dev
scf-lean.test/metrics-writer:release usagemap/metrics-writer:dev
scf-lean.test/gateway:release usagemap/gateway:dev
scf-lean.test/otelcol:release usagemap/otelcol:dev
scf-lean.test/ops:release usagemap/ops:dev
scf-lean.test/mcp:release usagemap/mcp:dev
IMAGES
ok "images loaded ($n)"

say "== 4. run 2: the stack comes up"
t0=$(date +%s)
if play >>"$LOG" 2>&1; then ok "run 2: stack up and healthy ($(($(date +%s) - t0)) s)"; else bad "run 2"; tail -n 60 "$LOG"; fi

say "== 5. checks"
DC=(docker compose -p scf --project-directory /opt/scf/current/infra/compose -f /opt/scf/current/infra/compose/compose.yaml
    -f /opt/scf/current/infra/compose/compose.monitoring.yaml -f /etc/scf/stack/compose.prod.yaml)
ps=$(vm "${DC[@]}" ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.ExitCode}}' 2>>"$LOG")
echo "$ps" >>"$LOG"
check "every long-running service running, healthy where it has a check" bash -c '[ -n "$1" ] && ! tr -s " " <<<"$1" | grep -Ev "^\S+ (running (healthy )?0|exited 0)$" | grep .' _ "$ps"
check "one-shots completed (db-migrate, umami-views-drop, umami-migrate, umami-views, umami-bootstrap)" bash -c 'for s in db-migrate umami-views-drop umami-migrate umami-views umami-bootstrap; do tr -s " " <<<"$1" | grep -Eq "^$s exited 0$" || exit 1; done' _ "$ps"
check "every container runs a release image of the test (scf-lean.test/…) or a digest-pinned third-party image" \
  bash -c "docker exec $VM sh -c 'docker inspect -f \"{{.Config.Image}}\" \$(docker ps -aq --filter label=com.docker.compose.project=scf)' | sort -u | grep -Ev '^scf-lean\\.test/[a-z-]+:release$|@sha256:[0-9a-f]{64}$' | (! grep .)"
check "no development setting in production (no dev-settings one-shot; edge_counter_features is the operator's)" \
  bash -c '! grep -Eq "^dev-settings " <<<"$1"' _ "$ps"
check "scale-out services not started (health controller, etcd, fake DNS)" bash -c '! grep -Eq "^(hc-mon-c|hc-core-b|etcd|dns-a|dns-b) " <<<"$1"' _ "$ps"
# compose.dev.yaml (development and test fixtures) is never part of a deployment: no synthetic ledger fixture, and the
# jobs service's ledger mirror is the writable volume its fetch step fills (SCF_ONCHAIN_LEDGER_SOURCE_URL).
jobs_ledger_rw() { vm sh -c 'docker inspect -f "{{range .Mounts}}{{if eq .Destination \"/srv/ledgers\"}}{{.RW}}{{end}}{{end}}" $(docker ps -q -f label=com.docker.compose.project=scf -f label=com.docker.compose.service=jobs)'; }
check "no dev/test fixture in production (no onchain-fixture; jobs' ledger mirror /srv/ledgers writable)" \
  bash -c '! grep -Eq "^onchain-fixture " <<<"$1" && ! docker exec "$3" docker image inspect usagemap/onchain-lakegen:dev >/dev/null 2>&1 && [ "$2" = true ]' _ "$ps" "$(jobs_ledger_rw)" "$VM"
jobs_net() { vm sh -c 'docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" $(docker ps -q -f label=com.docker.compose.project=scf -f label=com.docker.compose.service=jobs)' | grep -E '^SCF_STELLAR_NETWORK=' ; }
check "jobs uses the control plane's Stellar network (public), pubnet fetch off in the test" \
  bash -c '[ "$1" = "SCF_STELLAR_NETWORK=public" ]' _ "$(jobs_net)"
CA=/w/pki/ca.pem
check "ingest: TLS with the ingest certificate for both names; tracker file 200" \
  client "$NET1" sh -c "for h in ingest-a.lean.test ingest-b.lean.test; do curl -fsS --cacert $CA --resolve \$h:443:$INGEST_IP -o /dev/null https://\$h/lib/1.0.0/standard.js || exit 1; done"
check "ingest: OTLP without an ingest token → 401" \
  client "$NET1" sh -c "test \"\$(curl -sS --cacert $CA --resolve ingest-a.lean.test:443:$INGEST_IP -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/x-protobuf' --data-binary x https://ingest-a.lean.test/v1/traces)\" = 401"
check "portal: SPA with CSP and HSTS over TLS" \
  client "$NET2" sh -c "curl -fsS -D- -o /dev/null --cacert $CA --resolve app.lean.test:443:$PORTAL_IP https://app.lean.test/ | grep -qi '^content-security-policy:' && curl -fsS -D- -o /dev/null --cacert $CA --resolve app.lean.test:443:$PORTAL_IP https://app.lean.test/ | grep -qi '^strict-transport-security:'"
check "portal: API on the same origin (public health JSON from the control plane)" \
  client "$NET2" sh -c "curl -sS --cacert $CA --resolve app.lean.test:443:$PORTAL_IP https://app.lean.test/public/v1/health | grep -q '\"status\"'"
check "portal: snapshot keys published (kid snap-1)" \
  client "$NET2" sh -c "curl -fsS --cacert $CA --resolve app.lean.test:443:$PORTAL_IP https://app.lean.test/.well-known/scf-snapshot-keys.json | grep -q snap-1"
# /.well-known/ is never the SPA shell (review 2026-11-20): no landing host here, so stellar.toml is a 404 like any
# other unserved /.well-known/ path (with scf_landing_hostname it is a 308 to the landing host's file).
check "portal: /.well-known/stellar.toml and other unserved /.well-known/ paths → 404, never the SPA shell" \
  client "$NET2" sh -c "for p in stellar.toml security.txt x; do test \"\$(curl -sS --cacert $CA --resolve app.lean.test:443:$PORTAL_IP -o /dev/null -w '%{http_code}' https://app.lean.test/.well-known/\$p)\" = 404 || exit 1; done"
check "portal: /mcp reaches the hosted MCP server (GET → 405 Allow: POST, not the SPA)" \
  client "$NET2" sh -c "curl -sS -D- -o /dev/null --cacert $CA --resolve app.lean.test:443:$PORTAL_IP https://app.lean.test/mcp | grep -Eqi '^allow: POST'"
check "status host served by the portal's Caddy" \
  client "$NET2" sh -c "curl -fsS -o /dev/null --cacert $CA --resolve status.lean.test:443:$PORTAL_IP https://status.lean.test/healthz"
check "nothing but 443 answers on the front addresses (5432 6432 8080 8081 8443 9090 9093 3000 9100 2379 22-from-front2)" \
  client "$NET2" sh -c "for ip in $INGEST_IP $PORTAL_IP; do for p in 5432 6432 8080 8081 8443 9090 9093 3000 9100 9464 2379 5140; do curl -s -m 3 -o /dev/null telnet://\$ip:\$p </dev/null && { echo open \$ip:\$p; exit 1; }; done; done; exit 0"
check "control plane publishes no host port; only the two front addresses on 443 + loopback monitoring ports" \
  bash -c "docker exec $VM ss -Hltn | awk '{print \$4}' | grep -Ev '^(127\\.0\\.0\\.(1|11|53)|\\[::1\\]|172\\.31\\.25[01]\\.1[01]:443$|0\\.0\\.0\\.0:22$|\\[::\\]:22$|\\*:22$)' | grep -Ev '^127\\.|:22$' | (! grep .)"
check "host firewall loaded at boot (nftables.service enabled and active; live reboot drill 2026-11-19)" \
  bash -c "docker exec $VM systemctl is-enabled -q nftables && docker exec $VM systemctl is-active -q nftables"
check "host firewall: IMDS only from the backup bridge, public bridge only 80/443" \
  bash -c "docker exec $VM nft list table inet scf | tr -s ' ' | grep -q 'iifname \"scf-backup0\" ip daddr 169.254.169.254 tcp dport 80 accept' && docker exec $VM nft list table inet scf | grep -q 'ip daddr 169.254.169.254 counter.*drop' && docker exec $VM nft list table inet scf | grep -q 'iifname \"scf-public0\" tcp dport { 80, 443 } accept'"
check "Docker daemon: userland-proxy off, data root on the data disk, log rotation; engine packages held" \
  bash -c "docker exec $VM docker info --format '{{.DockerRootDir}} {{.LoggingDriver}}' | grep -qx '/srv/scf/docker local' && docker exec $VM grep -q '\"userland-proxy\": false' /etc/docker/daemon.json && docker exec $VM apt-mark showhold | grep -qx docker-ce && docker exec $VM dpkg-query -W -f '\${Version}' docker-ce | grep -qx '5:29.9.3-1~debian.13~trixie'"
check "unattended security upgrades configured, journald capped" \
  bash -c "docker exec $VM grep -q 'Debian-Security' /etc/apt/apt.conf.d/52scf-unattended-upgrades && docker exec $VM grep -q SystemMaxUse /etc/systemd/journald.conf.d/10-scf.conf"
check "secrets: directory 0700 root; one-consumer files 0400 with their uid; dev scripts' output not used" \
  bash -c "docker exec $VM stat -c '%a %U' /etc/scf/stack/secrets | grep -qx '700 root' && docker exec $VM stat -c '%a %u' /etc/scf/stack/secrets/sep10_signing_seed | grep -qx '400 1000' && docker exec $VM stat -c '%a %u' /etc/scf/stack/secrets/pgbouncer_userlist | grep -qx '400 70' && ! docker exec $VM test -e /opt/scf/current/infra/compose/.secrets"
say "waiting for the first full backups (scheduler tick 10 s)"
for _ in $(seq 60); do
  vm cat /srv/scf/metrics/scf_backup.prom 2>/dev/null | grep -Eq '^scf_backup_last_success_timestamp_seconds\{repo="2",type="full"\} [1-9]' && break; sleep 5
done
check "PostgreSQL single mode (no Patroni): full backups in both repositories, WAL archived (pgbackrest check)" \
  bash -c "docker exec $VM ${DC[*]} exec -T postgres scf-backup pgbackrest info --output=json | python3 -I -c 'import json,sys; d=json.load(sys.stdin)[0]; r={b[\"database\"][\"repo-key\"] for b in d[\"backup\"] if b[\"type\"]==\"full\"}; sys.exit(0 if d[\"status\"][\"code\"]==0 and r=={1,2} else 1)' && docker exec $VM ${DC[*]} exec -T postgres scf-backup check"
check "backup metrics reach Prometheus through the node exporter" \
  bash -c "for _ in \$(seq 30); do docker exec $VM ${DC[*]} exec -T prometheus wget -qO- 'http://127.0.0.1:9090/api/v1/query?query=scf_backup_last_success_timestamp_seconds%7Btype%3D%22full%22%7D' | grep -q '\"repo\":\"2\"' && exit 0; sleep 5; done; exit 1"
# prom_has QUERY PATTERN — PATTERN appears in Prometheus's answer to QUERY (URL-encoded) within 150 s
promq() { docker exec "$VM" "${DC[@]}" exec -T prometheus wget -qO- "http://127.0.0.1:9090/api/v1/query?query=$1"; }
prom_has() { for _ in $(seq 30); do promq "$1" | grep -q "$2" && return 0; sleep 5; done; return 1; }
pg_exporter_ok() { prom_has pg_up '"1"\]' && prom_has pg_settings_max_connections '"value"' && prom_has pg_stat_activity_count '"value"'; }
check "Prometheus scrapes the control plane (job control-plane up, scf_cp_* series)" \
  prom_has 'up%7Bjob%3D%22control-plane%22%7D' '"1"\]'
check "PostgreSQL exporter: pg_up = 1, connections and max_connections exported (ConnectionsNearMax has input)" \
  pg_exporter_ok
check "restore-drill timer installed" vm systemctl is-enabled -q scf-restore-drill.timer
check "range lists: weekly timer installed; the first run's result recorded (unreachable test source → success 0)" \
  bash -c "docker exec $VM systemctl is-enabled -q scf-rangelists.timer && docker exec $VM grep -qx 'scf_rangelist_last_run_success 0' /srv/scf/metrics/scf_rangelists.prom && ! docker exec $VM grep -q '^scf_rangelist_last_success_timestamp_seconds' /srv/scf/metrics/scf_rangelists.prom"
check "range lists: the updater is not a long-running service here (timer only) and the gateway mounts the list volume read-only" \
  bash -c '! grep -Eq "^rangelist-updater " <<<"$1" && docker exec "$2" sh -c "docker inspect -f \"{{range .Mounts}}{{if eq .Destination \\\"/var/lib/scf-rangelists\\\"}}{{.RW}}{{end}}{{end}}\" \$(docker ps -q -f label=com.docker.compose.project=scf -f label=com.docker.compose.service=gateway)" | grep -qx false' _ "$ps" "$VM"
check "certificate metrics: every public and mesh certificate's notAfter in the textfile, and in Prometheus" \
  bash -c "docker exec $VM grep -q 'scf_tls_cert_not_after_timestamp_seconds{kind=\"ca\",name=\"ca\"}' /srv/scf/metrics/scf_tls.prom && docker exec $VM grep -q 'kind=\"acme\",name=\"ingest\"' /srv/scf/metrics/scf_tls.prom && docker exec $VM grep -q 'kind=\"mesh\",name=\"edge-a1\"' /srv/scf/metrics/scf_tls.prom" 
check "certificate metrics reach Prometheus" prom_has 'scf_tls_cert_not_after_timestamp_seconds%7Bkind%3D%22ca%22%7D' '"ca"'
check "TLS keys split: the gateway mounts only tls/ingest, the portal only tls/portal" \
  bash -c 'for s in gateway:ingest portal:portal; do docker exec "$1" sh -c "docker inspect -f \"{{range .Mounts}}{{.Source}} {{end}}\" \$(docker ps -q -f label=com.docker.compose.project=scf -f label=com.docker.compose.service=${s%%:*})" | grep -q "/etc/scf/stack/tls/${s#*:} " || exit 1; done; ! docker exec "$1" sh -c "docker inspect -f \"{{range .Mounts}}{{.Source}} {{end}}\" \$(docker ps -q -f label=com.docker.compose.project=scf -f label=com.docker.compose.service=gateway)" | grep -q "tls/portal"' _ "$VM"
check "Alertmanager: the deployment's receivers (webhook files), config valid, on the egress bridge" \
  bash -c "docker exec $VM grep -q 'url_file: /run/secrets/am_webhook_maintainers-critical' /etc/scf/stack/alertmanager.yml && docker exec $VM ${DC[*]} exec -T alertmanager /bin/amtool check-config /etc/alertmanager/alertmanager.yml && docker exec $VM stat -c '%a %u' /etc/scf/stack/secrets/am_webhook_security-responders | grep -qx '400 65534'"
t0=$(date +%s)
check "restore drill (role's systemd unit) → PASS from repository 2" \
  bash -c "docker exec $VM systemctl start scf-restore-drill.service && docker exec $VM journalctl -u scf-restore-drill.service --no-pager | grep -q 'RESTORE-DRILL PASS'"
say "drill took $(($(date +%s) - t0)) s: $(vm journalctl -u scf-restore-drill.service --no-pager 2>/dev/null | grep -o 'RESTORE-DRILL [A-Z]*.*' | tail -n1)"
check "no secret value in any container log" bash -c '
  vals=$(docker run --rm -v '"$WORK"':/w:ro --entrypoint python3 '"$TOOL"' -I -c "
import re; s=open(\"/w/secrets.yml\").read()
print(\"\\n\".join(v for v in re.findall(r\"^  [a-z_0-9]+: \\\"?([0-9a-f]{32,}|S[A-Z2-7]{55}|1:[A-Za-z0-9+/=]{40,})\\\"?$\", s, re.M)))")
  logs=$(docker exec '"$VM"' sh -c "for c in \$(docker ps -aq); do docker logs \$c 2>&1; done")
  [ -n "$vals" ] || exit 1
  while read -r v; do grep -qF -- "$v" <<<"$logs" && { echo "leak"; exit 1; }; done <<<"$vals"; exit 0'

say "== 6. run 3: idempotency"
out=$(play 2>&1); echo "$out" >>"$LOG"
changed=$(printf '%s\n' "$out" | sed -n 's/^app-1 .* changed=\([0-9][0-9]*\) .*/\1/p' | tail -n1)
if grep -q 'failed=0' <<<"$out" && [ "${changed:-99}" -le 2 ]; then ok "run 3: no failure, changed=$changed"; else bad "run 3" "changed=${changed:-?}"; fi

say "Result: $PASS passed, $FAIL failed (log: $LOG)"
[ "$FAIL" = 0 ]
