#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run the suite in a local virtualenv ($VENV, default .venv, git-ignored) with the pinned test requirements.
# Python: $PYTHON, else mise's python@3.13 (mise install python@3.13), else python3 (needs the venv module).
# scripts/test-in-image.sh runs this script in the pinned Python image.
set -euo pipefail
cd "$(dirname "$0")/.."
py="${PYTHON:-}"
if [[ -z "$py" ]] && command -v mise >/dev/null && mise where python@3.13 >/dev/null 2>&1; then
  py="$(mise where python@3.13)/bin/python3"
fi
py="${py:-python3}"
venv="${VENV:-.venv}"
if [[ ! -x "$venv/bin/python" ]]; then
  "$py" -m venv "$venv"
fi
"$venv/bin/python" -m pip install -q --disable-pip-version-check -r requirements-test.txt
exec "$venv/bin/python" -m pytest -q "$@"
