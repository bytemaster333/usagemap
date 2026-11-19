#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Claude Code without editing .mcp.json: registers the same server for your user (all projects).
claude mcp add usagemap --scope user \
  -e USAGEMAP_API_URL=https://app.usagemap.dev \
  -e USAGEMAP_SHARE_KEY_FILE=/path/to/usagemap-share.key \
  -- node /path/to/usagemap/tools/mcp/server.ts
