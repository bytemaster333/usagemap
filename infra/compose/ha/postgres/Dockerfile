# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# ci-context: infra/compose/ha
# Database node of the HA profile (compose.ha.yaml): PostgreSQL 18.7 + Patroni + pgBackRest, as measured in S-08
# (C-108) and decided in ADR-0020/0021. Also used for the restore-drill scratch instance and the Azurite init step.
#
# Build context: infra/compose/ha. Base: the Debian (trixie) postgres:18 image, pinned by the digest observed on 2026-11-18 (PG_VERSION 18.7-1.pgdg13+2),
# because pgBackRest and Patroni come from the PGDG apt repository that image already configures (`trixie-pgdg`).
# Every package version is pinned: Debian main's pgBackRest 2.55.1 is below the 2.59.3 floor (C-29, S-08 O1).
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
FROM ${GO_IMAGE} AS age-build
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local GOBIN=/out
RUN go install -ldflags="-s -w" filippo.io/age/cmd/age@v1.3.2 filippo.io/age/cmd/age-keygen@v1.3.2 \
 && /out/age --version | grep -qx 'v1.3.2'

FROM postgres:18@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc

ARG PGBACKREST_VERSION=2.60.0-1.pgdg13+1
ARG PATRONI_VERSION=4.1.5-2.pgdg13+1
# Licences: pgBackRest MIT, Patroni MIT, python3-etcd MIT, psycopg2 LGPL-3.0 (run as part of Patroni, a separately run
# unmodified tool — never linked into our code), curl curl/MIT.
# Image-scan hygiene: take every Debian security update, and drop what this image never runs —
# gosu (an old Go binary; nothing here switches users, the container starts as `postgres`) and GnuPG (only needed by
# apt to fetch, apt verifies with gpgv). The remaining HIGH findings are Debian packages without a fixed version
# (krb5 via libpq, python3.13 for Patroni, util-linux, libxml2): see infra/compose/ha/README.md.
RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y --no-install-recommends; \
    apt-get install -y --no-install-recommends \
      "pgbackrest=${PGBACKREST_VERSION}" "patroni=${PATRONI_VERSION}" python3-etcd python3-psycopg2 \
      curl ca-certificates openssl; \
    apt-get purge -y --auto-remove gnupg dirmngr gpg gpg-agent gpgsm gpgconf gnupg-l10n gnupg-utils gpg-wks-client || true; \
    rm -f /usr/local/bin/gosu; \
    rm -rf /var/lib/apt/lists/*; \
    pgbackrest version | grep -qx 'pgBackRest 2.60.0'; \
    patroni --version | grep -q '4.1.5'; \
    install -d -o postgres -g postgres -m 0750 /var/spool/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest \
      /var/lib/scf-metrics; \
    install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/18; \
    install -d -m 0755 /etc/scf

# age (BSD-3-Clause) for the weekly logical dump, built from the v1.3.2 source with the repository's Go toolchain
# (1.27.4, same builder image as the Go services) — Debian's package and the upstream binary carry Go standard-library
# findings. Module downloads are verified against go.sum and the Go checksum database; static, no cgo.
COPY --from=age-build /out/age /out/age-keygen /usr/local/bin/

COPY --chmod=0755 postgres/entrypoint.sh /usr/local/bin/scf-pg-entrypoint
COPY --chmod=0755 postgres/callback.sh /usr/local/bin/scf-pg-callback
COPY --chmod=0755 postgres/post-bootstrap.sh /usr/local/bin/scf-post-bootstrap
COPY --chmod=0755 postgres/healthcheck.sh /usr/local/bin/scf-pg-healthcheck
COPY --chmod=0644 postgres/patroni.yml /etc/scf/patroni.yml
COPY --chmod=0755 bin/ /usr/local/bin/

ENV PGDATA=/var/lib/postgresql/18/main
USER postgres
ENTRYPOINT ["/usr/local/bin/scf-pg-entrypoint"]
