// SPDX-License-Identifier: Apache-2.0
// The portal's security headers — the single source for the Caddy configuration (generated into
// server/headers-<scheme>.caddy by scripts/gen-caddy.ts) and for the test servers, so the browser tests run under
// exactly the production policy (docs/security/hardening.md §10, ADR-0024).
//
// The portal and the control-plane API share one origin: Caddy serves the SPA and reverse-proxies /v1/* and
// /public/* to the control plane. `connect-src 'self'` therefore *is* "the control-plane origin" and nothing else.
// The ingest hosts are not listed: the portal does not embed the tracker yet (dog-fooding lands with the tracker
// release wiring); adding them is a reviewed change of this file.
// Exception (plan D-5, wire-formats §m.2 step 4): the public /verify page may look a seal transaction up on Stellar's
// public Horizon — only when the reader clicks for it, only the origins below (src/lib/seal.ts HORIZON_ORIGINS must
// list the same), with `credentials: "omit"` and no referrer.

export type Scheme = "http" | "https";

/** Horizon origins the /verify page may contact (kept equal to src/lib/seal.ts HORIZON_ORIGINS by a unit test). */
export const SEAL_HORIZON_ORIGINS = [
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
] as const;

/** CSP directives in order. No inline script or style, no eval, Trusted Types enforced and no policy may be created. */
export function cspDirectives(scheme: Scheme): string[] {
  const d = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${SEAL_HORIZON_ORIGINS.join(" ")}`,
    "manifest-src 'self'",
    "worker-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ];
  // Over plain HTTP (local Compose on localhost) upgrading would break every request.
  if (scheme === "https") d.push("upgrade-insecure-requests");
  return d;
}

/**
 * Powerful features are all disabled except WebAuthn (passkeys: sign-in step-up and recent authentication, C-09/C-87)
 * and clipboard writes (the snippet page's copy button), which are limited to our own origin.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
  "clipboard-read=()",
  "clipboard-write=(self)",
  "publickey-credentials-create=(self)",
  "publickey-credentials-get=(self)",
].join(", ");

/** Headers sent on every response of the portal origin (documents, assets and proxied API answers). */
export function securityHeaders(scheme: Scheme): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Security-Policy": cspDirectives(scheme).join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Origin-Agent-Cluster": "?1",
  };
  if (scheme === "https") h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  return h;
}

/** Cache policy by path class: hashed assets are immutable, the HTML shell and API answers are never stored. */
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
export const CACHE_NONE = "no-store";
