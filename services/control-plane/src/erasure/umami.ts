// SPDX-License-Identifier: Apache-2.0
// Erasure in the `umami` database (data-model §16.1, §16.2) as `scf_umami_maint`: DELETE on website_event, event_data,
// revenue, session, session_data, session_link, plus SELECT on exactly the columns the WHERE clauses below read.
// Nothing else. `revenue`: Umami 3.5.0's saveEvent writes a revenue row (website, session,
// event id, event name, currency, amount) whenever an event's data carries a numeric `revenue` > 0 and a non-empty
// `currency`; it goes with its event, and with a `revenue` or `currency` property-key selector. Its rows are counted
// in `event_data_rows` (they are derived from the event's data; ErasureCounts has no field of its own for them).
//
// Why SQL and not the adapter/engine proxy: Umami 3.5.0 has no API that deletes events selectively (only whole
// websites, `DELETE /api/websites/{id}`, or a full reset), so selective erasure can only be done in SQL. This module is
// the one place that does it; the website ids it receives were read under the requesting tenant's context (C-87), so it
// can only touch that tenant's main and twin websites (C-73). Column names are those of Umami v3.5.0 (pinned by the
// contract tests, C-69).

import type pg from "pg";
import { type Counts, globToLike, type Range, type Selector, zeroCounts } from "./criteria.ts";

export interface UmamiTarget {
  websiteIds: string[];
  range: Range;
  selector: Selector | null;
}

/** WHERE clause on `website_event` alias `a` matching the target; parameters $1 websites, $2 start, $3 end, $4 value. */
function eventPredicate(a: string, sel: Selector | null): string {
  const base = `${a}.website_id = ANY ($1::uuid[]) AND ${a}.created_at >= $2 AND ${a}.created_at < $3`;
  if (!sel) return base;
  if (sel.type === "path_pattern") return `${base} AND ${a}.url_path LIKE $4 ESCAPE '\\'`;
  if (sel.type === "event_name") return `${base} AND ${a}.event_name = $4`;
  return "false"; // a property-key selector deletes event_data rows only, never events
}

function params(t: UmamiTarget): unknown[] {
  const p: unknown[] = [t.websiteIds, t.range.start, t.range.end];
  if (t.selector)
    p.push(t.selector.type === "path_pattern" ? globToLike(t.selector.value) : t.selector.value);
  return p;
}

const n = (v: unknown): number => Number(v ?? 0);

/** Property keys whose values Umami copies into its `revenue` table. */
const REVENUE_KEYS = new Set(["revenue", "currency"]);

/** One batch never runs longer than this (Umami's own statements are capped at 30 s, C-112(6)). */
export const STATEMENT_TIMEOUT_MS = 120_000;

export class UmamiEraser {
  readonly #pool: pg.Pool;
  readonly #batch: number;

  readonly #timeoutMs: number;

