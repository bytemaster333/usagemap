#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Handover data-migration drill, local (core plan C1 item 2; handover.independent-operator, handover.data-migration, handover.ready; docs/handover-plan.md §4.2–§4.3;
# runbook ops/runbooks/handover-migration.md). Two independent operators, each from its own clone of the committed
# branch with its own secrets; at most one stack runs at a time:
#
#   1. OLD operator (project scf-hoa): the HA stack of infra/compose (Patroni, pgBackRest to two blob stores, weekly
#      age-encrypted logical dump), seeded with the 20 DEMO projects (tools/demo-seed; scf and Umami data); public
#      API answers recorded; writes frozen (handover plan §4.2 step 1); fingerprint F0 of scf + umami
#      (fingerprint.sh); `scf-backup dump` and a full pgBackRest backup to repository 2; the dump downloaded and its
#      SHA-256 recorded out of band.
#   2. Path (b): repository 2 restored by the new operator's scratch host (read+list SAS, pitr-restore.sh) → F_b.
#      The old stack is then removed except its blob store's data, which goes with it (`down -v`).
#   3. Tamper cases on throwaway servers (import.sh --scratch): a flipped byte, a consistent forgery with its own
#      SHA256SUMS, a careless forgery with a stale manifest, the consistent forgery with a compromised out-of-band hash
#      (only the fingerprint diff catches it), and the import without --create (what `scf-backup dump-restore` lost before it used --create, 2026-11-18).
#   4. NEW operator (project scf-hob): its own secrets plus the items carried over under C-50 (peppers, snapshot and
#      traction-snapshot signing keys, Umami credential key, Umami APP_SECRET and provisioning password); PostgreSQL
#      only; path (a): import.sh --into-fresh; fingerprint F_a; then the whole stack up with the new secrets, and the
#      public API answers compared with step 1.
#   Pass: F_a = F0, F_b = F0, every tamper case refused or detected, the new stack healthy, API answers equal.
#
#   tests/handover/run.sh                      # OUT=<dir> for the evidence files (default: a new temp dir)
#   DRILL_REF=main KEEP=1 tests/handover/run.sh   # DRILL_REF: commit-ish to clone (default: HEAD of this checkout); KEEP=1: leave the last stack (scf-hob) running
#
# Docker: projects scf-hoa, scf-hob (host ports 56720–56725 on 127.0.0.1), throwaway containers; images are used as
# built (`--no-build`; build them first with `make up` or the suites if missing). Needs: docker, git, node, jq.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HO="$REPO/tests/handover"
# The commit under test: a ref of this checkout (default HEAD), resolved once. Not BRANCH: a detached checkout has
# no branch to clone.
DRILL_SHA=$(git -C "$REPO" rev-parse --verify "${DRILL_REF:-HEAD}^{commit}")
# HANDOVER_PROJECT_A/B: other project names, so a run can go on beside another (an agent) on this host
PA=${HANDOVER_PROJECT_A:-scf-hoa} PB=${HANDOVER_PROJECT_B:-scf-hob}
OUT=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/scf-handover.XXXXXX")}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/scf-handover-work.XXXXXX")
PGHA=usagemap/postgres-ha:18.7-pgbr2.60.0-patroni4.1.5
mkdir -p "$OUT" "$WORK/transfer" "$WORK/oob" "$WORK/forged"
chmod 0755 "$WORK" "$WORK/oob"
chmod 0777 "$WORK/transfer" "$WORK/forged" # written by the containers' postgres user (uid 999)
SUMMARY="$OUT/steps.tsv"
printf 'step\tresult\tseconds\tdetail\n' >"$SUMMARY"
PASS=0 FAIL=0
say() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$OUT/drill.log"; }
step() { # step NAME RESULT SECONDS DETAIL
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(tr '\n\t' '  ' <<<"$4" | cut -c1-400)" >>"$SUMMARY"
  if [ "$2" = ok ]; then PASS=$((PASS + 1)); say "ok    $1 (${3}s) $4"; else FAIL=$((FAIL + 1)); say "FAIL  $1 (${3}s) $4"; fi
}
timed() { local t0=$SECONDS; "$@"; local rc=$?; LAST_S=$((SECONDS - t0)); return $rc; }
# up_failed DC LOG: after a failed `up --wait`, the state of every container and the last log lines of each one that
# is not running-and-healthy or exited 0, into LOG and on stdout.
up_failed() {
  local dc=$1 log=$2 c line
  "$dc" ps -a >>"$log" 2>&1
  for c in $("$dc" ps -aq 2>/dev/null); do
    line=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)
    case "$line" in *" running 0 healthy" | *" exited 0 " | *" running 0 ") continue ;; esac
    { echo "---- $line"; docker logs --tail 40 "$c" 2>&1; } | tee -a "$log"
  done
}

