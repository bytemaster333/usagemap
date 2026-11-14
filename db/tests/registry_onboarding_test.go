// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0073: onboarding of SCF-awarded projects. scf.registry_claimants() counts the tenants that already claim a registry
// project (a confirmed link, or a verified host on one of its registrable domains) for signed-in users only; the
// operator read model scf.op_registry_coverage() reports enrolled / verified / measuring tenants per project, audited,
// canary tenants never counted.
func TestRegistryOnboarding0073(t *testing.T) {
	su := super(t)
	const (
		pA    = "0d000000-0000-7000-8000-0000000000a1" // registrable domain = tenant A's verified host
		pNone = "0d000000-0000-7000-8000-0000000000a2" // a domain nobody declared
		pLink = "0d000000-0000-7000-8000-0000000000a3" // no domain; tenant B holds a confirmed (operator) link
		pCan  = "0d000000-0000-7000-8000-0000000000a4" // the canary tenant's host only
	)
	mustExec(t, su, `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded,
	    registrable_domains, fetched_at, content_sha256, raw) VALUES
	  ($1, 'stellarlight', 'onb-a', 'Onboard A', true, '{example.org}', now(), decode(repeat('a1', 32), 'hex'), '{}'),
	  ($2, 'stellarlight', 'onb-none', 'Onboard none', true, '{nobody.example}', now(), decode(repeat('a2', 32), 'hex'), '{}'),
	  ($3, 'stellarlight', 'onb-link', 'Onboard link', true, '{}', now(), decode(repeat('a3', 32), 'hex'), '{}'),
	  ($4, 'stellarlight', 'onb-canary', 'Onboard canary', true, '{canary-c.example.org}', now(), decode(repeat('a4', 32), 'hex'), '{}')`,
		pA, pNone, pLink, pCan)
	mustExec(t, su, `INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status)
	    VALUES ($1, $2, ARRAY['operator'], 'confirmed')`, B, pLink)
	t.Cleanup(func() {
		c := super(t)
		mustExec(t, c, `DELETE FROM scf.tenant_registry_links WHERE registry_project_id = ANY($1::uuid[])`, []string{pA, pNone, pLink, pCan})
		mustExec(t, c, `DELETE FROM scf.registry_projects WHERE registry_project_id = ANY($1::uuid[])`, []string{pA, pNone, pLink, pCan})
	})

	claimants := func(role string, c Ctx, p string) (int, error) {
		var n int
		err := inCtx(t, runtimeConn(t, role), c, func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT scf.registry_claimants($1)`, p).Scan(&n)
		})
		return n, err
	}
	user := Ctx{Kind: "user", Actor: users[C]}
	// "example.org" covers every seeded host (tenant-a/-b/canary-c.example.org): three claimants.
	for p, want := range map[string]int{pA: 3, pNone: 0, pLink: 1, pCan: 1} {
		if n, err := claimants("scf_app", user, p); err != nil || n != want {
			t.Errorf("registry_claimants(%s) as a signed-in user: %d %s, want %d", p, n, sqlState(err), want)
		}
	}
	// A tenant context of the user changes nothing (the answer names no tenant).
	if n, err := claimants("scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, pLink); err != nil || n != 1 {
		t.Errorf("registry_claimants in a tenant context: %d %s", n, sqlState(err))
	}
	for _, c := range []Ctx{{Kind: "anonymous"}, operatorCtx(true), keyCtx("registry:read")} {
		if _, err := claimants("scf_app", c, pA); code(err) != "42501" {
			t.Errorf("registry_claimants under %s: want 42501, got %s", c.Kind, sqlState(err))
		}
	}
	for _, role := range []string{"scf_writer", "scf_jobs", "scf_metrics_ro"} {
		if _, err := claimants(role, user, pA); code(err) != "42501" {
			t.Errorf("registry_claimants as %s: want 42501, got %s", role, sqlState(err))
		}
	}

	// Operator coverage: per project, enrolled / verified / measuring tenants.
	rows, au, err := callOp(t, opCall{"scf_app", operatorCtx(false)},
		`SELECT registry_project_id::text, tenants_enrolled, tenants_verified, tenants_measuring FROM scf.op_registry_coverage(7)`)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	oneAudit(t, au, "operator.read.op_registry_coverage")
	got := map[string][3]int32{}
	for _, r := range rows {
		got[str(r[0])] = [3]int32{r[1].(int32), r[2].(int32), r[3].(int32)}
	}
	want := map[string][3]int32{
		pA:    {2, 2, 2}, // A and B verified on a subdomain, both with page views yesterday; canary C not counted
		pLink: {1, 1, 1}, // B through its confirmed link
		reg:   {2, 0, 0}, // the seed's candidate links of A and B (canary C not counted)
	}
	for p, w := range want {
		if got[p] != w {
			t.Errorf("coverage %s: got %v, want %v (all: %v)", p, got[p], w, got)
		}
	}
	for _, p := range []string{pNone, pCan} {
		if _, ok := got[p]; ok {
			t.Errorf("coverage lists %s, which has no enrolled (non-canary) tenant", p)
		}
	}
	if _, _, err := callOp(t, opCall{"scf_app", operatorCtx(false)}, `SELECT * FROM scf.op_registry_coverage(0)`); code(err) != "22023" {
		t.Errorf("op_registry_coverage(0): want 22023, got %s", sqlState(err))
	}
	if _, au, err := callOp(t, opCall{"scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}}, `SELECT * FROM scf.op_registry_coverage()`); code(err) != "42501" || len(au) != 0 {
		t.Errorf("tenant user calling op_registry_coverage: want 42501 and no audit, got %s %v", sqlState(err), au)
	}
	if _, au, err := callOp(t, opCall{"scf_metrics_ro", keyCtx("registry:read")}, `SELECT * FROM scf.op_registry_coverage()`); code(err) != "42501" || len(au) != 0 {
		t.Errorf("scf_metrics_ro calling op_registry_coverage: want 42501 (no grant), got %s %v", sqlState(err), au)
	}
}
