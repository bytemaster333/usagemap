// SPDX-License-Identifier: Apache-2.0
// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00; MCP authorization 2026-07-28
// "Client Registration": SHOULD for authorization servers). A client_id that is an https URL with a path is fetched
// once through the SSRF-safe fetcher of the domain verifier (public addresses only, port 443, no redirects, size and
// time bounds), validated (client_id equal to the URL, public client, redirect URIs per src/oauth/rules.ts) and stored
// as an `oauth_clients` row of kind `cimd`; it is fetched again when the stored copy is older than CIMD_TTL_MS.

import type { TextFetcher } from "../verify/verifier.ts";
import { validateClientMetadata } from "./rules.ts";

export const CIMD_TTL_MS = 24 * 3_600_000;

export type CimdResult =
  | { ok: true; clientName: string; clientUri: string | null; redirectUris: string[] }
  | { ok: false; description: string };

export async function fetchClientMetadata(
  fetcher: TextFetcher,
  clientId: string,
): Promise<CimdResult> {
  const u = new URL(clientId);
  const r = await fetcher.fetchText(u.hostname, `${u.pathname}${u.search}`);
  if (r.kind !== "ok")
    return {
      ok: false,
      description: `the client metadata document could not be fetched (${r.code})`,
    };
  let doc: unknown;
  try {
    doc = JSON.parse(r.body);
  } catch {
    return { ok: false, description: "the client metadata document is not JSON" };
  }
  const v = validateClientMetadata(doc, clientId);
  if (!v.ok) return { ok: false, description: v.description };
  return {
    ok: true,
    clientName: v.clientName,
    clientUri: v.clientUri,
    redirectUris: v.redirectUris,
  };
}
