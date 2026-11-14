// SPDX-License-Identifier: Apache-2.0

package store

import (
	"cmp"
	"context"
	"slices"
	"time"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// routeKey is one entry of the route dictionary api_routes (unique per tenant).
type routeKey struct {
	service, route, rpc, rules string
}

func (a routeKey) compare(b routeKey) int {
	return cmp.Or(cmp.Compare(a.service, b.service), cmp.Compare(a.route, b.route), cmp.Compare(a.rpc, b.rpc),
		cmp.Compare(a.rules, b.rules))
}

// dayRoute is one (UTC day, route) use, the unit of the cardinality guard.
type dayRoute struct {
	day string
	key routeKey
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// lookupRoutes fills ids for the given keys that exist in api_routes.
func (w *work) lookupRoutes(ctx context.Context, keys []routeKey, ids map[routeKey]int64) error {
	if len(keys) == 0 {
		return nil
	}
	var svc, route, rpc, rv []string
	var rpcN []*string
	for _, k := range keys {
		svc, route, rpc, rv = append(svc, k.service), append(route, k.route), append(rpc, k.rpc), append(rv, k.rules)
		rpcN = append(rpcN, nullable(k.rpc))
	}
	rows, err := w.tx.Query(ctx, `
SELECT u.i, r.route_id
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS u(s, rt, m, v, i)
  JOIN scf.api_routes r ON r.service_id = u.s::uuid AND r.route = u.rt AND r.rpc_method IS NOT DISTINCT FROM u.m
                       AND r.rules_version = u.v`, svc, route, rpcN, rv)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var i, id int64
		if err := rows.Scan(&i, &id); err != nil {
			return err
		}
		ids[keys[i-1]] = id
	}
	return rows.Err()
}

// presentDays returns which (day, service, route_id) uses already exist in api_route_day.
func (w *work) presentDays(ctx context.Context, uses []dayRoute, ids map[routeKey]int64) (map[dayRoute]bool, error) {
	present := map[dayRoute]bool{}
	var days, svcs []string
	var rids []int64
	var idx []dayRoute
	for _, u := range uses {
		if id, ok := ids[u.key]; ok {
			days, svcs, rids, idx = append(days, u.day), append(svcs, u.key.service), append(rids, id), append(idx, u)
		}
	}
	if len(idx) == 0 {
		return present, nil
	}
	rows, err := w.tx.Query(ctx, `
SELECT u.i FROM unnest($1::text[], $2::text[], $3::int8[]) WITH ORDINALITY AS u(d, s, r, i)
  JOIN scf.api_route_day x ON x.day = u.d::date AND x.service_id = u.s::uuid AND x.route_id = u.r`, days, svcs, rids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var i int64
		if err := rows.Scan(&i); err != nil {
			return nil, err
		}
		present[idx[i-1]] = true
	}
	return present, rows.Err()
}

// resolveRoutes maps every point to a route_id, applying the cardinality guard (C-24, ADR-0012): first come, first
// served per UTC day — at most route_cap_per_service_day routes per service, route_cap_per_tenant_day per tenant
// (l0_routes_per_day for L0 tenants), route_sibling_cap literal children per parent prefix; the excess becomes
// {overflow} (or <prefix>/{overflow} for siblings) and is counted route_overflow. A point with
// otel.metric.overflow = true is stored under {overflow} (C-16, C-89). Placeholder routes are outside the caps.
func (w *work) resolveRoutes(ctx context.Context, pts []*pending) error {
	if len(pts) == 0 {
		return nil
	}
	keyOf := make([]routeKey, len(pts))
	dayOfPt := make([]string, len(pts))
	useSet := map[dayRoute]bool{}
	for i, pp := range pts {
		route := pp.p.Route
		if pp.p.Overflow && route != rules.RouteOverflow {
			route = rules.RouteOverflow
			w.count(pp.p.Service, rules.ReasonRouteOverflow, 1)
		}
		sv := w.services[pp.p.Service]
		keyOf[i] = routeKey{pp.serviceID, route, rules.RPCMethod(sv.rpcDimension, pp.p.RPCMethod, pp.p.HasRPC), pp.p.RulesVersion}
		dayOfPt[i] = dayOf(time.Unix(0, pp.p.Snap.Time))
		useSet[dayRoute{dayOfPt[i], keyOf[i]}] = true
	}
	uses := make([]dayRoute, 0, len(useSet))
	for u := range useSet {
		uses = append(uses, u)
	}
	slices.SortFunc(uses, func(a, b dayRoute) int { return cmp.Or(cmp.Compare(a.day, b.day), a.key.compare(b.key)) })

	ids := map[routeKey]int64{}
	if err := w.lookupRoutes(ctx, uniqueKeys(uses), ids); err != nil {
		return err
	}
	present, err := w.presentDays(ctx, uses, ids)
	if err != nil {
		return err
	}
	var fresh []dayRoute
	for _, u := range uses {
		if !rules.GuardExempt(u.key.route) && !present[u] {
			fresh = append(fresh, u)
		}
	}
	remap := map[dayRoute]routeKey{} // uses that overflowed → the overflow route
	var admitted []dayRoute
	if len(fresh) > 0 {
		if err := w.lock(ctx); err != nil {
			return err
		}
		// Re-read under the lock: the other writer may have admitted some of them meanwhile.
		if err := w.lookupRoutes(ctx, uniqueKeys(fresh), ids); err != nil {
			return err
		}
		again, err := w.presentDays(ctx, fresh, ids)
		if err != nil {
			return err
		}
		for u := range again {
			present[u] = true
		}
		admitted, remap, err = w.guard(ctx, fresh, present)
		if err != nil {
			return err
		}
	}
	// Create the dictionary entries that do not exist yet: admitted routes, placeholders, overflow targets.
	var create []routeKey
	seen := map[routeKey]bool{}
	want := func(k routeKey) {
		if _, ok := ids[k]; !ok && !seen[k] {
			seen[k] = true
			create = append(create, k)
		}
	}
	isAdmitted := map[dayRoute]bool{}
	for _, u := range admitted {
		isAdmitted[u] = true
	}
	for _, u := range uses {
		if k, ok := remap[u]; ok {
			want(k)
		} else if rules.GuardExempt(u.key.route) || present[u] || isAdmitted[u] {
			want(u.key)
		}
	}
	if len(create) > 0 {
		slices.SortFunc(create, routeKey.compare)
		var svc, route, prefix, rv []string
		var rpc []*string
		for _, k := range create {
			svc, route, rv = append(svc, k.service), append(route, k.route), append(rv, k.rules)
			prefix, rpc = append(prefix, rules.ParentPrefix(k.route)), append(rpc, nullable(k.rpc))
		}
		if _, err := w.tx.Exec(ctx, `
INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rpc_method, rules_version)
SELECT $1::uuid, u.s::uuid, u.rt, u.p, u.m, u.v
  FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u(s, rt, p, m, v)
 ORDER BY 2, 3, 5, 6
ON CONFLICT DO NOTHING`, w.tenant, svc, route, prefix, rpc, rv); err != nil {
			return err
		}
		if err := w.lookupRoutes(ctx, create, ids); err != nil {
			return err
		}
	}
	if len(admitted) > 0 {
		var days, svcs []string
		var rids []int64
		for _, u := range admitted {
			days, svcs, rids = append(days, u.day), append(svcs, u.key.service), append(rids, ids[u.key])
		}
		if _, err := w.tx.Exec(ctx, `
INSERT INTO scf.api_route_day (tenant_id, day, service_id, route_id)
SELECT $1::uuid, u.d::date, u.s::uuid, u.r FROM unnest($2::text[], $3::text[], $4::int8[]) AS u(d, s, r)
 ORDER BY 2, 3, 4
ON CONFLICT DO NOTHING`, w.tenant, days, svcs, rids); err != nil {
			return err
		}
		if _, err := w.tx.Exec(ctx, `UPDATE scf.api_routes SET last_seen_at = now() WHERE route_id = ANY($1::int8[])`, rids); err != nil {
			return err
		}
	}
	for i, pp := range pts {
		u := dayRoute{dayOfPt[i], keyOf[i]}
		k := keyOf[i]
		if r, ok := remap[u]; ok {
			k = r
			w.count(pp.p.Service, rules.ReasonRouteOverflow, 1)
		}
		pp.routeID = ids[k]
	}
	return nil
}

func uniqueKeys(uses []dayRoute) []routeKey {
	seen := map[routeKey]bool{}
	var out []routeKey
	for _, u := range uses {
		if !seen[u.key] {
			seen[u.key] = true
			out = append(out, u.key)
		}
	}
	return out
}

// guard decides, in a fixed order, which fresh uses are admitted and which overflow.
func (w *work) guard(ctx context.Context, fresh []dayRoute, present map[dayRoute]bool) ([]dayRoute, map[dayRoute]routeKey, error) {
	daySet := map[string]bool{}
	prefSet := map[string]bool{}
	for _, u := range fresh {
		daySet[u.day] = true
		prefSet[rules.ParentPrefix(u.key.route)] = true
	}
	days := keysOf(daySet)
	prefixes := keysOf(prefSet)
	tenantN := map[string]int64{}
	svcN := map[[2]string]int64{}
	rows, err := w.tx.Query(ctx, `SELECT day::text, service_id::text, count(*) FROM scf.api_route_day
 WHERE day = ANY($1::text[]::date[]) GROUP BY 1, 2`, days)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var d, s string
		var n int64
		if err := rows.Scan(&d, &s, &n); err != nil {
			rows.Close()
			return nil, nil, err
		}
		tenantN[d] += n
		svcN[[2]string{d, s}] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	sibN := map[[3]string]int64{}
	rows, err = w.tx.Query(ctx, `
SELECT d.day::text, d.service_id::text, r.parent_prefix, count(*)
  FROM scf.api_route_day d JOIN scf.api_routes r ON r.tenant_id = d.tenant_id AND r.route_id = d.route_id
 WHERE d.day = ANY($1::text[]::date[]) AND r.parent_prefix = ANY($2::text[]) AND right(r.route, 1) <> '}' AND r.route <> '/'
 GROUP BY 1, 2, 3`, days, prefixes)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var d, s, p string
		var n int64
		if err := rows.Scan(&d, &s, &p, &n); err != nil {
			rows.Close()
			return nil, nil, err
		}
		sibN[[3]string{d, s, p}] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	tenantCap := w.settings["route_cap_per_tenant_day"]
	if w.part.Level == 0 {
		tenantCap = w.settings["l0_routes_per_day"]
	}
	svcCap, sibCap := w.settings["route_cap_per_service_day"], w.settings["route_sibling_cap"]
	var admitted []dayRoute
	remap := map[dayRoute]routeKey{}
	for _, u := range fresh {
		if present[u] {
			continue
		}
		sk := [2]string{u.day, u.key.service}
		prefix := rules.ParentPrefix(u.key.route)
		pk := [3]string{u.day, u.key.service, prefix}
		literal := rules.LiteralChild(u.key.route)
		switch {
		case tenantN[u.day] >= tenantCap || svcN[sk] >= svcCap:
			remap[u] = routeKey{u.key.service, rules.RouteOverflow, u.key.rpc, u.key.rules}
		case literal && sibN[pk] >= sibCap:
			remap[u] = routeKey{u.key.service, rules.SiblingOverflow(prefix), u.key.rpc, u.key.rules}
		default:
			admitted = append(admitted, u)
			tenantN[u.day]++
			svcN[sk]++
			if literal {
				sibN[pk]++
			}
		}
	}
	return admitted, remap, nil
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}
