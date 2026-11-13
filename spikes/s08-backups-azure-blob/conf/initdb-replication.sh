#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Runs once at initdb (official image hook): allow streaming replication over the compose network.
set -euo pipefail
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPLICATOR_PASSWORD:?}'"