A="$WORK/a" B="$WORK/b"
FA=(-f "$A/infra/compose/compose.yaml" -f "$A/infra/compose/compose.dev.yaml" -f "$A/infra/compose/compose.ha.yaml")
FB=(-f "$B/infra/compose/compose.yaml" -f "$B/infra/compose/compose.dev.yaml")
dca() { SCF_CONTROL_PLANE_PORT=56720 SCF_PORTAL_PORT=56721 SCF_INGEST_PORT=56722 docker compose -p "$PA" "${FA[@]}" "$@"; }
dcb() { SCF_CONTROL_PLANE_PORT=56723 SCF_PORTAL_PORT=56724 SCF_INGEST_PORT=56725 docker compose -p "$PB" "${FB[@]}" "$@"; }
# root helper for files the dev PKI handed to container uids (copy, remove)
asroot() { docker run --rm --network none -v "$WORK:$WORK" alpine:3.22 sh -c "$1"; }

cleanup() {
  [ -d "$A" ] && dca --profile drill --profile migration down -v --remove-orphans >/dev/null 2>&1
  if [ "${KEEP:-0}" = 1 ]; then say "KEEP=1: $PB left running (dcb down -v to remove; work dir $WORK)"; return; fi
  [ -d "$B" ] && dcb down -v --remove-orphans >/dev/null 2>&1
  asroot "rm -rf '$WORK'/a '$WORK'/b '$WORK'/transfer '$WORK'/forged" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

clone() { # clone DIR → a clone of the committed branch, prepared like a fresh checkout plus the built tracker
  git clone -q --no-checkout "$REPO" "$1" && git -C "$1" checkout -q --detach "$DRILL_SHA" || return 1
  [ -d "$REPO/tracker/dist" ] && cp -a "$REPO/tracker/dist" "$1/tracker/dist"
  # tracker/dist is public and bind-mounted read-only into containers that run as other uids: a checkout built under a
  # restrictive umask (0700 directories) made the control plane fail with "tracker release 1.0.0 has no manifest" at
  # a-up (heavy/ha, 2026-11-19 12:07 and 14:13). init.sh builds with umask 022; this covers a copied build.
  [ -d "$1/tracker/dist" ] && chmod -R a+rX "$1/tracker/dist"
  return 0
}

# ============================================================ 1. old operator
say "== 1. old operator: $PA (HA overlay) from a clone of ${DRILL_SHA:0:12}"
clone "$A" || { step clone-a FAIL 0 "git clone"; exit 1; }
COMMIT=$(git -C "$A" rev-parse HEAD)
say "commit $COMMIT"
timed "$A/infra/compose/ha/scripts/ha-init.sh" >"$OUT/a-init.log" 2>&1 && step a-secrets ok "$LAST_S" "ha-init.sh (base + HA dev secrets of the old operator)" || { step a-secrets FAIL "$LAST_S" "$(tail -n2 "$OUT/a-init.log")"; exit 1; }
if timed dca up -d --no-build --wait --wait-timeout 900 >"$OUT/a-up.log" 2>&1; then step a-up ok "$LAST_S" "HA stack healthy"
else step a-up FAIL "$LAST_S" "$(grep -iE 'error|unhealthy' "$OUT/a-up.log" | tail -n2)"; up_failed dca "$OUT/a-up.log"; exit 1; fi
PGPW_A=$(cat "$A/infra/compose/.secrets/pg_superuser_password")
primary() { local s; for s in pg-a pg-b; do [ "$(dca exec -T -e PGPASSWORD="$PGPW_A" "$s" psql -X -At -h /var/run/postgresql -U postgres -d postgres -c 'select not pg_is_in_recovery()' 2>/dev/null)" = t ] && { echo "$s"; return; }; done; }
for _ in $(seq 60); do P=$(primary); [ -n "$P" ] && break; sleep 2; done
[ -n "${P:-}" ] || { step a-primary FAIL 0 "no primary"; exit 1; }
say "primary: $P"
# Seed: the 20 DEMO projects through the real API and the database (both scf and umami get rows).
if (cd "$A" && timed node tools/demo-seed/seed.ts --project "$PA" --portal http://localhost:56721 --pg-container "$(dca ps -q "$P")") >"$OUT/a-seed.log" 2>&1; then
  step a-seed ok "$LAST_S" "tools/demo-seed: 20 DEMO projects"
else step a-seed FAIL "$LAST_S" "$(tail -n3 "$OUT/a-seed.log")"; exit 1; fi
# Public answers to compare after the migration (handover plan §4.3 "dashboard parity", public part).
api_capture() { # api_capture PORT FILE → status and normalised body hash per path; bodies (synthetic DEMO data) in FILE.d/
  local port=$1 slug path f
  : >"$2"; mkdir -p "$2.d"
  for slug in demo-alder-remit demo-kestrel-swap; do
    for path in "/public/v1/projects/$slug/metrics.json" "/public/v1/projects/$slug/snapshots"; do
      f="$2.d/$(tr '/' '_' <<<"$path").json"
      code=$(curl -s -o "$f.raw" -w '%{http_code}' "http://127.0.0.1:$port$path")
      # the origin differs by design (each stack has its own port): normalised, like the time fields
      sed -E 's#//(localhost|127\.0\.0\.1):[0-9]+#//ORIGIN#g' "$f.raw" | jq -S 'del(.. | .generated_at?, .checked_at?, .served_at?, .request_id?)' >"$f" 2>/dev/null || cp "$f.raw" "$f"
      rm -f "$f.raw"
      printf '%s\t%s\t%s\n' "$path" "$code" "$(md5sum <"$f" | cut -c1-32)" >>"$2"
    done
  done
}
# Let the jobs service finish what the seed asked for (rollups, signed snapshots).
sleep 30
# Freeze (handover plan §4.2 step 1), in two steps: the writers first (jobs, writer, gateway, Collector), so the read
# path still answers and its answers are final; then the read path and the engine. PostgreSQL, PgBouncer and the blob
# stores stay up.
timed dca stop gateway collector metrics-writer jobs >/dev/null 2>&1
api_capture 56721 "$OUT/api-before.tsv"
dca stop control-plane portal engine-proxy umami >/dev/null 2>&1
step a-freeze ok "$LAST_S" "writers stopped, public answers recorded, read path stopped"
fp() { # fp SERVICE → fingerprint of scf + umami on that service's server (socket)
  dca exec -T -e PGPASSWORD="$PGPW_A" -e PGHOST=/var/run/postgresql -e PGUSER=postgres "$1" bash -s -- scf umami <"$HO/fingerprint.sh"
}
timed fp "$P" >"$OUT/F0.tsv" 2>"$OUT/F0.err"
FP_LAST=$LAST_S
dca exec -T -e FP_RAW=1 -e PGPASSWORD="$PGPW_A" -e PGHOST=/var/run/postgresql -e PGUSER=postgres "$P" bash -s -- scf umami <"$HO/fingerprint.sh" >"$OUT/F0.raw.tsv" 2>/dev/null
LAST_S=$FP_LAST
[ -s "$OUT/F0.tsv" ] && step a-fingerprint ok "$LAST_S" "F0: $(grep -c $'\ttable\t' "$OUT/F0.tsv") tables, $(awk -F'\t' '$2=="table"{split($4,a," "); n+=a[1]} END{print n}' "$OUT/F0.tsv") rows" || { step a-fingerprint FAIL "$LAST_S" "$(tail -n2 "$OUT/F0.err")"; exit 1; }
# Weekly logical dump, now (scf-backup dump: pg_dumpall globals + pg_dump per db + manifest, age, SHA256SUMS last).
if timed dca exec -T "$P" scf-backup dump >"$OUT/a-dump.log" 2>&1; then step a-dump ok "$LAST_S" "$(grep -o 'dump [^:]*: uploaded.*' "$OUT/a-dump.log" | tail -n1)"
else step a-dump FAIL "$LAST_S" "$(tail -n2 "$OUT/a-dump.log")"; exit 1; fi
NAME=$(dca exec -T "$P" scf-backup dump-list 2>/dev/null | tail -n1 | tr -d '\r')
SAS2=$(cat "$A/infra/compose/.secrets/ha/pgbackrest_repo2_key")
for f in dump.tar.age SHA256SUMS; do
  dca exec -T "$P" sh -c "scf-azblob get \"\$SCF_DUMP_BASEURL\" \"\$SCF_DUMP_CONTAINER\" '$SAS2' dumps/$NAME/$f /tmp/ho-$f >/dev/null && cat /tmp/ho-$f && rm -f /tmp/ho-$f" >"$WORK/transfer/$f"
done
# The out-of-band value is the old operator's own record: the `dump NAME sha256 HEX` line `scf-backup dump` logged on
# the database node (never the SHA256SUMS in the dump store); the downloaded bytes must match it.
OOB=$(sed -n "s/^.* scf-backup: dump $NAME sha256 \([0-9a-f]\{64\}\)\r\{0,1\}\$/\1/p" "$OUT/a-dump.log" | tail -n1)
echo "$OOB  dump.tar.age  ($NAME, recorded by the old operator, sent separately)" >"$WORK/oob/expected.sha256"
cp "$WORK/oob/expected.sha256" "$OUT/oob-expected.sha256"
[ -n "$OOB" ] && [ "$(sha256sum "$WORK/transfer/dump.tar.age" | cut -d' ' -f1)" = "$OOB" ] && [ "$(cut -d' ' -f1 "$WORK/transfer/SHA256SUMS")" = "$OOB" ] && step a-transfer ok 0 "dump $NAME, $(stat -c %s "$WORK/transfer/dump.tar.age") bytes, sha256 $OOB" || { step a-transfer FAIL 0 "download"; exit 1; }
# The age identity is handed over (I-12); the recipient is what any database host holds.
asroot "cp '$A/infra/compose/.secrets/ha/dump_age_identity' '$WORK/oob/identity' && cp '$A/infra/compose/.secrets/ha/dump_age_recipient' '$WORK/oob/recipient' && chmod 0444 '$WORK/oob/identity' '$WORK/oob/recipient'"
if timed dca exec -T "$P" scf-backup backup full 2 >"$OUT/a-backup.log" 2>&1; then step a-pgbackrest-full ok "$LAST_S" "full backup to repository 2"
else step a-pgbackrest-full FAIL "$LAST_S" "$(tail -n2 "$OUT/a-backup.log")"; fi
dca exec -T -e PGPASSWORD="$PGPW_A" "$P" sh -c 'psql -X -At -h /var/run/postgresql -U postgres -d postgres -c "select pg_switch_wal()" >/dev/null; sleep 5' >/dev/null 2>&1

# ============================================================ 2. path (b): pgBackRest restore by the new operator
say "== 2. path (b): repository 2 restored on a scratch host of the new operator"
if timed dca --profile drill run --rm --no-deps -T --entrypoint bash -v "$HO:/handover:ro" pg-drill /handover/pitr-restore.sh >"$OUT/F_b.tsv" 2>"$OUT/b-restore.log"; then
  if diff "$OUT/F0.tsv" "$OUT/F_b.tsv" >"$OUT/diff-b.txt"; then step b-pgbackrest-restore ok "$LAST_S" "F_b = F0; $(grep PITR-RESTORE "$OUT/b-restore.log")"
  else step b-pgbackrest-restore FAIL "$LAST_S" "F_b differs: $(grep -c '^[<>]' "$OUT/diff-b.txt") lines (diff-b.txt)"; fi
else step b-pgbackrest-restore FAIL "$LAST_S" "$(grep -iE 'error|fatal' "$OUT/b-restore.log" | head -n2)"; fi
docker volume rm -f "${PA}_drill" >/dev/null 2>&1
API_A_SERVICES=$(dca ps --format '{{.Service}}' | sort | xargs)
dca --profile drill --profile migration down -v --remove-orphans >/dev/null 2>&1
say "old operator stack removed ($API_A_SERVICES)"

# ============================================================ 3. tamper cases (throwaway servers, no network)
say "== 3. tamper cases"
scratch() { # scratch ARGS… → import.sh in a throwaway usagemap/postgres-ha container
  docker run --rm --network none --user 999:999 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=1g,uid=999,gid=999 --tmpfs /var/run/postgresql:uid=999,gid=999 -e PGDATA=/tmp/pg \
    -v "$HO:/handover:ro" -v "$WORK:/w" --entrypoint /usr/bin/env "$PGHA" "$@"
}
mkdir -p "$WORK/t1" && cp "$WORK/transfer/"* "$WORK/t1/"
python3 - "$WORK/t1/dump.tar.age" <<'PY'
import sys
p = sys.argv[1]; b = bytearray(open(p, "rb").read()); b[len(b) // 2] ^= 0x01; open(p, "wb").write(b)
PY
expect_refused() { # expect_refused NAME STAGE ARGS…
  local name=$1 stage=$2 out; shift 2
  out=$(scratch bash /handover/import.sh "$@" 2>&1 | grep -E '^IMPORT (PASS|FAIL)' | tail -n1)
  if [[ $out == "IMPORT FAIL stage=$stage"* ]]; then step "$name" ok 0 "refused: $out"; else step "$name" FAIL 0 "expected a refusal at stage $stage, got: ${out:-no result}"; fi
}
expect_refused t1-flipped-byte integrity --dir /w/t1 --expect-sha256 "$OOB" --identity /w/oob/identity --scratch
if scratch bash /handover/forge.sh /w/transfer /w/oob/recipient /w/oob/identity /w/forged >"$OUT/forge.log" 2>&1; then
  expect_refused t2-consistent-forgery integrity --dir /w/forged/consistent --expect-sha256 "$OOB" --identity /w/oob/identity --scratch
  STALE=$(cut -d' ' -f1 "$WORK/forged/stale/SHA256SUMS")
  expect_refused t3-stale-manifest compare --dir /w/forged/stale --expect-sha256 "$STALE" --identity /w/oob/identity --scratch
  CONS=$(cut -d' ' -f1 "$WORK/forged/consistent/SHA256SUMS")
  out=$(scratch env SCF_IMPORT_FINGERPRINT=/handover/fingerprint.sh SCF_IMPORT_FINGERPRINT_OUT=/w/forged/F_t4.tsv \
        bash /handover/import.sh --dir /w/forged/consistent --expect-sha256 "$CONS" --identity /w/oob/identity --scratch 2>&1 | grep -E '^IMPORT' | tail -n1)
  d=$(diff "$OUT/F0.tsv" "$WORK/forged/F_t4.tsv" | grep '^>' | cut -f1-3 | xargs)
  if [[ $out == "IMPORT PASS"* ]] && [ -n "$d" ]; then step t4-compromised-oob-hash ok 0 "import passes (both channels forged) but the fingerprint diff names: $d"
  else step t4-compromised-oob-hash FAIL 0 "import: $out; fingerprint diff: ${d:-none}"; fi
else step forge FAIL 0 "$(tail -n2 "$OUT/forge.log")"; fi
out=$(scratch env SCF_IMPORT_FINGERPRINT=/handover/fingerprint.sh SCF_IMPORT_FINGERPRINT_OUT=/w/forged/F_t5.tsv \
      bash /handover/import.sh --dir /w/transfer --expect-sha256 "$OOB" --identity /w/oob/identity --scratch --no-create 2>&1 | grep -E '^IMPORT' | tail -n1)
diff "$OUT/F0.tsv" "$WORK/forged/F_t5.tsv" >"$OUT/diff-t5-no-create.txt"
d=$(grep '^>' "$OUT/diff-t5-no-create.txt" | cut -f1-3 | xargs)
[[ $out == "IMPORT PASS"* ]] && r=ok || r=FAIL
step t5-import-without-create $r 0 "import ${out%% *} ${out#IMPORT }; differs from F0 only in: ${d:-nothing} (what scf-backup dump-restore loses)"

# ============================================================ 4. new operator
say "== 4. new operator: $PB (single node) from its own clone, its own secrets"
clone "$B" || { step clone-b FAIL 0 "git clone"; exit 1; }
timed "$B/infra/compose/scripts/init.sh" >"$OUT/b-init.log" 2>&1 && step n-secrets ok "$LAST_S" "init.sh (new operator's own secrets and PKI)" || { step n-secrets FAIL "$LAST_S" "$(tail -n2 "$OUT/b-init.log")"; exit 1; }
# Carried over under C-50 / handover plan I-15, I-16, I-17, I-26 (everything else stays the new operator's own):
CARRY="pepper_ing pepper_op pepper_pub edge_signing_key.pem edge_snapshot_pub.pem edge_snapshot_pub_next.pem snapshot_signing_key.pem snapshot_pub.pem umami_creds_keys umami_app_secret umami_provisioner_password"
asroot "for f in $CARRY; do cp -p '$A/infra/compose/.secrets/'\$f '$B/infra/compose/.secrets/'\$f || exit 1; done" &&
  step n-carry-over ok 0 "$(wc -w <<<"$CARRY") secrets carried over (C-50): $CARRY" || step n-carry-over FAIL 0 "copy"
for s in pg_superuser_password scf_app_password umami_db_password; do
  cmp -s "$A/infra/compose/.secrets/$s" "$B/infra/compose/.secrets/$s" && step n-own-secrets FAIL 0 "$s equals the old operator's"
done
timed dcb up -d --no-build --wait postgres >"$OUT/n-pg.log" 2>&1 && step n-postgres ok "$LAST_S" "new operator's PostgreSQL (fresh)" || { step n-postgres FAIL "$LAST_S" "$(tail -n2 "$OUT/n-pg.log")"; exit 1; }
PGPW_B=$(cat "$B/infra/compose/.secrets/pg_superuser_password")
imp() {
  docker run --rm --network "${PB}_db" --user 999:999 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=1g,uid=999,gid=999 -e PGHOST=postgres -e PGUSER=postgres -e PGPASSWORD="$PGPW_B" \
    -v "$HO:/handover:ro" -v "$WORK:/w" --entrypoint /usr/bin/env "$PGHA" "$@"
}
t0=$SECONDS
out=$(imp bash /handover/import.sh --dir /w/transfer --expect-sha256 "$OOB" --identity /w/oob/identity --into-fresh 2>&1 | tee "$OUT/a-import.log" | grep -E '^IMPORT' | tail -n1)
LAST_S=$((SECONDS - t0))
[[ $out == "IMPORT PASS"* ]] && step a-import ok "$LAST_S" "$out" || { step a-import FAIL "$LAST_S" "${out:-$(tail -n2 "$OUT/a-import.log")}"; exit 1; }
out=$(imp bash /handover/import.sh --dir /w/transfer --expect-sha256 "$OOB" --identity /w/oob/identity --into-fresh 2>&1 | grep -E '^IMPORT' | tail -n1)
[[ $out == "IMPORT FAIL stage=target"* ]] && step a-import-twice ok 0 "a second import into the now non-fresh target is refused: $out" || step a-import-twice FAIL 0 "$out"
imp bash /handover/fingerprint.sh scf umami >"$OUT/F_a.tsv" 2>"$OUT/F_a.err"
imp FP_RAW=1 bash /handover/fingerprint.sh scf umami >"$OUT/F_a.raw.tsv" 2>/dev/null
if diff "$OUT/F0.tsv" "$OUT/F_a.tsv" >"$OUT/diff-a.txt"; then step a-fingerprint ok 0 "F_a = F0 ($(wc -l <"$OUT/F0.tsv") lines: tables, sequences, schema, database, roles)"
else step a-fingerprint FAIL 0 "F_a differs in $(grep -c '^[<>]' "$OUT/diff-a.txt") lines: $(grep '^>' "$OUT/diff-a.txt" | cut -f1-3 | head -n5 | xargs)"; fi
# The whole stack on the migrated data with the new operator's secrets (db-migrate and umami-views set every role
# password from them; umami-bootstrap logs in with the carried-over provisioning password).
if timed dcb up -d --no-build --wait --wait-timeout 900 >"$OUT/n-up.log" 2>&1; then step n-up ok "$LAST_S" "new stack healthy on the migrated data"
else step n-up FAIL "$LAST_S" "$(grep -iE 'error|unhealthy' "$OUT/n-up.log" | tail -n2)"; up_failed dcb "$OUT/n-up.log"; fi
st() { docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$(dcb ps -aq "$1")" 2>/dev/null; }
[ "$(st umami-bootstrap)" = "exited 0" ] && step n-umami-bootstrap ok 0 "the carried-over provisioning identity logs in to the migrated Umami" || step n-umami-bootstrap FAIL 0 "$(st umami-bootstrap)"
[ "$(st db-migrate)" = "exited 0" ] && step n-db-migrate ok 0 "migrations already applied: no-op; role passwords set from the new secrets" || step n-db-migrate FAIL 0 "$(st db-migrate)"
curl -fsS http://127.0.0.1:56723/readyz >/dev/null 2>&1 && step n-readyz ok 0 "control plane reaches the migrated database" || step n-readyz FAIL 0 "/readyz"
old_pw_refused() { ! dcb exec -T -e PGPASSWORD="$(cat "$A/infra/compose/.secrets/scf_app_password")" postgres psql -X -At -h 127.0.0.1 -U scf_app -d scf -c 'select 1' >/dev/null 2>&1; }
old_pw_refused && step n-old-credentials-refused ok 0 "the old operator's scf_app password does not log in" || step n-old-credentials-refused FAIL 0 "old password accepted"
api_capture 56724 "$OUT/api-after.tsv"
# Parity on every answer the old stack gave with 200 before the freeze (an answer it did not have yet — e.g. public
# stats the old jobs service had not computed — may legitimately appear once the new jobs service runs).
cmp200=$(awk -F'\t' '$2 == 200 {print $1}' "$OUT/api-before.tsv")
same=0 differ=""
for path in $cmp200; do
  [ "$(grep -F "$path"$'\t' "$OUT/api-before.tsv")" = "$(grep -F "$path"$'\t' "$OUT/api-after.tsv")" ] && same=$((same + 1)) || differ+=" $path"
done
diff -r "$OUT/api-before.tsv.d" "$OUT/api-after.tsv.d" >"$OUT/diff-api-bodies.txt" 2>&1
if [ -n "$cmp200" ] && [ -z "$differ" ]; then
  step n-api-parity ok 0 "$same public answers that were 200 before the freeze are identical after the migration (status + normalised body); not comparable: $(awk -F'\t' '$2 != 200 {print $1 "=" $2}' "$OUT/api-before.tsv" | xargs)"
else step n-api-parity FAIL 0 "differ:${differ:- none compared} (bodies: diff-api-bodies.txt)"; fi
# ops.end-of-window-read-only (no successor by month 12): the aggregate-only export from the migrated database, verified against its own
# manifest. The exporter is the one in THIS checkout (services/control-plane/scripts/export-aggregates.ts), run in
# a Node container on the new operator's database network; skipped (not run, never green) when it is absent.
EXP="$REPO/services/control-plane/scripts/export-aggregates.ts"
if [ -f "$EXP" ]; then
  mkdir -p "$WORK/export" && chmod 0777 "$WORK/export"
  t0=$SECONDS
  if docker run --rm --network "${PB}_db" --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
       -e SCF_EXPORT_DATABASE_URL="postgres://postgres:$PGPW_B@postgres:5432/scf" -v "$REPO:/repo:ro" -v "$WORK/export:/out" \
       -w /repo/services/control-plane node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc node scripts/export-aggregates.ts --out /out/bundle >"$OUT/export.log" 2>&1; then
    bad=0 rows=0 nfiles=0
    while IFS=$'\t' read -r name sha n; do
      nfiles=$((nfiles + 1)); rows=$((rows + n))
      [ "$(sha256sum "$WORK/export/bundle/$name" | cut -d' ' -f1)" = "$sha" ] || bad=$((bad + 1))
    done < <(jq -r '.files[] | [.name, .sha256, .rows] | @tsv' "$WORK/export/bundle/manifest.json")
    extra=$(find "$WORK/export/bundle" -mindepth 1 -printf '%f\n' | grep -vxF -f <(jq -r '.files[].name' "$WORK/export/bundle/manifest.json"; echo manifest.json) | xargs)
    jq '{format, version, files: [.files[] | {name, rows, sha256}]}' "$WORK/export/bundle/manifest.json" >"$OUT/aggregate-export-manifest.json"
    if [ "$bad" = 0 ] && [ -z "$extra" ] && [ "$nfiles" -gt 0 ]; then
      step n-aggregate-export ok $((SECONDS - t0)) "$(jq -r '.format + " " + .version' "$WORK/export/bundle/manifest.json"): $nfiles files, $rows rows, every SHA-256 matches the manifest, no unlisted file"
    else step n-aggregate-export FAIL $((SECONDS - t0)) "files=$nfiles bad_hashes=$bad unlisted=[$extra]"; fi
  else step n-aggregate-export FAIL $((SECONDS - t0)) "$(tail -n3 "$OUT/export.log")"; fi
else say "not run: aggregate export (no $EXP in this checkout)"; fi
dcb images --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null | sort -u >"$OUT/images.txt"

say "== result"
column -t -s $'\t' "$SUMMARY" | cut -c1-220 | tee -a "$OUT/drill.log"
say "HANDOVER-DRILL $([ $FAIL = 0 ] && echo PASS || echo FAIL) commit=${COMMIT:0:12} passed=$PASS failed=$FAIL out=$OUT"
[ $FAIL = 0 ]
