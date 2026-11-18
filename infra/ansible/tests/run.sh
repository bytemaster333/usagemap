#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Tests of infra/ansible in the pinned tool container (ansible-core 2.22.0, ansible-lint 26.11.0):
#   1. ansible-playbook --syntax-check playbooks/site.yml
#   2. ansible-lint (production profile) on roles and playbooks
#   3. tests/test.yml: PKI issuance/idempotency/renewal, the umami role+database task against a real PostgreSQL 18.6
#      (second run unchanged), rendered PgBouncer / nftables / Squid / drill configuration
# Docker network and containers named scf-wsj2-ansible*; removed at the end.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)" # infra/ansible
REPO="$(cd "$HERE/../.." && pwd)"
NET=scf-wsj2-ansible PG=scf-wsj2-ansible-pg IMG=usagemap/ansible-tools:2.22.0
PGPW=$(openssl rand -hex 16)
cleanup() { docker rm -f "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker build -q -t "$IMG" -f "$HERE/tools/Dockerfile" "$HERE" >/dev/null
docker network create --internal "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" --network-alias pgtest -e POSTGRES_PASSWORD="$PGPW" \
  -e POSTGRES_INITDB_ARGS="--auth-host=scram-sha-256" \
  postgres:18.7-alpine@sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015 >/dev/null
# Over TCP: the image's initdb phase runs a temporary server on the socket only, which a socket check would accept
# just before that server stops and the real one starts (intermittent "Role and database" failures, 2026-11-19).
for _ in $(seq 60); do docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres && break; sleep 1; done
run() { docker run --rm --network "$NET" -e PGTEST_PASSWORD="$PGPW" -e ANSIBLE_CONFIG=/repo/infra/ansible/ansible.cfg \
  -e ANSIBLE_VARS_ENABLED=host_group_vars -e ANSIBLE_LOCAL_TEMP=/tmp/.ansible-tmp -e HOME=/tmp \
  -v "$REPO:/repo:ro" -w /repo/infra/ansible "$IMG" "$@"; }
fail=0
echo "== syntax-check"
run ansible-playbook -i tests/inventory.yml playbooks/site.yml --syntax-check || fail=1
echo "== ansible-lint"
run ansible-lint roles playbooks tests || fail=1
echo "== role tests"
run ansible-playbook -i tests/inventory.yml -e @tests/group_vars_test.yml -e @group_vars/all.yml tests/test.yml || fail=1
[ $fail = 0 ] && echo "Result: PASS — syntax-check, ansible-lint, role tests" || echo "Result: FAIL"
exit $fail
