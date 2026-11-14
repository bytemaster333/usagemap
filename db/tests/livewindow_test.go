// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// scf.web_live_window_days() (docs/data-model.md §8.9, C-109, C-112(6)) on seeded data: clamp(floor(budget ÷
// daily_events), 1, LEAST(max_days, effective retention)), daily_events = max(28-day average, today's count projected
// to a full day). Run as job web_rollup under tenant A's context (it may write the rollups), rolled back.

func TestWebLiveWindowDays(t *testing.T) {
	site := uid(A, 1)
	cases := []struct {
		name      string
		perDay    int64 // events_raw on each of the last 28 complete days; -1 = no history
		today     int64 // events_raw in today's hourly rows; -1 = none
		retention any   // sites.event_retention_days
		want      int
	}{
		{"no history, no events today → 1", -1, -1, nil, 1},
		{"180k/day → 1", 180_000, -1, nil, 1},
		{"19k/day → 13", 19_000, -1, nil, 13},
		{"2.8k/day → 89", 2_800, -1, nil, 89},
		{"1k/day → capped at 90 (web_live_window_max_days)", 1_000, -1, nil, 90},
		{"zero events → upper bound 90", 0, -1, nil, 90},
		{"zero events, site retention 30 → 30", 0, -1, 30, 30},
		{"1k/day, site retention 45 → 45", 1_000, -1, 45, 45},
		{"surge today (C-112(6)) shrinks the window the same day", 1_000, 2_000_000, nil, 1},
	}
	conn := runtimeConn(t, "scf_jobs")
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := inCtx(t, conn, Ctx{Tenant: A, Kind: "job", Actor: "web_rollup", Job: "web_rollup"}, func(ctx context.Context, tx pgx.Tx) error {
				for _, s := range []string{`DELETE FROM scf.web_daily_totals WHERE tenant_id = $1 AND site_id = $2`,
					`DELETE FROM scf.web_hourly_totals WHERE tenant_id = $1 AND site_id = $2`} {
					if _, err := tx.Exec(ctx, s, A, site); err != nil {
						return err
					}
				}
				if c.perDay >= 0 {
					if _, err := tx.Exec(ctx, `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
					    pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces,
					    total_duration_s, events_raw, is_final, engine_version)
					  SELECT $1, $2, (now() AT TIME ZONE 'UTC')::date - d, 0, 0, 0, 0, 0, 0, 0, 0, 0, $3, true, 'umami/3.5.0'
					    FROM generate_series(1, 40) d`, A, site, c.perDay); err != nil { // 40 days: only the last 28 count
						return err
					}
					// an older outlier outside the 28-day window must not count
					if _, err := tx.Exec(ctx, `UPDATE scf.web_daily_totals SET events_raw = 100000000
					    WHERE tenant_id = $1 AND site_id = $2 AND day = (now() AT TIME ZONE 'UTC')::date - 35`, A, site); err != nil {
						return err
					}
				}
				if c.today >= 0 {
					if _, err := tx.Exec(ctx, `INSERT INTO scf.web_hourly_totals (tenant_id, site_id, hour_start, pageviews_verified,
					    pageviews_raw, pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, events_raw)
					  VALUES ($1, $2, date_trunc('day', now(), 'UTC'), 0, 0, 0, 0, 0, 0, $3)`, A, site, c.today); err != nil {
						return err
					}
				}
				if c.retention != nil {
					// event_retention_days is a tenant setting; umami_reconcile may UPDATE sites under the tenant's context
					if err := setCtx(ctx, tx, Ctx{Tenant: A, Kind: "job", Actor: "umami_reconcile", Job: "umami_reconcile"}); err != nil {
						return err
					}
					if _, err := tx.Exec(ctx, `UPDATE scf.sites SET event_retention_days = $3 WHERE tenant_id = $1 AND site_id = $2`,
						A, site, c.retention); err != nil {
						return err
					}
					if err := setCtx(ctx, tx, Ctx{Tenant: A, Kind: "job", Actor: "web_rollup", Job: "web_rollup"}); err != nil {
						return err
					}
				}
				var got int
				if err := tx.QueryRow(ctx, `SELECT scf.web_live_window_days($1, $2)`, A, site).Scan(&got); err != nil {
					return err
				}
				if got != c.want {
					return fmt.Errorf("live window: want %d, got %d", c.want, got)
				}
				return nil
			})
			if err != nil {
				t.Error(sqlState(err))
			}
		})
	}
	// another tenant's site is invisible under A's context: the function answers from nothing (no cap row → NULL)
	err := inCtx(t, runtimeConn(t, "scf_app"), Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		var got *int
		if err := tx.QueryRow(ctx, `SELECT scf.web_live_window_days($1, $2)`, B, uid(B, 1)).Scan(&got); err != nil {
			return err
		}
		if got != nil {
			return fmt.Errorf("B's site under A's context: want NULL, got %d", *got)
		}
		return nil
	})
	if err != nil {
		t.Error(sqlState(err))
	}
}
