// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0082: protocol interactions. Job protocol_usage is the only writer (global rows without a tenant, tenant rows only
// under the tenant's context); a tenant reads its own rows only; registry-project and network rows are readable by SCF
// operators only, through op_protocol_usage (audited, registry:read); scf_metrics_ro, scf_writer and machine keys have
// nothing; the protocol is a closed set.
func TestProtocolUsage0082(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	const proj = "0d000000-0000-7000-8000-0000000000c1"
	mustExec(t, su, `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded,
	    contract_ids, fetched_at, content_sha256, raw) VALUES
	  ($1, 'stellarlight', 'pu-1', 'Protocol user', true, ARRAY['C' || repeat('T', 55)], now(), decode(repeat('c1', 32), 'hex'), '{}')`, proj)
	t.Cleanup(func() {
		c := super(t)
		mustExec(t, c, `DELETE FROM scf.protocol_usage_days WHERE day >= '2026-11-01' AND day < '2026-11-20'`)
		mustExec(t, c, `DELETE FROM scf.protocol_usage_tenant_daily WHERE day >= '2026-11-01' AND day < '2026-11-20'`)
		mustExec(t, c, `DELETE FROM scf.registry_projects WHERE registry_project_id = $1`, proj)
	})

	global := []string{
		`INSERT INTO scf.protocol_usage_days (network, day, ledgers, ledger_first, ledger_last, anchor_ledger, anchor_hash,
		   anchor_checked, registry_version, projects, tenants) VALUES ('mainnet', '2026-11-16', 17280, 1000, 18279, 18280,
		   repeat('ab', 32), true, '2026-11-19.1', 1, 1)`,
		`INSERT INTO scf.protocol_usage_network_daily (network, day, protocol, transactions, successful_transactions)
		   VALUES ('mainnet', '2026-11-16', 'blend', 900, 850), ('mainnet', '2026-11-16', 'reflector', 40, 40)`,
		`INSERT INTO scf.protocol_usage_project_daily (registry_project_id, network, day, protocol, transactions,
		   successful_transactions) VALUES ('` + proj + `', 'mainnet', '2026-11-16', 'any', 50, 45),
		   ('` + proj + `', 'mainnet', '2026-11-16', 'blend', 12, 11)`,
	}
	tenantRows := func(tenant string) string {
		return `INSERT INTO scf.protocol_usage_tenant_daily (tenant_id, network, day, protocol, transactions,
		   successful_transactions, contracts, registry_version) VALUES ('` + tenant + `', 'mainnet', '2026-11-16', 'any', 30, 29, 1, '2026-11-19.1'),
		   ('` + tenant + `', 'mainnet', '2026-11-16', 'soroswap', 7, 7, 1, '2026-11-19.1')`
	}
	jobs := runtimeConn(t, "scf_jobs")
	run := func(c Ctx, sqls ...string) error {
		return inCtx(t, jobs, c, func(ctx context.Context, tx pgx.Tx) error {
			for _, q := range sqls {
				if _, err := tx.Exec(ctx, q); err != nil {
					return err
				}
			}
			return nil
		})
	}
	job := func(name string) Ctx { return Ctx{Kind: "job", Actor: name, Job: name} }
	tjob := func(name, tenant string) Ctx { return Ctx{Tenant: tenant, Kind: "job", Actor: name, Job: name} }
	if err := run(job("usage_map"), global...); code(err) != "42501" {
		t.Fatalf("another job writing protocol rows: want 42501, got %s", sqlState(err))
	}
	if err := run(job("protocol_usage"), global...); err != nil {
		t.Fatalf("job protocol_usage, global rows: %s", sqlState(err))
	}
	if err := run(job("protocol_usage"), tenantRows(A)); code(err) != "42501" {
		t.Errorf("tenant rows without the tenant's context: want 42501, got %s", sqlState(err))
	}
	if err := run(tjob("protocol_usage", A), tenantRows(B)); code(err) != "42501" {
		t.Errorf("tenant B's rows under A's context: want 42501, got %s", sqlState(err))
	}
	if err := run(tjob("trust_scoring", A), tenantRows(A)); code(err) != "42501" {
		t.Errorf("another job writing tenant rows: want 42501, got %s", sqlState(err))
	}
	for _, q := range global {
		mustExec(t, su, q)
	}
	mustExec(t, su, tenantRows(A))
	mustExec(t, su, tenantRows(B))
	// The job reads cross-tenant (tenant unset) what it needs to plan, and deletes under the tenant's context.
	if err := inCtx(t, jobs, job("protocol_usage"), func(ctx context.Context, tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.protocol_usage_tenant_daily WHERE day = '2026-11-16'`).Scan(&n); err != nil {
			return err
		}
		if n != 4 {
			t.Errorf("job cross-tenant read: %d rows, want 4", n)
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM scf.declared_contracts`).Scan(&n)
	}); err != nil {
		t.Errorf("job reads: %s", sqlState(err))
	}

	for _, bad := range []string{
		`INSERT INTO scf.protocol_usage_network_daily (network, day, protocol, transactions, successful_transactions)
		   VALUES ('mainnet', '2026-11-16', 'phoenix', 1, 1)`,
		`INSERT INTO scf.protocol_usage_network_daily (network, day, protocol, transactions, successful_transactions)
		   VALUES ('mainnet', '2026-11-16', 'any', 1, 1)`,
		`INSERT INTO scf.protocol_usage_project_daily (registry_project_id, network, day, protocol, transactions,
		   successful_transactions) VALUES ('` + proj + `', 'mainnet', '2026-11-16', 'soroswap', 1, 2)`,
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
	for _, ck := range []struct {
		name string
		c    Ctx
		sql  string
		want []string
	}{
		{"A own rows", tenantA, `SELECT tenant_id::text || protocol FROM scf.protocol_usage_tenant_daily WHERE day = '2026-11-16'`,
			[]string{A + "any", A + "soroswap"}},
		{"A days", tenantA, `SELECT day::text FROM scf.protocol_usage_days WHERE day >= '2026-11-01'`, []string{"2026-11-16"}},
		{"operator context reads no tenant row directly", operatorCtx(false), `SELECT protocol FROM scf.protocol_usage_tenant_daily WHERE day = '2026-11-16'`, nil},
		{"machine key", keyCtx("registry:read"), `SELECT protocol FROM scf.protocol_usage_tenant_daily WHERE day = '2026-11-16'`, nil},
	} {
		got, err := read("scf_app", ck.c, ck.sql)
		if err != nil || strings.Join(got, ",") != strings.Join(ck.want, ",") {
			t.Errorf("%s: got %v %s, want %v", ck.name, got, sqlState(err), ck.want)
		}
	}
	for _, tbl := range []string{"protocol_usage_project_daily", "protocol_usage_network_daily"} {
		if _, err := read("scf_app", tenantA, `SELECT protocol FROM scf.`+tbl); code(err) != "42501" {
			t.Errorf("scf_app reading %s: want 42501, got %s", tbl, sqlState(err))
		}
	}
	for _, role := range []string{"scf_metrics_ro", "scf_writer"} {
		if _, err := read(role, Ctx{Kind: "anonymous"}, `SELECT protocol FROM scf.protocol_usage_tenant_daily`); code(err) != "42501" {
			t.Errorf("%s reading protocol_usage_tenant_daily: want 42501, got %s", role, sqlState(err))
		}
	}

	// Operator: the project, both tenants and the network totals; audited once.
	rows, au, err := callOp(t, opCall{"scf_app", operatorCtx(false)},
		`SELECT subject_kind, COALESCE(subject_id::text, ''), protocol, transactions, days_covered
		   FROM scf.op_protocol_usage('2026-11-10T00:00Z', '2026-11-17T00:00Z', 'mainnet')
		  WHERE subject_id IS NULL OR subject_id = ANY($1::uuid[]) ORDER BY 1, 2, 3`, []string{proj, A, B})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	oneAudit(t, au, "operator.read.op_protocol_usage")
	var got []string
	for _, r := range rows {
		got = append(got, str(r[0])+"/"+str(r[1])+"/"+str(r[2])+"/"+i64s(r[3]))
		if r[4] != int32(1) {
			t.Errorf("days_covered = %v, want 1", r[4])
		}
	}
	want := []string{
		"network//blend/900", "network//reflector/40",
		"project/" + proj + "/any/50", "project/" + proj + "/blend/12",
		"tenant/" + A + "/any/30", "tenant/" + A + "/soroswap/7",
		"tenant/" + B + "/any/30", "tenant/" + B + "/soroswap/7",
	}
	sort.Strings(want)
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("op_protocol_usage = %v, want %v", got, want)
	}
	// Without registry:read the function refuses before reading.
	if _, _, err := callOp(t, opCall{"scf_app", tenantA},
		`SELECT * FROM scf.op_protocol_usage('2026-11-10T00:00Z', '2026-11-17T00:00Z', 'mainnet')`); err == nil {
		t.Error("a tenant user called op_protocol_usage")
	}
}

func i64s(v any) string {
	if n, ok := v.(int64); ok {
		return strconv.FormatInt(n, 10)
	}
	return "?"
}
