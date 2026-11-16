// SPDX-License-Identifier: Apache-2.0
// The internal edge API (wire-formats §e.1, §l; C-60): `GET /internal/v1/edge/snapshot` and
// `POST /internal/v1/edge/counters`, served on a SEPARATE listener that is reachable only from the engine proxies.
//
// Node identity: the engine proxy terminates the edge node's mutual TLS, checks its allow-list, removes any incoming
// copy of the node header and sets it to the node id of the verified client certificate (C-113). The header is
// therefore trusted only from an authenticated engine proxy (C-114):
// - mutual TLS (the default, SCF_INTERNAL_TLS_*): the connection must carry a client certificate issued by the
//   configured CA whose CN is one of SCF_INTERNAL_ALLOWED_CLIENTS;
// - plain HTTP is allowed only when the listener is bound to loopback (configuration refuses anything else), and then
//   only requests whose peer is a loopback address may name a node.

import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "../db/database.ts";
import { ApiError } from "../http/problem.ts";
import { applyCounterRecord, parseCounterRecord } from "./counters.ts";
import { NODE_NAME_RE } from "./node.ts";

export { NODE_NAME_RE };

export interface InternalDeps {
  db: Database;
  nodeHeader: string;
  /** CNs of allowed proxy client certificates when the listener runs TLS; undefined = loopback plain-HTTP listener. */
  allowedClients: string[] | undefined;
}

function loopbackPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return (isIP(v4) === 4 && v4.startsWith("127.")) || addr === "::1";
}

function nodeOf(req: FastifyRequest, deps: InternalDeps): string {
  if (deps.allowedClients) {
    const sock = req.raw.socket as TLSSocket;
    const cert =
      typeof sock.getPeerCertificate === "function" ? sock.getPeerCertificate() : undefined;
    const cn = cert?.subject?.CN;
    if (!sock.authorized || typeof cn !== "string" || !deps.allowedClients.includes(cn)) {
      throw new ApiError("unauthenticated");
    }
  } else if (!loopbackPeer(req.raw.socket.remoteAddress)) {
    throw new ApiError("unauthenticated");
  }
  const raw = req.headers[deps.nodeHeader];
  const node = Array.isArray(raw) ? undefined : raw;
  if (!node || !NODE_NAME_RE.test(node)) throw new ApiError("unauthenticated");
  return node;
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalDeps): void {
  app.get("/internal/v1/edge/snapshot", async (req, reply) => {
    const node = nodeOf(req, deps);
    const row = await deps.db.tx(
      { tenantId: null, actorKind: "system", actorId: node, requestId: req.id },
      (tx) =>
        tx.maybeOne<{ seq: string; envelope: Buffer }>(
          `SELECT s.sequence::text AS seq, s.envelope FROM scf.edge_snapshots s ORDER BY s.sequence DESC LIMIT 1`,
        ),
    );
    if (!row) throw new ApiError("unavailable", "no snapshot issued yet", { retryAfter: 10 });
    const etag = `"${row.seq}"`;
    reply.header("etag", etag).header("cache-control", "no-store");
    if (req.headers["if-none-match"] === etag) {
      await reply.code(304).send();
      return;
    }
    await reply.code(200).type("application/json").send(row.envelope);
  });

  app.post("/internal/v1/edge/counters", async (req, reply) => {
    const node = nodeOf(req, deps);
    const rec = parseCounterRecord(req.body);
    if (rec.node_id !== node)
      throw new ApiError("unauthenticated", "node_id does not match the caller");
    const res = await applyCounterRecord(deps.db, rec, req.id);
    req.log.info(
      { node, parts: res.appliedParts, duplicate: res.duplicate, skipped_rows: res.skippedRows },
      "edge counters",
    );
    await reply.code(200).send();
  });
}
