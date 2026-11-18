#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Clean-clone rebuild drill (core plan C1 item 15; docs.deployment-guide local part, ops.rebuild-from-repo, repo.monorepo-complete, repo.single-monorepo).
#
# A fresh Debian 13 "host" container (privileged, its own Docker daemon and an empty image store on its own volume —
# nothing from this machine's Docker cache is visible) clones the committed branch from this repository and follows
# docs/guides/self-hosting.md VERBATIM: the shell blocks of §3 (first start), §4 (check it) and §6 (stop, reset) are
# extracted from the guide at the cloned commit and executed line by line, each line timed. The only substitution is
# the guide's own placeholder `<repository>`. A line that fails is recorded as a guide defect; the drill then applies
# the smallest documented remedy (table FIXUPS below, each one a finding) and continues, so one run finds every
# defect instead of stopping at the first.
#
# Host provisioning = the guide's §2 requirements, installed the way §2 names them (the guide does not script them):
# Docker Engine from Docker's own apt repository at the version infra/ansible/roles/docker_engine pins, with the Compose
# and buildx plugins; mise (https://mise.run); plus git, curl, jq, openssl. Until 2026-11-18 the host had Debian's
# docker.io 26.1 and no mise, which §2 has since ruled out (drill run 4, defects D1/D2).
#
#   tests/rebuild/run.sh                       # clone branch main, run, remove everything
#   DRILL_REF=main KEEP=1 tests/rebuild/run.sh    # keep the host container and its volume
#   OUT=/path tests/rebuild/run.sh             # where steps.tsv and the logs go (default: a new temp dir)
#
# Docker objects (all removed at the end unless KEEP=1): container scf-rb-host, volumes scf-rb-docker, scf-rb-work.
# No host port is published. Output: $OUT/steps.tsv (section, line, exit status, seconds, verdict) and one log per step.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# The commit under test (default HEAD of this checkout). Not BRANCH: a detached checkout has no branch to clone.
DRILL_SHA=$(git -C "$REPO" rev-parse --verify "${DRILL_REF:-HEAD}^{commit}")
HOST=scf-rb-host VOL_DOCKER=scf-rb-docker VOL_WORK=scf-rb-work
BASE_IMAGE=${BASE_IMAGE:-debian:13}
OUT=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/scf-rebuild.XXXXXX")}
mkdir -p "$OUT"
STEPS="$OUT/steps.tsv"
printf 'section\tcommand\texit\tseconds\tverdict\n' >"$STEPS"
say() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$OUT/drill.log"; }

cleanup() {
  [ "${KEEP:-0}" = 1 ] && { say "KEEP=1: $HOST left running"; return; }
  docker exec "$HOST" sh -c 'docker ps -aq | xargs -r docker rm -f; docker system prune -af --volumes' >/dev/null 2>&1
  docker rm -f "$HOST" >/dev/null 2>&1
  docker volume rm -f "$VOL_DOCKER" "$VOL_WORK" >/dev/null 2>&1
  true
}
trap cleanup EXIT
KEEP_SAVED=${KEEP:-0}; KEEP=0 cleanup; KEEP=$KEEP_SAVED

in_host() { docker exec -i -w /work "$HOST" bash -lc "$1"; }

# record SECTION COMMAND EXIT SECONDS VERDICT
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$(tr '\n\t' '  ' <<<"$2" | sed 's/ *$//')" "$3" "$4" "$5" >>"$STEPS"; }

# run_line SECTION N CMD → runs CMD in the clone's working directory with the drill's shell state, timed.
run_line() {
  local section=$1 n=$2 cmd=$3 t0 rc dt log
  log="$OUT/$section-$n.log"
  t0=$(date +%s)
  # The shell state (cwd, exported environment, e.g. the guide's `eval "$(mise env -s bash)"`) carries over between
  # the lines of one guide, like a terminal session.
  in_host "cd \"\$(cat /work/.cwd 2>/dev/null || echo /work)\"; [ -f /work/.env ] && . /work/.env
set -o pipefail
$cmd
rc=\$?; pwd >/work/.cwd; export -p | grep -vE '^declare -x (PWD|OLDPWD|SHLVL|_)=' >/work/.env; exit \$rc" >"$log" 2>&1
  rc=$?
  dt=$(($(date +%s) - t0))
  say "[$section #$n] exit $rc in ${dt}s: $cmd"
  [ $rc = 0 ] || tail -n 25 "$log" | sed 's/^/    | /' | tee -a "$OUT/drill.log"
  echo "$rc $dt"
}

