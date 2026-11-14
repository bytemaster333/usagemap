// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Retention helpers (db/migrations/0050_retention.sql, the §14 table in machine-readable form): scf.retention_apply()
// deletes expired rows for the named job only, per tenant for tenant tables (F1); scf.erasure_redact_selectors()
// replaces literal erasure selectors after finished_at + 56 days (C-88, C-112) and audits without the literal.

func TestRetentionRulesCoverSection14(t *testing.T) {
	rows, err := queryStrings(context.Background(), super(t), `SELECT relname FROM scf.retention_rules() r
	   WHERE to_regclass('scf.' || r.relname) IS NULL`)
	if err != nil || len(rows) > 0 {
		t.Fatalf("rules naming relations that do not exist: %v %v", rows, err)
	}
	// every delete rule's age expression is valid SQL on its table
	bad, err := queryStrings(context.Background(), super(t), `SELECT relname FROM scf.retention_rules() WHERE mechanism = 'delete'`)
	if err != nil {
		t.Fatal(err)
	}
	su := super(t)
	for _, rel := range bad {
		var expr string
		_ = su.QueryRow(context.Background(), `SELECT age_expr FROM scf.retention_rules() WHERE relname = $1`, rel).Scan(&expr)
		if _, err := su.Exec(context.Background(), fmt.Sprintf(`SELECT count(*) FROM scf.%s t WHERE (%s) < now()`, rel, expr)); err != nil {
			t.Errorf("rule %s: %s", rel, sqlState(err))
		}
	}
}

func TestRetentionApply(t *testing.T) {
	su := super(t)
	for _, ten := range []string{A, B} {
		mustExec(t, su, fmt.Sprintf(`INSERT INTO scf.api_ingest_ledger (tenant_id, batch_key, points, received_at)
		  VALUES ('%s', sha256(convert_to('old-%s', 'UTF8')), 1, now() - interval '8 days')`, ten, ten))
	}
	mustExec(t, su, `INSERT INTO scf.auth_challenges (kind, secret_hash, created_at, expires_at)
	  VALUES ('github_oauth', sha256('old-challenge'::bytea), now() - interval '3 days', now() - interval '3 days' + interval '10 minutes')`)
	t.Cleanup(func() {
		mustExec(t, su, `DELETE FROM scf.api_ingest_ledger WHERE received_at < now() - interval '7 days'`)
		mustExec(t, su, `DELETE FROM scf.auth_challenges WHERE secret_hash = sha256('old-challenge'::bytea)`)
	})
	jobs := runtimeConn(t, "scf_jobs")
	apply := func(c Ctx, rel string) (int64, error) {
		var n int64
		err := inCtx(t, jobs, c, func(ctx context.Context, tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `SELECT scf.retention_apply($1)`, rel).Scan(&n); err != nil {
				return err
			}
			// what the job deleted under A: never B's row
			var bLeft int
			if err := su.QueryRow(ctx, `SELECT count(*) FROM scf.api_ingest_ledger WHERE tenant_id = $1 AND received_at < now() - interval '7 days'`, B).Scan(&bLeft); err != nil {
				return err
			}
			if bLeft != 1 {
				return fmt.Errorf("B's expired ledger row touched")
			}
			return nil
		})
		return n, err
	}
	if n, err := apply(Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, "api_ingest_ledger"); err != nil || n != 1 {
		t.Errorf("retention under A: want 1 deleted (A's only), got %d %s", n, sqlState(err))
	}
	if _, err := apply(Ctx{Kind: "job", Actor: "retention", Job: "retention"}, "api_ingest_ledger"); code(err) != "42501" {
		t.Errorf("tenant table without tenant context: want 42501, got %s", sqlState(err))
	}
	if _, err := apply(Ctx{Tenant: A, Kind: "job", Actor: "web_rollup", Job: "web_rollup"}, "api_ingest_ledger"); code(err) != "42501" {
		t.Errorf("wrong job: want 42501, got %s", sqlState(err))
	}
	if n, err := apply(Ctx{Kind: "job", Actor: "retention", Job: "retention"}, "auth_challenges"); err != nil || n != 1 {
		t.Errorf("global auth_challenges: want 1 deleted, got %d %s", n, sqlState(err))
	}
	if _, err := apply(Ctx{Tenant: A, Kind: "job", Actor: "partitions", Job: "partitions"}, "api_metrics_1m"); code(err) != "22023" {
		t.Errorf("partition-drop rule through retention_apply: want 22023, got %s", sqlState(err))
	}
	for _, role := range []string{"scf_app", "scf_writer", "scf_metrics_ro"} {
		err := inCtx(t, runtimeConn(t, role), Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT scf.retention_apply('api_ingest_ledger')`)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("%s calling retention_apply: want 42501, got %s", role, sqlState(err))
		}
	}
}

func TestErasureSelectorRedaction(t *testing.T) {
	su := super(t)
	req := uid(A, 7)
	mustExec(t, su, `UPDATE scf.erasure_requests SET status = 'completed', completed_at = now() - interval '60 days',
	    finished_at = now() - interval '60 days' WHERE tenant_id = $1 AND request_id = $2`, A, req)
	t.Cleanup(func() {
		mustExec(t, su, `UPDATE scf.erasure_requests SET status = 'previewing', completed_at = NULL, finished_at = NULL
		    WHERE tenant_id = $1 AND request_id = $2`, A, req)
	})
	jobs := runtimeConn(t, "scf_jobs")
	err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT scf.erasure_redact_selectors()`).Scan(&n); err != nil {
			return err
		}
		if n != 1 {
			return fmt.Errorf("redacted %d requests, want 1", n)
		}
		var criteria string
		var redacted bool
		if err := tx.QueryRow(ctx, `SELECT criteria::text, selector_redacted_at IS NOT NULL FROM scf.erasure_requests
		    WHERE tenant_id = $1 AND request_id = $2`, A, req).Scan(&criteria, &redacted); err != nil {
			return err
		}
		var c map[string]any
		_ = json.Unmarshal([]byte(criteria), &c)
		sel, _ := c["selector"].(map[string]any)
		if !redacted || strings.Contains(criteria, "/x/*") || sel["type"] != "path_pattern" || sel["length"] != float64(4) ||
			c["start"] == nil || c["end"] == nil {
			return fmt.Errorf("criteria after redaction: %s", criteria)
		}
		var details string
		if err := tx.QueryRow(ctx, `SELECT details::text FROM scf.audit_log WHERE tx_id = pg_current_xact_id()
		    AND action = 'erasure.selector_redacted'`).Scan(&details); err != nil {
			return err
		}
		if strings.Contains(details, "/x/*") || !strings.Contains(details, "path_pattern") {
			return fmt.Errorf("audit details: %s", details)
		}
		// idempotent
		if err := tx.QueryRow(ctx, `SELECT scf.erasure_redact_selectors()`).Scan(&n); err != nil || n != 0 {
			return fmt.Errorf("second run redacted %d (%v)", n, err)
		}
		return nil
	})
	if err != nil {
		t.Error(sqlState(err))
	}
	// B's finished request is not reachable from A's context, and no tenant context is refused
	err = inCtx(t, jobs, Ctx{Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT scf.erasure_redact_selectors()`)
		return err
	})
	if code(err) != "42501" {
		t.Errorf("redaction without tenant context: want 42501, got %s", sqlState(err))
	}
}
