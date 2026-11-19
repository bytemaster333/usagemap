#!/usr/bin/env sh
# SPDX-License-Identifier: Apache-2.0
# Builds tools/ap-listener (Go 1.27, no CGO) and runs it with listener.env; a variable already set in your shell (the
# token, or any override) wins over the file.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${AP_LISTENER_BIN:-$HERE/.bin/ap-listener}"
if [ ! -x "$BIN" ]; then
  mkdir -p "$(dirname "$BIN")"
  (cd "$HERE/../../tools/ap-listener" && CGO_ENABLED=0 go build -trimpath -o "$BIN" .)
fi
while IFS='=' read -r k v; do
  case "$k" in '' | \#*) continue ;; esac
  eval "[ -n \"\${$k+x}\" ]" || export "$k=$v"
done <"$HERE/listener.env"
exec "$BIN" "$@"
