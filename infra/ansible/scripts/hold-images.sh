#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Staged redeploy of the v1 host (docs/guides/deploy-v1.md §9): writes an images override that takes every image from
# the NEW release except the named ones, which stay at the RUNNING release (tag and configuration digest). Passed after
# the release's images.yml (`play-v1.sh -e @/release/<file>`), it replaces both dicts, so the first playbook run
# deploys migrations and every other service while the held ones keep running unchanged; the second run, without the
# override, rolls them. Used for the Collector, whose new configuration emits a stream (stellar_client_metrics) that
# only the new metrics writer accepts.
#
#   infra/ansible/scripts/hold-images.sh <new images.yml> <running images.yml> <name>... > <new release dir>/hold.yml
#   e.g. … $DEPLOY_DIR/release/$REV/images.yml $DEPLOY_DIR/release/$PREV_REV/images.yml otelcol > $DEPLOY_DIR/release/$REV/hold-otelcol.yml
set -euo pipefail
[ $# -ge 3 ] || { sed -n '2,12p' "$0" >&2; exit 2; }
new=$1 old=$2; shift 2
exec python3 -I - "$new" "$old" "$@" <<'PY'
import re, sys

def read(path):
    """The two flat maps of a build-release.sh images.yml: scf_images (name: tag) and scf_image_ids (name: "sha256:…")."""
    maps, cur = {"scf_images": {}, "scf_image_ids": {}}, None
    for line in open(path, encoding="utf-8"):
        if re.match(r"^(scf_images|scf_image_ids):\s*$", line):
            cur = line.split(":")[0]
        elif cur and (m := re.match(r'^  ([a-z_]+): "?([^"\s]+)"?\s*$', line)):
            maps[cur][m.group(1)] = m.group(2)
        elif not line.startswith(" ") and line.strip() and not line.startswith("#"):
            cur = None
    return maps

new, old, held = read(sys.argv[1]), read(sys.argv[2]), sys.argv[3:]
for name in held:
    for k in ("scf_images", "scf_image_ids"):
        if name not in new[k] or name not in old[k]:
            sys.exit(f"hold-images: {name} missing from {k} of {'the new' if name not in new[k] else 'the running'} release")
        new[k][name] = old[k][name]
print(f"# images override: {sys.argv[1]} with {', '.join(held)} held at {sys.argv[2]} (hold-images.sh)")
for k in ("scf_images", "scf_image_ids"):
    print(f"{k}:")
    for name, v in new[k].items():
        print(f'  {name}: "{v}"' if k == "scf_image_ids" else f"  {name}: {v}")
PY
