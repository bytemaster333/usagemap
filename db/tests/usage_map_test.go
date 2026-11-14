// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0075: Ecosystem Usage Map. Rows of unclaimed registry projects are readable by SCF operators only (op_usage_map,
// op_usage_map_project: audited, registry:read, small-count floor on distinct accounts); a tenant reads the rows of the
// projects it has a CONFIRMED registry link to and of the contracts they list — never another project's; job
// usage_map is the only writer; scf_metrics_ro and the public paths have nothing.
func TestUsageMap0075(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	const (
		pClaimed   = "0d000000-0000-7000-8000-0000000000b1" // tenant A holds a confirmed link
		pUnclaimed = "0d000000-0000-7000-8000-0000000000b2" // tenant B only a candidate link
	)
	var cidA string // tenant A's seeded declared contract, listed by pClaimed and verified below
	if err := su.QueryRow(ctx, `SELECT contract_id FROM scf.declared_contracts WHERE tenant_id = $1 LIMIT 1`, A).Scan(&cidA); err != nil {
		t.Fatal(err)
	}
	c2 := "C" + strings.Repeat("Q", 55) // listed by pClaimed, nobody's footprint
	c3 := "C" + strings.Repeat("R", 55) // listed by pUnclaimed only
	mustExec(t, su, `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded,
	    contract_ids, fetched_at, content_sha256, raw) VALUES
	  ($1, 'stellarlight', 'um-claimed', 'Usage claimed', true, ARRAY[$3, $4], now(), decode(repeat('b1', 32), 'hex'), '{}'),
	  ($2, 'stellarlight', 'um-unclaimed', 'Usage unclaimed', true, ARRAY[$5], now(), decode(repeat('b2', 32), 'hex'), '{}')`,
		pClaimed, pUnclaimed, cidA, c2, c3)
	mustExec(t, su, `INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status) VALUES
	    ($1, $3, ARRAY['registrable_domain'], 'confirmed'), ($2, $4, ARRAY['verified_contract'], 'candidate')`,
		A, B, pClaimed, pUnclaimed)
	mustExec(t, su, `UPDATE scf.declared_contracts SET status = 'verified', verified_role = 'deployer',
	    verified_by_evidence = $2, verified_at = now() WHERE tenant_id = $1 AND contract_id = $3`, A, uid(A, 12), cidA)
	t.Cleanup(func() {
		c := super(t)
		mustExec(t, c, `DELETE FROM scf.usage_map_days WHERE day >= '2026-11-01' AND day < '2026-11-20'`)
		mustExec(t, c, `DELETE FROM scf.usage_map_project_weekly WHERE registry_project_id = ANY($1::uuid[])`, []string{pClaimed, pUnclaimed})
		mustExec(t, c, `DELETE FROM scf.tenant_registry_links WHERE registry_project_id = ANY($1::uuid[])`, []string{pClaimed, pUnclaimed})
		mustExec(t, c, `DELETE FROM scf.registry_projects WHERE registry_project_id = ANY($1::uuid[])`, []string{pClaimed, pUnclaimed})
		mustExec(t, c, `UPDATE scf.declared_contracts SET status = 'declared', verified_role = NULL, verified_by_evidence = NULL,
		    verified_at = NULL WHERE tenant_id = $1 AND contract_id = $2`, A, cidA)
	})

	// The writer: job usage_map only (rolled back), then the same rows committed for the reads below.
	fixtures := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO scf.usage_map_days (network, day, ledgers, ledger_first, ledger_last, anchor_ledger, anchor_hash,
				    anchor_checked, projects, contracts) VALUES ('mainnet', '2026-11-16', 17280, 1000, 18279, 18280, repeat('ab', 32), true, 2, 3)`, nil},
		{`INSERT INTO scf.usage_map_project_daily (registry_project_id, network, day, invocations, successful_invocations,
				    distinct_invokers, contract_calls, contracts_listed, contracts_invoked) VALUES
				    ($1, 'mainnet', '2026-11-16', 120, 110, 25, 4, 2, 2), ($2, 'mainnet', '2026-11-16', 9, 9, 3, 0, 1, 1)`, []any{pClaimed, pUnclaimed}},
		{`INSERT INTO scf.usage_map_contract_daily (network, day, contract_id, invocations, successful_invocations,
				    distinct_invokers, contract_calls, successful_contract_calls) VALUES
				    ('mainnet', '2026-11-16', $1, 100, 95, 20, 4, 4), ('mainnet', '2026-11-16', $2, 20, 15, 5, 0, 0),
				    ('mainnet', '2026-11-16', $3, 9, 9, 3, 0, 0)`, []any{cidA, c2, c3}},
		{`INSERT INTO scf.usage_map_function_daily (network, day, contract_id, function_name, caller_kind, calls, successful_calls) VALUES
				    ('mainnet', '2026-11-16', $1, 'swap', 'account', 100, 95), ('mainnet', '2026-11-16', $1, 'swap', 'contract', 4, 4),
				    ('mainnet', '2026-11-16', $2, '(other)', 'account', 20, 15), ('mainnet', '2026-11-16', $3, 'mint', 'account', 9, 9)`,
			[]any{cidA, c2, c3}},
		{`INSERT INTO scf.usage_map_project_weekly (registry_project_id, network, week_start, active_accounts,
				    active_accounts_successful, invocations, successful_invocations, contract_calls) VALUES
				    ($1, 'mainnet', '2026-11-09', 40, 30, 700, 650, 20), ($1, 'mainnet', '2026-11-02', 12, 9, 300, 280, 5),
				    ($2, 'mainnet', '2026-11-09', 4, 4, 50, 50, 0)`, []any{pClaimed, pUnclaimed}},
	}
	write := func(job string) error {
		return inCtx(t, runtimeConn(t, "scf_jobs"), Ctx{Kind: "job", Actor: job, Job: job}, func(ctx context.Context, tx pgx.Tx) error {
			for _, q := range fixtures {
				if _, err := tx.Exec(ctx, q.sql, q.args...); err != nil {
					return err
				}
			}
			return nil
		})
	}
	if err := write("trust_scoring"); code(err) != "42501" {
		t.Fatalf("another job writing usage_map rows: want 42501, got %s", sqlState(err))
	}
	if err := write("usage_map"); err != nil {
		t.Fatalf("job usage_map writes: %s", sqlState(err))
	}
	for _, q := range fixtures {
		mustExec(t, su, q.sql, q.args...)
	}
	// A week must start on a Monday; a function name must be a symbol or one of the two markers.
	for _, bad := range []string{
		`INSERT INTO scf.usage_map_project_weekly (registry_project_id, network, week_start, active_accounts,
		   active_accounts_successful, invocations, successful_invocations, contract_calls) VALUES ('` + pClaimed + `', 'mainnet', '2026-11-10', 1, 1, 1, 1, 0)`,
		`INSERT INTO scf.usage_map_function_daily (network, day, contract_id, function_name, caller_kind, calls, successful_calls)
		   VALUES ('mainnet', '2026-11-16', '` + c2 + `', 'drop table', 'account', 1, 1)`,
		`INSERT INTO scf.usage_map_project_weekly (registry_project_id, network, week_start, active_accounts,
		   active_accounts_successful, invocations, successful_invocations, contract_calls) VALUES ('` + pClaimed + `', 'mainnet', '2026-11-16', 5, 1, 4, 1, 0)`,
	} {
		if _, err := su.Exec(ctx, bad); code(err) != "23514" {
			t.Errorf("constraint not enforced: %s → %s", firstLine(bad), sqlState(err))
		}
	}

	read := func(role string, c Ctx, sql string) ([]string, error) {
		var out []string
		err := inCtx(t, runtimeConn(t, role), c, func(ctx context.Context, tx pgx.Tx) error {
			rows, err := tx.Query(ctx, sql)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var s string
				if err := rows.Scan(&s); err != nil {
					return err
				}
				out = append(out, s)
			}
			return rows.Err()
		})
		sort.Strings(out)
		return out, err
	}
	tenantA := Ctx{Tenant: A, Kind: "user", Actor: users[A]}
	tenantB := Ctx{Tenant: B, Kind: "user", Actor: users[B]}
	checks := []struct {
		name string
		c    Ctx
		sql  string
		want []string
	}{
		{"A project days", tenantA, `SELECT registry_project_id::text FROM scf.usage_map_project_daily`, []string{pClaimed}},
		{"A weeks", tenantA, `SELECT registry_project_id::text || week_start FROM scf.usage_map_project_weekly`,
			[]string{pClaimed + "2026-11-02", pClaimed + "2026-11-09"}},
		{"A contracts", tenantA, `SELECT contract_id FROM scf.usage_map_contract_daily`, sorted(cidA, c2)},
		{"A functions", tenantA, `SELECT contract_id || function_name || caller_kind FROM scf.usage_map_function_daily`,
			sorted(cidA+"swapaccount", cidA+"swapcontract", c2+"(other)account")},
		{"A days", tenantA, `SELECT day::text FROM scf.usage_map_days WHERE day >= '2026-11-01'`, []string{"2026-11-16"}},
		{"B (candidate link only) project days", tenantB, `SELECT registry_project_id::text FROM scf.usage_map_project_daily`, nil},
		{"B contracts", tenantB, `SELECT contract_id FROM scf.usage_map_contract_daily`, nil},
		{"B weeks", tenantB, `SELECT registry_project_id::text FROM scf.usage_map_project_weekly`, nil},
		{"operator context reads no table directly", operatorCtx(false), `SELECT registry_project_id::text FROM scf.usage_map_project_daily`, nil},
		{"operator context, contracts", operatorCtx(false), `SELECT contract_id FROM scf.usage_map_contract_daily`, nil},
		{"anonymous", Ctx{Kind: "anonymous"}, `SELECT day::text FROM scf.usage_map_days`, nil},
		{"machine key", keyCtx("registry:read"), `SELECT registry_project_id::text FROM scf.usage_map_project_weekly`, nil},
	}
	for _, ck := range checks {
		got, err := read("scf_app", ck.c, ck.sql)
		if err != nil || strings.Join(got, ",") != strings.Join(ck.want, ",") {
			t.Errorf("%s: got %v %s, want %v", ck.name, got, sqlState(err), ck.want)
		}
	}
	for _, role := range []string{"scf_metrics_ro", "scf_writer"} {
		if _, err := read(role, Ctx{Kind: "anonymous"}, `SELECT day::text FROM scf.usage_map_project_daily`); code(err) != "42501" {
			t.Errorf("%s reading usage_map_project_daily: want 42501, got %s", role, sqlState(err))
		}
	}

	// Operator list: both projects, the claim state, the floor on distinct accounts (op_min_count = 10).
	rows, au, err := callOp(t, opCall{"scf_app", operatorCtx(false)},
		`SELECT registry_project_id::text, contracts_listed, days_covered, invocations, peak_daily_invokers,
		        array_length(daily_invocations, 1), week_start::text, active_accounts, prev_active_accounts, claimed,
		        contracts_verified
		   FROM scf.op_usage_map('2026-11-10T00:00Z', '2026-11-17T00:00Z', 'mainnet')
		  WHERE registry_project_id = ANY($1::uuid[]) ORDER BY 1`, []string{pClaimed, pUnclaimed})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	oneAudit(t, au, "operator.read.op_usage_map")
	if len(rows) != 2 {
		t.Fatalf("op_usage_map rows: %v", rows)
	}
	claimed, unclaimed := rows[0], rows[1]
	if str(claimed[0]) != pClaimed || claimed[1] != int32(2) || claimed[2] != int32(1) || claimed[3] != int64(120) ||
		claimed[4] != int64(25) || claimed[5] != int32(7) || claimed[6] != "2026-11-09" || claimed[7] != int64(40) ||
		claimed[8] != int64(12) || claimed[9] != true || claimed[10] != int32(1) {
		t.Errorf("claimed project row = %v", claimed)
	}
	if unclaimed[3] != int64(9) || unclaimed[4] != nil || unclaimed[7] != nil || unclaimed[9] != false || unclaimed[10] != int32(0) {
		t.Errorf("unclaimed project row = %v (distinct accounts below op_min_count must be NULL, invocations exact)", unclaimed)
	}

	// Operator detail.
	rows, au, err = callOp(t, opCall{"scf_app", operatorCtx(false)},
		`SELECT scf.op_usage_map_project($1, '2026-11-01T00:00Z', '2026-11-17T00:00Z', 'mainnet')`, pClaimed)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	oneAudit(t, au, "operator.read.op_usage_map_project")
	var doc struct {
		Daily []struct {
			Invocations      int64  `json:"invocations"`
			DistinctInvokers *int64 `json:"distinct_invokers"`
		} `json:"daily"`
		Weekly []struct {
			ActiveAccounts *int64 `json:"active_accounts"`
		} `json:"weekly"`
		Contracts []struct {
			ContractID        string `json:"contract_id"`
			Invocations       int64  `json:"invocations"`
			FootprintVerified bool   `json:"footprint_verified"`
		} `json:"contracts"`
		Functions []struct {
			Function   string `json:"function"`
			CallerKind string `json:"caller_kind"`
			Calls      int64  `json:"calls"`
		} `json:"functions"`
		DaysCovered int64 `json:"days_covered"`
		Claimed     bool  `json:"claimed"`
	}
	b, _ := json.Marshal(rows[0][0])
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Daily) != 1 || doc.Daily[0].Invocations != 120 || doc.Daily[0].DistinctInvokers == nil || *doc.Daily[0].DistinctInvokers != 25 ||
		len(doc.Weekly) != 2 || len(doc.Contracts) != 2 || len(doc.Functions) != 3 || doc.DaysCovered != 1 || !doc.Claimed {
		t.Errorf("detail = %s", b)
	}
	for _, c := range doc.Contracts {
		if c.FootprintVerified != (c.ContractID == cidA) {
			t.Errorf("footprint_verified of %s = %v", c.ContractID, c.FootprintVerified)
		}
	}
	if rows, _, err := callOp(t, opCall{"scf_app", operatorCtx(false)},
		`SELECT scf.op_usage_map_project($1, '2026-11-01T00:00Z', '2026-11-17T00:00Z', 'mainnet') IS NULL`, reg); err != nil || rows[0][0] != true {
		t.Errorf("a project without contracts: %v %s", rows, sqlState(err))
	}

	// Authorisation: tenants, other roles and bad arguments.
	for _, c := range []struct {
		name, role string
		ctx        Ctx
		sql, want  string
	}{
		{"tenant user", "scf_app", tenantA, `SELECT * FROM scf.op_usage_map('2026-11-10T00:00Z', '2026-11-17T00:00Z', 'mainnet')`, "42501"},
		{"tenant user, detail", "scf_app", tenantA, `SELECT scf.op_usage_map_project('` + pUnclaimed + `', '2026-11-10T00:00Z', '2026-11-17T00:00Z', 'mainnet')`, "42501"},
		{"key without registry:read", "scf_app", keyCtx("web:read"), `SELECT * FROM scf.op_usage_map('2026-11-10T00:00Z', '2026-11-17T00:00Z', 'mainnet')`, "42501"},
		{"scf_metrics_ro", "scf_metrics_ro", keyCtx("registry:read"), `SELECT * FROM scf.op_usage_map('2026-11-10T00:00Z', '2026-11-17T00:00Z', 'mainnet')`, "42501"},
		{"bad network", "scf_app", operatorCtx(false), `SELECT * FROM scf.op_usage_map('2026-11-10T00:00Z', '2026-11-17T00:00Z', 'public')`, "22023"},
		{"window over 92 days", "scf_app", operatorCtx(false), `SELECT * FROM scf.op_usage_map('2026-01-01T00:00Z', '2026-11-17T00:00Z', 'mainnet')`, "22023"},
	} {
		if _, au, err := callOp(t, opCall{c.role, c.ctx}, c.sql); code(err) != c.want || len(au) != 0 {
			t.Errorf("%s: want %s and no audit, got %s %v", c.name, c.want, sqlState(err), au)
		}
	}
	// With a registry:read key the list works (audited as op_key).
	if _, au, err := callOp(t, opCall{"scf_app", keyCtx("registry:read")},
		`SELECT * FROM scf.op_usage_map('2026-11-10T00:00Z', '2026-11-17T00:00Z', 'testnet')`); err != nil || oneAudit(t, au, "operator.read.op_usage_map").actorKind != "op_key" {
		t.Errorf("registry:read key: %s %v", sqlState(err), au)
	}

	// Rewriting a day is one DELETE of its usage_map_days row: every figure of the day goes with it (cascade).
	if err := inCtx(t, runtimeConn(t, "scf_jobs"), Ctx{Kind: "job", Actor: "usage_map", Job: "usage_map"}, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM scf.usage_map_days WHERE network = 'mainnet' AND day = '2026-11-16'`); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM scf.usage_map_project_daily WHERE day = '2026-11-16')
		    + (SELECT count(*) FROM scf.usage_map_contract_daily WHERE day = '2026-11-16')
		    + (SELECT count(*) FROM scf.usage_map_function_daily WHERE day = '2026-11-16')`).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			t.Errorf("%d rows of the deleted day remain", n)
		}
		return nil
	}); err != nil {
		t.Errorf("job usage_map rewriting a day: %s", sqlState(err))
	}
}

func sorted(s ...string) []string {
	sort.Strings(s)
	return s
}
