// SPDX-License-Identifier: Apache-2.0

package store

import (
	"bytes"
	"context"
	"maps"
	"slices"
	"time"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// Stream-state bound. Cumulative stream keys hash the route as received,
// before the cardinality guard (C-24) maps excess routes to {overflow}; without a bound every distinct literal route
// would create, lock and keep (7 days) its own api_stream_state row. A new stream gets a state row only when
//
//  1. its route is already known (in api_routes, or a guard-exempt placeholder), or the route still fits today's
//     tenant route capacity (route_cap_per_tenant_day, l0_routes_per_day for L0) — the same budget the guard
//     admits routes from; and
//  2. the tenant stays within its state-row cap (stream_state_cap_per_tenant, l0_stream_state_cap for L0), counting
//     a new source row (C-122) with its first stream.
//
// A refused stream keeps no state; its points are dropped and counted route_overflow. Known routes are admitted
// first, then new routes, each in stream-key order, so the outcome does not depend on arrival order inside a request.

// newStream is a cumulative stream without a state row yet.
type newStream struct {
	key, source [32]byte
	day         string   // UTC day of the stream's newest point in the request
	route       routeKey // after the overflow flag; only used to count distinct new routes
	known       bool     // route in api_routes or guard-exempt
	sourceNew   bool     // the source has no row yet either
}

// streamBudget is what admitStreams may grant.
type streamBudget struct {
	routesLeft map[string]int64 // per UTC day: tenant route capacity still free today
	rowsLeft   int64            // state rows the tenant may still create
}

// admitStreams decides which new streams get a state row. It returns the admitted stream keys and the source keys
// that must be created for them.
func admitStreams(streams []newStream, b streamBudget) (admitted, sources map[[32]byte]bool) {
	admitted, sources = map[[32]byte]bool{}, map[[32]byte]bool{}
	order := slices.Clone(streams)
	slices.SortFunc(order, func(x, y newStream) int {
		if x.known != y.known {
			if x.known {
				return -1
			}
			return 1
		}
		return bytes.Compare(x.key[:], y.key[:])
	})
	granted := map[dayRoute]bool{}
	routesLeft := maps.Clone(b.routesLeft)
	for _, s := range order {
		if admitted[s.key] {
			continue
		}
		u := dayRoute{s.day, s.route}
		needRoute := !s.known && !granted[u]
		if needRoute && routesLeft[s.day] <= 0 {
			continue
		}
		cost := int64(1)
		if s.sourceNew && !sources[s.source] {
			cost++
		}
		if b.rowsLeft < cost {
			continue
		}
		b.rowsLeft -= cost
		if needRoute {
			granted[u] = true
			routesLeft[s.day]--
		}
		admitted[s.key] = true
		if s.sourceNew {
			sources[s.source] = true
		}
	}
	return admitted, sources
}

// boundStreams applies the stream-state bound to the cumulative streams of this transaction: byKey maps stream keys
// to their points, sources maps source keys to the newest point time. It returns the stream keys refused (no state;
// their points are dropped by the caller) and the source keys that must not be created.
func (w *work) boundStreams(ctx context.Context, byKey map[[32]byte][]*pending, sources map[[32]byte]int64) (
	refused, skipSources map[[32]byte]bool, err error) {
	existing, err := w.existingState(ctx, byKey, sources)
	if err != nil {
		return nil, nil, err
	}
	anyNew := false
	for k := range byKey {
		if !existing[k] {
			anyNew = true
			break
		}
	}
	if !anyNew {
		return nil, nil, nil
	}
	// Growth of the tenant's state is serialised like its dictionaries (both writers), then re-read.
	if err := w.lock(ctx); err != nil {
		return nil, nil, err
	}
	if existing, err = w.existingState(ctx, byKey, sources); err != nil {
		return nil, nil, err
	}
	var total int64
	if err := w.tx.QueryRow(ctx, `SELECT count(*) FROM scf.api_stream_state WHERE tenant_id = $1::uuid`, w.tenant).
		Scan(&total); err != nil {
		return nil, nil, err
	}
	stateCap, routeCap := w.settings["stream_state_cap_per_tenant"], w.settings["route_cap_per_tenant_day"]
	if w.part.Level == 0 {
		stateCap, routeCap = w.settings["l0_stream_state_cap"], w.settings["l0_routes_per_day"]
	}
	var streams []newStream
	var unknown []routeKey
	seenRoute := map[routeKey]bool{}
	daySet := map[string]bool{}
	for k, group := range byKey {
		if existing[k] {
			continue
		}
		p := group[0].p
		newest := p.Snap.Time
		for _, pp := range group {
			newest = max(newest, pp.p.Snap.Time)
		}
		route := p.Route
		if p.Overflow {
			route = rules.RouteOverflow
		}
		sv := w.services[p.Service]
		rk := routeKey{group[0].serviceID, route, rules.RPCMethod(sv.rpcDimension, p.RPCMethod, p.HasRPC), p.RulesVersion}
		ns := newStream{key: k, source: p.SourceKey, day: dayOf(time.Unix(0, newest)), route: rk,
			known: rules.GuardExempt(route), sourceNew: !existing[p.SourceKey]}
		if !ns.known && !seenRoute[rk] {
			seenRoute[rk] = true
			unknown = append(unknown, rk)
		}
		daySet[ns.day] = true
		streams = append(streams, ns)
	}
	ids := map[routeKey]int64{}
	slices.SortFunc(unknown, routeKey.compare)
	if err := w.lookupRoutes(ctx, unknown, ids); err != nil {
		return nil, nil, err
	}
	for i := range streams {
		if _, ok := ids[streams[i].route]; ok {
			streams[i].known = true
		}
	}
	left := map[string]int64{}
	days := keysOf(daySet)
	for _, d := range days {
		left[d] = routeCap
	}
	rows, err := w.tx.Query(ctx, `SELECT day::text, count(*) FROM scf.api_route_day
 WHERE day = ANY($1::text[]::date[]) GROUP BY 1`, days)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var d string
		var n int64
		if err := rows.Scan(&d, &n); err != nil {
			rows.Close()
			return nil, nil, err
		}
		left[d] = routeCap - n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	admitted, newSources := admitStreams(streams, streamBudget{routesLeft: left, rowsLeft: stateCap - total})
	refused, skipSources = map[[32]byte]bool{}, map[[32]byte]bool{}
	for _, s := range streams {
		if !admitted[s.key] {
			refused[s.key] = true
		}
		if s.sourceNew && !newSources[s.source] {
			skipSources[s.source] = true
		}
	}
	return refused, skipSources, nil
}

// existingState returns which of the stream and source keys already have a row.
func (w *work) existingState(ctx context.Context, byKey map[[32]byte][]*pending, sources map[[32]byte]int64) (
	map[[32]byte]bool, error) {
	keys := make([][]byte, 0, len(byKey)+len(sources))
	for k := range byKey {
		keys = append(keys, k[:])
	}
	for k := range sources {
		keys = append(keys, k[:])
	}
	rows, err := w.tx.Query(ctx, `SELECT stream_key FROM scf.api_stream_state
 WHERE tenant_id = $1::uuid AND stream_key = ANY($2::bytea[])`, w.tenant, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[[32]byte]bool{}
	for rows.Next() {
		var k []byte
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		if len(k) == 32 {
			out[[32]byte(k)] = true
		}
	}
	return out, rows.Err()
}
