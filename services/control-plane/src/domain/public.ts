// SPDX-License-Identifier: Apache-2.0
// Public, unauthenticated reads: published thresholds (data-model §7.1: only rows marked public) and the released
// tracker versions with their SRI hashes (ADR-0004).

import type { Handler } from "../http/pipeline.ts";
import type { TrackerRegistry } from "../tracker.ts";

export function publicHandlers(deps: { tracker: TrackerRegistry }) {
  const getPublishedThresholds: Handler = async (ctx) => {
    const rows = await ctx.tx(
      (tx) =>
        tx.query<{
          key: string;
          value: unknown;
          description: string;
          public: boolean;
          updated_at: Date;
        }>(
          `SELECT key, value, description, public, updated_at FROM scf.settings WHERE public ORDER BY key`,
        ),
      { tenantId: null, actorKind: "anonymous", actorId: null },
    );
    return {
      status: 200,
      body: rows.map((r) => ({ ...r, updated_at: r.updated_at.toISOString() })),
      headers: { "cache-control": "public, max-age=300" },
    };
  };

  const listTrackerVersions: Handler = async () => ({
    status: 200,
    body: deps.tracker.versions(),
    headers: { "cache-control": "public, max-age=300" },
  });

  return { getPublishedThresholds, listTrackerVersions };
}