say "== 0. host: $BASE_IMAGE, privileged, own Docker daemon on volume $VOL_DOCKER (empty image store)"
docker volume create "$VOL_DOCKER" >/dev/null && docker volume create "$VOL_WORK" >/dev/null
docker run -d --name "$HOST" --hostname rebuild-host --privileged --cgroupns=private \
  -v "$VOL_DOCKER:/var/lib/docker" -v "$VOL_WORK:/work" -v "$REPO:/src/usagemap:ro" \
  "$BASE_IMAGE" sleep infinity >/dev/null || { say "cannot start the host container"; exit 1; }
t0=$(date +%s)
in_host 'set -e; export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq --no-install-recommends git curl jq openssl ca-certificates xz-utils procps \
  iproute2 >/dev/null
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" >/etc/apt/sources.list.d/docker.list
apt-get update -qq && apt-get install -y -qq --no-install-recommends "docker-ce=5:29.9.3-1~debian.13~trixie" \
  "docker-ce-cli=5:29.9.3-1~debian.13~trixie" containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh >/dev/null
mise --version
# Nested Docker on cgroup v2 (harness, not the guide): move this container'"'"'s processes into a leaf cgroup and
# delegate every controller, as the docker:dind entrypoint does; otherwise containers with resource limits fail with
# "cannot enter cgroupv2 ... in threaded mode".
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 </sys/fs/cgroup/cgroup.procs >/sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e "s/ / +/g" -e "s/^/+/" </sys/fs/cgroup/cgroup.controllers >/sys/fs/cgroup/cgroup.subtree_control
fi
(dockerd >/var/log/dockerd.log 2>&1 &)
for i in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info --format "docker {{.ServerVersion}} storage {{.Driver}} images {{.Images}}"
docker compose version; docker buildx version
git config --global --add safe.directory "*"' >"$OUT/host.log" 2>&1
rc=$?
record host-provisioning "§2: docker-ce 29.9.3 + compose/buildx plugins (Docker's repository), mise, git curl jq openssl; dockerd" "$rc" $(($(date +%s) - t0)) "$([ $rc = 0 ] && echo ok || echo FAIL)"
cat "$OUT/host.log" | tail -n 4 | tee -a "$OUT/drill.log"
[ $rc = 0 ] || exit 1

# The guide at the commit under test, from a clone (the working tree of this checkout is never read).
in_host "git clone -q --no-checkout /src/usagemap /work/guide-src && git -C /work/guide-src checkout -q --detach $DRILL_SHA && git -C /work/guide-src log -1 --format='%H %cI'" \
  >"$OUT/commit.txt" 2>"$OUT/commit.err" || { say "clone for the guide failed"; cat "$OUT/commit.err"; exit 1; }
COMMIT=$(cut -d' ' -f1 "$OUT/commit.txt")
say "commit under test: $(cat "$OUT/commit.txt")"
in_host 'cat /work/guide-src/docs/guides/self-hosting.md' >"$OUT/self-hosting.md"
in_host 'rm -rf /work/guide-src'

# extract HEADING_PREFIX → the lines of the first ```sh block under that heading (comments stripped, one per line).
extract() {
  awk -v h="$1" '
    index($0, h) == 1 { insec = 1; next }
    insec && /^## / { exit }
    insec && /^```sh/ { inblk = 1; next }
    inblk && /^```/ { exit }
    inblk { print }' "$OUT/self-hosting.md" |
    sed -E 's/[[:space:]]+#[[:space:]].*$//; s/^#.*$//' | sed -E '/^[[:space:]]*$/d'
}

# FIXUPS: the remedy applied when a guide line fails, keyed by a pattern of the failing line. Each application is a
# finding (the guide is wrong or incomplete there); the line is then retried once.
fixup_for() {
  case "$1" in
    *"up -d --build --wait"*)
      # §2 asks for "Docker, Compose v2.24+ and BuildKit"; Debian's docker.io 26.1 has all three but its BuildKit
      # refuses `ADD --checksum` on git sources (vendor/umami/Dockerfile: "source.git.checksum is not supported by
      # build server"). Remedy: Docker Engine from Docker's repository at the version the Ansible role pins.
      echo 'export DEBIAN_FRONTEND=noninteractive; pkill dockerd; for i in $(seq 30); do pgrep dockerd >/dev/null || break; sleep 1; done
