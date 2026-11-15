// SPDX-License-Identifier: Apache-2.0

package counters

import (
	"sort"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
)

// RPCKey identifies one cell of the browser Stellar RPC/Horizon aggregate (wire-formats §a.3.2, §d.3 `rpc`).
type RPCKey struct {
	Tenant, Site, Day, API, Operation, Network, Outcome, Latency, Verdict string
}

// AddRPC counts n for one aggregate cell. Values outside the label pattern are ignored (a programming error; the
// parser admits closed lists only).
func (a *Agg) AddRPC(k RPCKey, at time.Time, n int64) {
	if n <= 0 || !labelRe.MatchString(k.Operation) || !labelRe.MatchString(k.Outcome) || !labelRe.MatchString(k.Latency) {
		return
	}
	k.Day = Day(at)
	a.mu.Lock()
	if a.rpc == nil {
		a.rpc = map[RPCKey]int64{}
	}
	a.rpc[k] += n
	a.mu.Unlock()
}

// GetRPC returns one aggregate cell's current value (tests).
func (a *Agg) GetRPC(k RPCKey, at time.Time) int64 {
	k.Day = Day(at)
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.rpc[k]
}

func (a *Agg) takeRPC() map[RPCKey]int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	t := a.rpc
	a.rpc = nil
	return t
}

func (a *Agg) restoreRPC(t map[RPCKey]int64) {
	if len(t) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.rpc == nil {
		a.rpc = map[RPCKey]int64{}
	}
	for k, v := range t {
		a.rpc[k] += v
	}
}

func rpcRows(t map[RPCKey]int64) []spool.RPCCounter {
	rows := make([]spool.RPCCounter, 0, len(t))
	for k, v := range t {
		rows = append(rows, spool.RPCCounter{TenantID: k.Tenant, SiteID: k.Site, Day: k.Day, API: k.API, Operation: k.Operation,
			Network: k.Network, Outcome: k.Outcome, Latency: k.Latency, Verdict: k.Verdict, Count: v})
	}
	sort.Slice(rows, func(i, j int) bool {
		x := [...]string{rows[i].TenantID, rows[i].SiteID, rows[i].Day, rows[i].API, rows[i].Operation, rows[i].Network, rows[i].Outcome, rows[i].Latency, rows[i].Verdict}
		y := [...]string{rows[j].TenantID, rows[j].SiteID, rows[j].Day, rows[j].API, rows[j].Operation, rows[j].Network, rows[j].Outcome, rows[j].Latency, rows[j].Verdict}
		for n := range x {
			if x[n] != y[n] {
				return x[n] < y[n]
			}
		}
		return false
	})
	if len(rows) == 0 {
		return nil
	}
	return rows
}
