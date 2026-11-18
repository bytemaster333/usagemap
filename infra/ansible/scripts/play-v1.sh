#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run infra/ansible/playbooks/lean.yml against the v1 small host (docs/guides/deploy-v1.md) from the operator's
# workstation, inside the pinned tool image (infra/ansible/tools/Dockerfile: ansible-core 2.22.0). Everything that is
# deployment-specific or secret stays OUTSIDE the repository, in $DEPLOY_DIR (default $XDG_CONFIG_HOME/usagemap, mode 0700):
#
#   ansible/inventory.yml   ansible/v1.yml   (non-secret settings)
#   ansible/state/          (writable: known_hosts, the private CA in pki/ — back it up)
#   secrets/deploy-secrets.yml   (0600: gen-stack-secrets.sh output + backup SAS + ACME provider token)
#   release/<rev>/  ($RELEASE_DIR: images.yml and tracker-<v>/ from scripts/build-release.sh)   landing dir ($LANDING_DIR)
#   documentation site ($DOCS_DIR, optional: the static export of apps/docs; scf_docs_src: /docs-site)
#
#   infra/ansible/scripts/play-v1.sh [ansible-playbook args…]      e.g. -e '{"scf_stack_up": false}'  or  --check
# Environment: DEPLOY_DIR, SSH_KEY (default ~/.ssh/id_ed25519), RELEASE_DIR (build-release.sh output),
# LANDING_DIR (static landing page), DOCS_DIR (static documentation site, optional), PLAYBOOK (default playbooks/lean.yml).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEPLOY_DIR=${DEPLOY_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/usagemap}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
RELEASE_DIR=${RELEASE_DIR:?set RELEASE_DIR to the directory holding tracker-<version>/}
LANDING_DIR=${LANDING_DIR:?set LANDING_DIR to the landing page directory}
PLAYBOOK=${PLAYBOOK:-playbooks/lean.yml}
docs_mount=()
if [ -n "${DOCS_DIR:-}" ]; then
  [ -r "$DOCS_DIR/index.html" ] || { echo "DOCS_DIR $DOCS_DIR has no index.html (apps/docs static export)" >&2; exit 2; }
  docs_mount=(-v "$DOCS_DIR:/docs-site:ro")
fi
TOOL=usagemap/ansible-tools:2.22.0
[ -r "$RELEASE_DIR/images.yml" ] || { echo "missing $RELEASE_DIR/images.yml (scripts/build-release.sh)" >&2; exit 2; }
for f in ansible/inventory.yml ansible/v1.yml secrets/deploy-secrets.yml; do
  [ -r "$DEPLOY_DIR/$f" ] || { echo "missing $DEPLOY_DIR/$f (docs/guides/deploy-v1.md)" >&2; exit 2; }
done
mkdir -p "$DEPLOY_DIR/ansible/state"
docker image inspect "$TOOL" >/dev/null 2>&1 || docker build -q -t "$TOOL" -f "$REPO/infra/ansible/tools/Dockerfile" "$REPO/infra/ansible" >/dev/null
# The container runs as the operator's uid so it can read the 0600 files; ssh needs a passwd entry for that uid.
pw=$(mktemp); trap 'rm -f "$pw"' EXIT
printf 'root:x:0:0::/root:/bin/sh\noperator:x:%s:%s::/tmp:/bin/sh\n' "$(id -u)" "$(id -g)" >"$pw"
docker run --rm --user "$(id -u):$(id -g)" -v "$pw:/etc/passwd:ro" \
  -v "$REPO:/repo:ro" -v "$DEPLOY_DIR/ansible:/deploy:ro" -v "$DEPLOY_DIR/ansible/state:/state" \
  -v "$DEPLOY_DIR/secrets/deploy-secrets.yml:/secrets.yml:ro" -v "$SSH_KEY:/keys/id:ro" \
  -v "$RELEASE_DIR:/release:ro" -v "$LANDING_DIR:/landing:ro" "${docs_mount[@]}" \
  -e HOME=/tmp -e ANSIBLE_CONFIG=/repo/infra/ansible/ansible.cfg -e ANSIBLE_VARS_ENABLED=host_group_vars \
  -e ANSIBLE_LOCAL_TEMP=/tmp/.ansible-tmp -e ANSIBLE_FORCE_COLOR=0 \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo \
  -w /repo/infra/ansible "$TOOL" \
  ansible-playbook -i /deploy/inventory.yml -e @group_vars/all.yml -e @/deploy/v1.yml -e @/release/images.yml \
  -e @/secrets.yml "$@" "$PLAYBOOK"
