# Umami patch queue (empty)

ADR-0003: Umami runs **unmodified**. This directory exists so that a security fix can ship within 24 hours when
upstream has none (`docs/security/vulnerability-response.md`). It is empty in normal operation.

How the queue works:

- `../Dockerfile` (stage `patched`) applies every `NNNN-short-title.patch` in this directory, in file-name order, with
  `patch -p1 -N` against the upstream source at the pinned commit (`../UPSTREAM`). A patch that does not apply fails
  the image build.
- Each patch must be a `git format-patch` file against `UMAMI_COMMIT` with a header stating the advisory or issue it
  fixes, the upstream PR or commit it mirrors (if any), and the condition for removing it (normally: the upstream
  release that contains the fix).
- Adding a patch changes the image; bump `IMAGE_TAG` in `../UPSTREAM` with a `-pN` suffix (e.g. `3.5.0-d3c62a8-p1`)
  and in `infra/compose/compose.yaml`, re-run `../test/hardening-check.sh` and the adapter contract tests.
- Remove the patch in the same change that moves the pin to an upstream release containing the fix.