apt-get remove -y -qq docker.io docker-cli docker-compose docker-buildx >/dev/null && install -m 0755 -d /etc/apt/keyrings &&
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc &&
echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" >/etc/apt/sources.list.d/docker.list &&
apt-get update -qq && apt-get install -y -qq --no-install-recommends "docker-ce=5:29.9.3-1~debian.13~trixie" "docker-ce-cli=5:29.9.3-1~debian.13~trixie" containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null &&
(dockerd >/var/log/dockerd.log 2>&1 &) && for i in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 1; done && docker version --format "{{.Server.Version}}" && docker compose version'
      ;;
    *smoke.sh*)
      # §4 runs the smoke test while the §3 stack is still up: both publish 127.0.0.1:8080, 5173 and 8443, so the
      # smoke stack's control plane, portal and gateway stay "Created". Remedy: the smoke test on its own ports.
      echo 'export SCF_CONTROL_PLANE_PORT=18080 SCF_PORTAL_PORT=15173 SCF_INGEST_PORT=18443; true'
      ;;
    *init.sh*)
      # init.sh builds the tracker with pnpm when tracker/dist is missing (it is git-ignored, so always on a clone),
      # which needs the toolchain (§2 "for building from source") and the workspace dependencies.
      echo 'curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh >/dev/null && mise trust -q . && mise install -q && eval "$(mise env -s bash)" && pnpm install --frozen-lockfile >/dev/null && mise env -s bash >/work/.env'
      ;;
    *) echo "" ;;
  esac
}

run_section() { # run_section NAME HEADING
  local name=$1 heading=$2 n=0 line rc dt fix retry
  mapfile -t lines < <(extract "$heading")
  [ ${#lines[@]} -gt 0 ] || { record "$name" "(no shell block under '$heading')" - 0 "GUIDE-DEFECT"; return; }
  for line in "${lines[@]}"; do
    n=$((n + 1))
    # The guide's only placeholder: `git clone <repository URL> && cd <repository directory>` (older text: `<repository>`). A URL cannot be cd'ed into, so the
    # clone source is the repository and the directory is its name (finding when this substitution is needed).
    if [[ $line == *"<repository URL>"* || $line == *"<repository>"* ]]; then
      line=$(sed -E 's#git clone <repository( URL)?>#git clone -q /src/usagemap usagemap \&\& git -C usagemap checkout -q --detach '"$DRILL_SHA"'#; s#cd <repository( directory)?>#cd usagemap#' <<<"$line")
    fi
    read -r rc dt < <(run_line "$name" "$n" "$line" | tail -n1)
    if [ "$rc" = 0 ]; then record "$name" "$line" 0 "$dt" ok; continue; fi
    record "$name" "$line" "$rc" "$dt" "GUIDE-DEFECT"
    fix=$(fixup_for "$line")
    [ -n "$fix" ] || record "$name" "(no remedy known: line left failed)" "$rc" 0 FAIL
    if [ -n "$fix" ] && [ ! -e "$OUT/.fixed-$(md5sum <<<"$fix" | cut -c1-8)" ]; then
      : >"$OUT/.fixed-$(md5sum <<<"$fix" | cut -c1-8)"
      read -r rc dt < <(run_line "$name" "$n-fixup" "$fix" | tail -n1)
      record "$name" "FIXUP: $fix" "$rc" "$dt" "$([ "$rc" = 0 ] && echo applied || echo FAIL)"
      [[ $fix == export* ]] && retry="${fix%; true} && $line" || retry=$line
      read -r rc dt < <(run_line "$name" "$n-retry" "$retry" | tail -n1)
      record "$name" "RETRY: $line" "$rc" "$dt" "$([ "$rc" = 0 ] && echo ok || echo FAIL)"
    fi
  done
}

say "== §3 First start"
run_section s3-first-start "## 3. First start"
say "== §4 Check it (control plane health, then the smoke test of the guide)"
t0=$(date +%s)
read -r rc dt < <(run_line s4-healthz 1 'curl -fsS http://127.0.0.1:8080/healthz' | tail -n1)
record s4-check "curl -fsS http://127.0.0.1:8080/healthz (§4 last sentence)" "$rc" "$dt" "$([ "$rc" = 0 ] && echo ok || echo FAIL)"
in_host 'cd "$(cat /work/.cwd)"; docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml ps --format "{{.Service}} {{.State}} {{.Health}}"' >"$OUT/ps-after-up.txt" 2>&1
run_section s4-check "## 4. Check it"
say "== §6 Stop, reset"
run_section s6-stop "## 6. Stop, reset, upgrade"
in_host 'docker system df' >"$OUT/docker-df.txt" 2>&1
say "== result (commit $COMMIT)"
column -t -s $'\t' "$STEPS" | tee -a "$OUT/drill.log"
defects=$(awk -F'\t' 'NR>1 && $5=="GUIDE-DEFECT"' "$STEPS" | wc -l)
fails=$(awk -F'\t' 'NR>1 && $5=="FAIL"' "$STEPS" | wc -l)
say "REBUILD-DRILL $([ "$fails" = 0 ] && echo PASS || echo FAIL) commit=${COMMIT:0:12} guide_defects=$defects unrecovered=$fails out=$OUT"
[ "$fails" = 0 ]
