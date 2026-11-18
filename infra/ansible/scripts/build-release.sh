#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Build every release image of the lean profile from ONE git commit, on the operator's workstation, for a host that has
# no registry (docs/guides/deploy-v1.md): `git archive <rev>` into a fresh directory (only committed files), the same
# Dockerfiles Compose uses, the gateway's tracker built for THIS deployment's ingest names (TRACKER_HOSTS, so the
# tracker files and their SRI hashes are the ones the pages pin), tagged <prefix>/<name>:<short rev>. Then writes, in
# <out dir>:
#   images.yml            scf_images (tags) + scf_image_ids (configuration digests the role checks on the host)
#   tracker-<v>/          the tracker release directory the role needs (lib/<v>/…, SHA256SUMS, release.json),
#                         extracted from the built gateway image — so the control plane's SRI = the served bytes
#   build.log
#
#   infra/ansible/scripts/build-release.sh <rev> <out dir> https://e1.example.org,https://e2.example.org [prefix]
# Uses `docker build` only (BuildKit cache is reused; nothing is pushed anywhere). Run long builds under the machine's
# Docker slot wrapper where one exists.
set -euo pipefail
rev=${1:?git revision} out=${2:?output directory} hosts=${3:?TRACKER_HOSTS, two https origins} prefix=${4:-usagemap}
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
sha=$(git -C "$REPO" rev-parse --short=7 "$rev^{commit}")
src=$(mktemp -d "${TMPDIR:-/tmp}/scf-build-$sha.XXXXXX")
trap 'rm -rf "$src"' EXIT
mkdir -p "$out"; log="$out/build.log"; : >"$log"
git -C "$REPO" archive "$sha" | tar -x -C "$src"
echo "building $sha from $(git -C "$REPO" rev-parse "$sha") into $prefix/*:$sha (tracker hosts $hosts)" | tee -a "$log"

b() { # b NAME CONTEXT [docker build args…]
  local name=$1 ctx=$2; shift 2
  echo "== $name" >>"$log"
  docker build -q -t "$prefix/$name:$sha" "$@" "$ctx" >>"$log" 2>&1 || { tail -n 40 "$log" >&2; echo "build $name failed" >&2; exit 1; }
}
# The gateway embeds the tracker; its Dockerfile takes the deployment's ingest names as the build argument
# TRACKER_HOSTS (services/gateway/Dockerfile). GATEWAY_DOCKERFILE may name another gateway Dockerfile (e.g. the working
# tree's, to build a commit made before that argument existed); it is recorded in images.yml.
gw_dockerfile=${GATEWAY_DOCKERFILE:-$src/services/gateway/Dockerfile}
if ! grep -q '^ARG TRACKER_HOSTS' "$gw_dockerfile"; then
  echo "$gw_dockerfile has no ARG TRACKER_HOSTS: build a newer commit or set GATEWAY_DOCKERFILE" >&2
  exit 1
fi

b postgres-ha "$src/infra/compose/ha" -f "$src/infra/compose/ha/postgres/Dockerfile"
b db-migrate "$src/db" --target migrate
b umami "$src/vendor/umami" --target app
b umami-migrate "$src/vendor/umami" --target migrate
b engine-proxy "$src/services/engine-proxy"
b control-plane "$src" -f "$src/services/control-plane/Dockerfile"
b portal "$src" -f "$src/apps/portal/Dockerfile"
b jobs "$src" -f "$src/services/jobs/Dockerfile"
b metrics-writer "$src/services/metrics-writer"
b gateway "$src" -f "$gw_dockerfile" --build-arg "TRACKER_HOSTS=$hosts"
b otelcol "$src" -f "$src/collector/Dockerfile"
b ops "$src" -f "$src/ops/Dockerfile"
names="postgres_ha db_migrate umami umami_migrate engine_proxy control_plane portal jobs metrics_writer gateway otelcol ops"
# The hosted MCP server exists from the commit that added services/mcp; an older commit deploys without it.
if [ -f "$src/services/mcp/Dockerfile" ]; then b mcp "$src" -f "$src/services/mcp/Dockerfile"; names="$names mcp"; fi

# images.yml: tags and configuration digests (the ID that survives docker save | docker load)
config_id() { docker save "$1" | tar -xO manifest.json | python3 -I -c 'import json,sys; print("sha256:" + json.load(sys.stdin)[0]["Config"].split("/")[-1].removesuffix(".json"))'; }
{
  echo "# built from $(git -C "$REPO" rev-parse "$sha") by infra/ansible/scripts/build-release.sh; tracker hosts $hosts"
  [ -n "${GATEWAY_DOCKERFILE:-}" ] && echo "# gateway Dockerfile: $GATEWAY_DOCKERFILE (sha256 $(sha256sum "$GATEWAY_DOCKERFILE" | cut -c1-64))"
  case " $names " in *" mcp "*) ;; *) echo "scf_mcp_enabled: false # no services/mcp at this commit" ;; esac
  echo "scf_images:"
  for n in $names; do
    echo "  $n: $prefix/${n//_/-}:$sha"
  done
  echo "scf_image_ids:"
  for n in $names; do
    echo "  $n: \"$(config_id "$prefix/${n//_/-}:$sha")\""
  done
} >"$out/images.yml"

# tracker release directories from the gateway image (what it serves)
tmp=$(mktemp -d); c=$(docker create "$prefix/gateway:$sha")
docker cp "$c:/usr/share/scf-gateway/tracker/." "$tmp/" >/dev/null; docker rm "$c" >/dev/null
for v in $(cd "$tmp" && ls -d [0-9]*.[0-9]*.[0-9]* 2>/dev/null); do
  d="$out/tracker-$v"; rm -rf "$d"; mkdir -p "$d/lib"; cp -r "$tmp/$v" "$d/lib/"
  (cd "$d" && find lib -type f | sort | xargs sha256sum >SHA256SUMS)
  python3 -I -c '
import json, sys
d, v, src = sys.argv[1:4]
files = sorted(l.split("  ", 1)[1].strip() for l in open(d + "/SHA256SUMS"))
json.dump({"name": "@usagemap/tracker", "version": v, "dirty": False, "files": files, "source": src}, open(d + "/release.json", "w"))
' "$d" "$v" "extracted from $prefix/gateway:$sha (TRACKER_HOSTS=$hosts)"
  echo "tracker $v: $(jq -c .config.hosts "$d/lib/$v/manifest.json")" | tee -a "$log"
done
rm -rf "$tmp"
echo "done: $out/images.yml" | tee -a "$log"
