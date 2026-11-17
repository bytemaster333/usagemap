#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Container health of a database node: Patroni's /health is 200 while PostgreSQL runs (primary or streaming standby).
exec curl -fsS -o /dev/null --max-time 3 --cacert /run/secrets/dcs_ca https://localhost:8008/health
