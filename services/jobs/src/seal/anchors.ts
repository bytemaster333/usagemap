// SPDX-License-Identifier: Apache-2.0
// Publishing the sealed audit-anchor documents (migration 0077; wire-formats §m.1, §m.2; plan A2, "verify this
// number"). A day's seal commits to the sha256 of that day's audit-anchor document (the audit leaf), and that document
// fixes the head of every audit chain — the platform chain, which holds every operator action, included. Until now the
// document lived only in the jobs service's directory, so a reader could see THAT a hash was sealed but not WHICH chain
// heads it fixes. Job daily_seal now copies, for every built day of its network, the exact document it sealed into
// `scf.sealed_audit_anchors` (served at `GET /public/v1/audit-anchors/{day}`), and only when the file still hashes to
// the sealed value: a file rewritten after the day was sealed is never published and is reported instead
// (`seal_anchor_mismatch`, a failed run). Rows are never changed (trigger), so the published copy is the sealed one.

import type { AnchorDocument } from "../audit/anchor.ts";
import type { ScfDb } from "../db.ts";
import type { JobContext } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import type { SealNetwork } from "./merkle.ts";

const JOB = "daily_seal" as const;

export interface AnchorPublishResult {
  /** days whose sealed document was stored in this run */
  published: string[];
  /** days whose anchor file no longer hashes to the sealed value (never published) */
  mismatched: string[];
  /** days whose anchor file is missing (never published until it is back) */
  missing: string[];
}

/** Whether a document is the one a seal day committed to (pure). */
export function isSealedDocument(doc: AnchorDocument, day: string, sealedSha256: Buffer): boolean {
  return (
    doc.date === day &&
    /^[0-9a-f]{64}$/.test(doc.sha256) &&
    Buffer.from(doc.sha256, "hex").equals(sealedSha256)
  );
}

/**
 * Stores the sealed anchor document of every built day of `network` that has none yet (ascending). `read` returns the
 * day's document after checking its own hash (readAnchor), or null when the file is missing.
 */
export async function publishSealedAnchors(
  db: ScfDb,
  network: SealNetwork,
  read: (day: string) => Promise<AnchorDocument | null>,
  ctx: JobContext,
): Promise<AnchorPublishResult> {
  const res: AnchorPublishResult = { published: [], mismatched: [], missing: [] };
  const days = await db.tx(JOB, null, (tx) =>
    tx.query<{ day: string; audit_anchor_sha256: Buffer }>(
      `SELECT d.day::text AS day, d.audit_anchor_sha256 FROM scf.seal_days d
        WHERE d.network = $1
          AND NOT EXISTS (SELECT 1 FROM scf.sealed_audit_anchors a WHERE a.day = d.day)
        ORDER BY d.day`,
      [network],
    ),
  );
  for (const d of days) {
    checkAborted(ctx.signal);
    let doc: AnchorDocument | null;
    try {
      doc = await read(d.day);
    } catch {
      // the file fails its own hash (or is unreadable): never published
      res.mismatched.push(d.day);
      ctx.log.error("seal_anchor_mismatch", { job: JOB, network, day: d.day, reason: "corrupt" });
      continue;
    }
    if (doc === null) {
      res.missing.push(d.day);
      ctx.log.warn("seal_anchor_unavailable", { job: JOB, network, day: d.day });
      continue;
    }
    if (!isSealedDocument(doc, d.day, d.audit_anchor_sha256)) {
      res.mismatched.push(d.day);
      ctx.log.error("seal_anchor_mismatch", { job: JOB, network, day: d.day, reason: "hash" });
      continue;
    }
    await db.tx(JOB, null, (tx) =>
      tx.exec(
        `INSERT INTO scf.sealed_audit_anchors (day, sha256, document) VALUES ($1::date, $2, $3::jsonb)
         ON CONFLICT (day) DO NOTHING`,
        [d.day, d.audit_anchor_sha256, JSON.stringify(doc)],
      ),
    );
    res.published.push(d.day);
  }
  if (res.published.length > 0)
    ctx.log.info("seal_anchors_published", {
      job: JOB,
      network,
      days: res.published.length,
      first: res.published[0] ?? null,
      last: res.published.at(-1) ?? null,
    });
  return res;
}
