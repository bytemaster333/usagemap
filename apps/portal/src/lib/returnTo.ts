// SPDX-License-Identifier: Apache-2.0
// `return_to` (C-114): only a same-origin path — it starts with a single "/", contains no backslash and no control
// character. The control plane enforces the same rule; the portal applies it before it ever builds a sign-in link or
// navigates after sign-in, so an attacker-supplied value cannot turn the portal into an open redirect.

const MAX = 2048;

export function safeReturnTo(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\")) return fallback;
  // C0 controls, DEL and C1 controls
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return fallback;
  }
  // Never send the person back into the sign-in flow itself.
  if (value === "/signin" || value.startsWith("/signin?") || value.startsWith("/signin/"))
    return fallback;
  return value;
}
