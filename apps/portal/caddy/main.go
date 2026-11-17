// SPDX-License-Identifier: Apache-2.0

// Command caddy is the portal's web server: upstream Caddy v2.11.9 with only the modules that
// apps/portal/server/Caddyfile uses, built from source with the pinned Go toolchain (apps/portal/Dockerfile).
//
// Why not the official image's binary: it is built with an older Go and older golang.org/x/net and
// klauspost/compress releases that carry reachable HIGH advisories (govulncheck -mode=binary, 2026-11-13). This module
// pins the fixed releases in go.mod; go.sum and the Go checksum database verify every byte. Upstream Caddy code is not
// modified. Only the HTTP handlers the Caddyfile uses are linked (no templates, ACME server, encoders, tracing, …).
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	_ "github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	_ "github.com/caddyserver/caddy/v2/modules/caddyhttp"
	_ "github.com/caddyserver/caddy/v2/modules/caddyhttp/fileserver"
	_ "github.com/caddyserver/caddy/v2/modules/caddyhttp/headers"
	_ "github.com/caddyserver/caddy/v2/modules/caddyhttp/requestbody"
	_ "github.com/caddyserver/caddy/v2/modules/caddyhttp/reverseproxy"
	_ "github.com/caddyserver/caddy/v2/modules/caddyhttp/rewrite"
	_ "github.com/caddyserver/caddy/v2/modules/logging"
)

func main() { caddycmd.Main() }
