# syntax=docker/dockerfile:1
# SPDX-License-Identifier: Apache-2.0
# S-08: PostgreSQL 18 + pgBackRest 2.60.0 (PGDG package) + WAL-G 3.0.9 (official release binary).
# postgres:18 pinned by the digest observed on 2026-11-12 (PG_VERSION=18.6-1.pgdg13+2, Debian trixie).
FROM postgres:18@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42

# pgBackRest from the PGDG apt repository that the official image already configures (trixie-pgdg).
# Pin the exact package version: Debian trixie main ships 2.55.1, which is below the 2.59.3 floor (C-29).
ARG PGBACKREST_VERSION=2.60.0-1.pgdg13+1
RUN apt-get update \
 && apt-get install -y --no-install-recommends "pgbackrest=${PGBACKREST_VERSION}" ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0750 /var/spool/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest \
 && install -d -o postgres -g postgres -m 0750 /etc/pgbackrest

# WAL-G fallback: official v3.0.9 release binary (Ubuntu 24.04 build), checksum from the release page.
ADD --checksum=sha256:444ce216230c254edef803e098a59a1746806da3e0d55671d7b0f0082db14ef4 \
    https://github.com/wal-g/wal-g/releases/download/v3.0.9/wal-g-pg-24.04-amd64.tar.gz /tmp/walg.tgz
RUN tar -xzf /tmp/walg.tgz -C /usr/local/bin && mv /usr/local/bin/wal-g-pg-24.04-amd64 /usr/local/bin/wal-g \
 && chmod 0755 /usr/local/bin/wal-g && rm /tmp/walg.tgz

COPY conf/initdb-replication.sh /docker-entrypoint-initdb.d/10-replication.sh
COPY scripts/entry-restore.sh /usr/local/bin/entry-restore.sh
RUN chmod 0755 /usr/local/bin/entry-restore.sh
