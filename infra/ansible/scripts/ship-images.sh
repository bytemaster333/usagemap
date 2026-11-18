#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Ship release images to a host without a registry (v1 small host, docs/guides/deploy-v1.md): one `docker save` of
# every image named in an images file (shared layers travel once), compressed over SSH into the host's Docker, then
# each image ID on the host is compared with the workstation's (the role checks the same IDs again before `up`).
#
#   infra/ansible/scripts/ship-images.sh <ssh-destination> <images.yml>
#   infra/ansible/scripts/ship-images.sh --ids <images.yml>      (print the scf_image_ids map)
# images.yml: the deploy's `scf_images:` map (name: repo:tag). `--ids` prints the `scf_image_ids:` map (configuration
# digests) for images.yml instead of shipping.
set -euo pipefail
# The image ID that survives `docker save | docker load` is the sha256 of the image CONFIGURATION (it names every layer
# by its diff ID). A workstation on the containerd image store reports the manifest digest as .Id instead, so the
# config digest is read from the saved archive's manifest.json.
config_id() { docker save "$1" | tar -xO manifest.json | python3 -I -c 'import json,sys; print("sha256:" + json.load(sys.stdin)[0]["Config"].split("/")[-1].removesuffix(".json"))'; }
dest=${1:?ssh destination}; file=${2:?images.yml}
mapfile -t imgs < <(awk '/^scf_images:/{f=1;next} /^[^ ]/{f=0} f && NF==2 {print $2}' "$file")
[ "${#imgs[@]}" -gt 0 ] || { echo "no images in $file" >&2; exit 2; }
for i in "${imgs[@]}"; do docker image inspect "$i" >/dev/null || { echo "missing locally: $i" >&2; exit 1; }; done
if [ "$dest" = --ids ]; then
  echo "scf_image_ids:"
  awk '/^scf_images:/{f=1;next} /^[^ ]/{f=0} f && NF==2 {print $1, $2}' "$file" | while read -r k i; do echo "  $k \"$(config_id "$i")\""; done
  exit 0
fi
missing=(); declare -A ids
for i in "${imgs[@]}"; do
  want=$(config_id "$i"); ids[$i]=$want
  have=$(ssh "$dest" sudo docker image inspect --format '{{.Id}}' "$i" 2>/dev/null || true)
  [ "$want" = "$have" ] || missing+=("$i")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "shipping ${#missing[@]} image(s): ${missing[*]}"
  docker save "${missing[@]}" | gzip -1 | ssh "$dest" 'gunzip | sudo docker load -q'
fi
rc=0
for i in "${imgs[@]}"; do
  want=${ids[$i]}
  have=$(ssh "$dest" sudo docker image inspect --format '{{.Id}}' "$i" 2>/dev/null || true)
  if [ "$want" = "$have" ]; then echo "ok  $i $want"; else echo "BAD $i host=$have want=$want" >&2; rc=1; fi
done
exit $rc