  constructor(pool: pg.Pool, opts: { batchSize?: number; statementTimeoutMs?: number } = {}) {
    this.#pool = pool;
    this.#batch = opts.batchSize ?? 5_000;
    this.#timeoutMs = opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  }

  /**
   * One statement in its own transaction with a transaction-local `statement_timeout`: the pool reaches PostgreSQL
   * through PgBouncer in transaction mode, which refuses `statement_timeout` as a startup parameter (08P01) and would
   * leak a session `SET` to other clients (C-103, C-119). Batches stay short, as before.
   */
  async #q(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(this.#timeoutMs)}`);
      const r = await client.query(sql, params);
      await client.query("COMMIT");
      return r;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  /** Count-only preview: nothing is changed. */
  async preview(t: UmamiTarget): Promise<Counts> {
    const c = zeroCounts();
    if (t.websiteIds.length === 0) return c;
    const p = params(t);
    if (t.selector?.type === "property_key") {
      const r = await this.#q(
        `SELECT count(*) AS rows, array_agg(DISTINCT (d.created_at AT TIME ZONE 'UTC')::date::text) AS days
           FROM event_data d
          WHERE d.website_id = ANY ($1::uuid[]) AND d.created_at >= $2 AND d.created_at < $3 AND d.data_key = $4`,
        p,
      );
      c.event_data_rows = n(r.rows[0]?.rows);
      if (REVENUE_KEYS.has(t.selector.value)) {
        const rv = await this.#q(
          `SELECT count(*) AS rows FROM revenue r
            WHERE r.website_id = ANY ($1::uuid[]) AND r.created_at >= $2 AND r.created_at < $3`,
          p.slice(0, 3),
        );
        c.event_data_rows += n(rv.rows[0]?.rows);
      }
      c.aggregate_days = ((r.rows[0]?.days as string[] | null) ?? []).filter(Boolean).sort();
      return c;
    }
    const pred = eventPredicate("e", t.selector);
    const r = await this.#q(
      `SELECT count(*) AS events,
              array_agg(DISTINCT (e.created_at AT TIME ZONE 'UTC')::date::text) AS days,
              (SELECT count(*) FROM event_data d
                WHERE d.website_id = ANY ($1::uuid[])
                  AND d.website_event_id IN (SELECT e2.event_id FROM website_event e2 WHERE ${eventPredicate("e2", t.selector)}))
              + (SELECT count(*) FROM revenue rv
                  WHERE rv.website_id = ANY ($1::uuid[])
                    AND rv.event_id IN (SELECT e4.event_id FROM website_event e4 WHERE ${eventPredicate("e4", t.selector)})) AS data_rows,
              (SELECT count(DISTINCT e3.session_id) FROM website_event e3
                WHERE ${eventPredicate("e3", t.selector)}
                  AND NOT EXISTS (SELECT 1 FROM website_event o
                                   WHERE o.session_id = e3.session_id
                                     AND NOT COALESCE((${eventPredicate("o", t.selector)}), false))) AS sessions
         FROM website_event e WHERE ${pred}`,
      p,
    );
    const row = r.rows[0] ?? {};
    c.website_events = n(row.events);
    c.event_data_rows = n(row.data_rows);
    c.sessions_orphaned = n(row.sessions);
    c.aggregate_days = ((row.days as string[] | null) ?? []).filter(Boolean).sort();
    return c;
  }

  /**
   * Deletes in batches (no long transaction; Umami's own reset hits its 30 s limit, §3 step 5): per batch the events'
   * event_data rows and the events, then the sessions of that batch left without any event (with their defensive
   * session_data/session_link rows). Idempotent: a re-run deletes only what is still there. `onBatch` runs after every
   * batch (the worker renews its claim there and may abort the run by throwing).
   */
  async erase(t: UmamiTarget, opts: { onBatch?: () => Promise<void> } = {}): Promise<Counts> {
    const c = zeroCounts();
    if (t.websiteIds.length === 0) return c;
    const p = params(t);
    const days = new Set<string>();
    if (t.selector?.type === "property_key") {
      // event_data has no column we may batch on besides the time: one day per statement.
      for (let d = dayStart(t.range.start); d < t.range.end.getTime(); d += 86_400_000) {
        const s = new Date(Math.max(d, t.range.start.getTime()));
        const e = new Date(Math.min(d + 86_400_000, t.range.end.getTime()));
        const r = await this.#q(
          `DELETE FROM event_data d
            WHERE d.website_id = ANY ($1::uuid[]) AND d.created_at >= $2 AND d.created_at < $3 AND d.data_key = $4`,
          [t.websiteIds, s, e, p[3]],
        );
        if ((r.rowCount ?? 0) > 0) days.add(new Date(d).toISOString().slice(0, 10));
        c.event_data_rows += r.rowCount ?? 0;
        if (REVENUE_KEYS.has(t.selector.value)) {
          const rv = await this.#q(
            `DELETE FROM revenue r WHERE r.website_id = ANY ($1::uuid[]) AND r.created_at >= $2 AND r.created_at < $3`,
            [t.websiteIds, s, e],
          );
          if ((rv.rowCount ?? 0) > 0) days.add(new Date(d).toISOString().slice(0, 10));
          c.event_data_rows += rv.rowCount ?? 0;
        }
        await opts.onBatch?.();
      }
      c.aggregate_days = [...days].sort();
      return c;
    }
    const pred = eventPredicate("e", t.selector);
    for (;;) {
      const r = await this.#q(
        `WITH ids AS (SELECT e.event_id, e.session_id, e.created_at FROM website_event e WHERE ${pred} LIMIT ${this.#batch}),
              dd AS (DELETE FROM event_data d
                      WHERE d.website_id = ANY ($1::uuid[]) AND d.website_event_id IN (SELECT event_id FROM ids)
                      RETURNING 1),
              dr AS (DELETE FROM revenue r
                      WHERE r.website_id = ANY ($1::uuid[]) AND r.event_id IN (SELECT event_id FROM ids)
                      RETURNING 1),
              de AS (DELETE FROM website_event x WHERE x.event_id IN (SELECT event_id FROM ids)
                      RETURNING x.session_id, x.created_at)
         SELECT (SELECT count(*) FROM dd) + (SELECT count(*) FROM dr) AS data_rows, (SELECT count(*) FROM de) AS events,
                (SELECT array_agg(DISTINCT session_id) FROM de) AS sessions,
                (SELECT array_agg(DISTINCT (created_at AT TIME ZONE 'UTC')::date::text) FROM de) AS days`,
        p,
      );
      const row = r.rows[0] ?? {};
      const events = n(row.events);
      c.website_events += events;
      c.event_data_rows += n(row.data_rows);
      for (const d of (row.days as string[] | null) ?? []) days.add(d);
      const sessions = (row.sessions as string[] | null) ?? [];
      if (sessions.length > 0)
        c.sessions_orphaned += await this.#dropOrphans(t.websiteIds, sessions);
      await opts.onBatch?.();
      if (events < this.#batch) break;
    }
    if (!t.selector) {
      // Whole range without a selector: also the defensive rows of the range (expected empty: identify is never
      // forwarded, §16.2).
      await this.#q(
        `DELETE FROM session_data s WHERE s.website_id = ANY ($1::uuid[]) AND s.created_at >= $2 AND s.created_at < $3`,
        p,
      );
      await this.#q(
        `DELETE FROM session_link s WHERE s.website_id = ANY ($1::uuid[]) AND s.created_at >= $2 AND s.created_at < $3`,
        p,
      );
    }
    c.aggregate_days = [...days].sort();
    return c;
  }

  async #dropOrphans(websites: string[], sessions: string[]): Promise<number> {
    const orphan = `s.website_id = ANY ($1::uuid[]) AND s.session_id = ANY ($2::uuid[])
                    AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id)`;
    await this.#q(`DELETE FROM session_data s WHERE ${orphan}`, [websites, sessions]);
    await this.#q(`DELETE FROM session_link s WHERE ${orphan}`, [websites, sessions]);
    const r = await this.#q(`DELETE FROM session s WHERE ${orphan}`, [websites, sessions]);
    return r.rowCount ?? 0;
  }
}

function dayStart(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
