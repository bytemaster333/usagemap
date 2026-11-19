// SPDX-License-Identifier: Apache-2.0
// Mock answer of getSiteBrowserRpc (tracker 1.2.0, migration 0086) for the portal's browser tests: the wallet site of
// the docs tenant has FAKE browser RPC/Horizon calls (test/fixtures/browser-rpc.ts), every other site none. It follows
// the contract where the portal depends on it: members of the site's tenant only (404 otherwise, C-87), whole UTC days
// of at most 400, the variant echoed. Every JSON body is validated against the OpenAPI document by the server.

import type { IncomingMessage } from "node:http";
import { browserRpcFixture, emptyBrowserRpc } from "../../test/fixtures/browser-rpc.ts";
import { type Answer, MockProblem } from "./mock-extra.ts";

type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
}) => Answer;

/** The docs tenant's wallet site (fixtures/web.ts). */
export const BROWSER_RPC_SITE = "b0000000-0000-4000-8000-000000000002";
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$/;
const invalid = (pointer: string, detail: string) =>
  new MockProblem(400, "validation_failed", "Invalid request", { errors: [{ pointer, detail }] });

export function browserRpcHandlers(c: {
  /** Throws the 404 of the contract unless the session's user is a member of the site's tenant. */
  site(req: IncomingMessage, tenantId: string, siteId: string): void;
}): Record<string, Handler> {
  return {
    getSiteBrowserRpc: ({ req, q, p }) => {
      c.site(req, p.tenantId as string, p.siteId as string);
      const start = q.get("start") ?? "";
      const end = q.get("end") ?? "";
      if (!DAY_RE.test(start)) throw invalid("/start", "must be a UTC midnight");
      if (!DAY_RE.test(end) || end <= start) throw invalid("/end", "must be a later UTC midnight");
      if (Date.parse(end) - Date.parse(start) > 400 * 86_400_000)
        throw invalid("/end", "the range is at most 400 days");
      const variant = q.get("variant") === "raw" ? "raw" : "verified";
      const range = { start, end };
      return {
        status: 200,
        body:
          p.siteId === BROWSER_RPC_SITE
            ? browserRpcFixture(range, variant)
            : emptyBrowserRpc(range, variant),
      };
    },
  };
}
