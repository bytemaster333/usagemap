#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The other commands of the plugin, for copying (not a script to run as a whole).
stellar scf route '/accounts/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H/payments?cursor=1'
# → /accounts/{account}/payments   (the input is never echoed back)
stellar scf init --site YOUR_22_CHAR_SITE_KEY --service my-api   # pinned <script> + OpenTelemetry variables
stellar scf test --service my-api --dry-run                      # the portal's test curl, nothing sent
USAGEMAP_INGEST_TOKEN=scfa_ing_… stellar scf test --service my-api  # sends it
