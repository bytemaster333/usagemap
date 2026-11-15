// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"encoding/json"
	"regexp"
)

// Browser-side Stellar RPC / Horizon telemetry (wire-formats §a.3.2): the tracker's
// `/stellar-rpc` subpath sends ONE aggregate per page-visibility period and UTC day, a `wl` event with `sv: 1`,
// `n: "stellar_rpc"` and the cells `c` = [[api, operation, network, outcome, latency bucket, count], …]. The gateway
// counts the cells into the per-site daily table `web_rpc_client_daily` (counter record part `rpc`, §d.3) and
// nothing else: the event is never spooled, never forwarded, adds no web counter, no quota and no multiplicity
// observation, and its `u` (page path) is read only by the schema check and then dropped. It carries no visitor key.

// AggregateRPC is the event name of the browser RPC aggregate.
const AggregateRPC = "stellar_rpc"

// MaxRPCCells bounds the cells of one aggregate (the tracker sends at most 100).
const MaxRPCCells = 100

// MaxRPCCount bounds one cell's count.
const MaxRPCCount = 1_000_000

// RPCCell is one cell of a `stellar_rpc` aggregate after validation.
type RPCCell struct {
	API, Operation, Network, Outcome, Latency string
	Count                                     int64
}

var (
	rpcAPIs      = set("rpc", "horizon")
	rpcOutcomes  = set("ok", "rpc_error", "http_4xx", "http_429", "http_5xx", "timeout", "network_error")
	rpcLatencies = set("lt100ms", "100_500ms", "500_2000ms", "gt2000ms")
	reRPCOp      = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)
	// RPC methods (js-stellar-sdk 17.4.0 `src/rpc/server.ts`) in snake case.
	rpcOperations = set("get_health", "get_network", "get_latest_ledger", "get_ledgers", "get_ledger_entries", "get_events",
		"get_fee_stats", "get_version_info", "get_transaction", "get_transactions", "simulate_transaction",
		"send_transaction", "query_events", "other")
	// Horizon route templates (the closed list of packages/stellar-otel) in snake case: `/` → root,
	// `/accounts/{id}/data/{key}` → accounts_id_data_key.
	horizonOperations = set("root", "accounts", "accounts_id", "accounts_id_data_key", "accounts_id_effects",
		"accounts_id_offers", "accounts_id_operations", "accounts_id_payments", "accounts_id_trades",
		"accounts_id_transactions", "assets", "claimable_balances", "claimable_balances_id",
		"claimable_balances_id_operations", "claimable_balances_id_transactions", "effects", "fee_stats", "friendbot",
		"health", "ledgers", "ledgers_id", "ledgers_id_effects", "ledgers_id_operations", "ledgers_id_payments",
		"ledgers_id_transactions", "liquidity_pools", "liquidity_pools_id", "liquidity_pools_id_effects",
		"liquidity_pools_id_operations", "liquidity_pools_id_trades", "liquidity_pools_id_transactions", "offers",
		"offers_id", "offers_id_trades", "operations", "operations_id", "operations_id_effects", "order_book", "paths",
		"paths_strict_receive", "paths_strict_send", "payments", "trade_aggregations", "trades", "transactions",
		"transactions_id", "transactions_id_effects", "transactions_id_operations", "transactions_id_payments",
		"transactions_async", "other")
)

// rpcOperation keeps a known operation of the api and folds any other well-formed one into `other`, so a tracker
// that learnt a new RPC method or Horizon route before this gateway never costs the whole batch (a malformed one
// is still a schema violation).
func rpcOperation(api, op string) (string, bool) {
	if !reRPCOp.MatchString(op) {
		return "", false
	}
	known := rpcOperations
	if api == "horizon" {
		known = horizonOperations
	}
	if known[op] {
		return op, true
	}
	return "other", true
}

// parseRPCAggregate validates a `stellar_rpc` aggregate (schema `$defs/stellarAggregate`): exactly the keys id, k, u,
// n, sv, c; 1–100 cells of six values from the closed lists. Anything else is a schema violation (400).
func parseRPCAggregate(m map[string]json.RawMessage, e Event) (Event, error) {
	if !onlyKeys(m, "id", "k", "u", "n", "sv", "c") {
		return e, errMalformed
	}
	var cells [][]json.RawMessage
	if json.Unmarshal(m["c"], &cells) != nil || len(cells) < 1 || len(cells) > MaxRPCCells {
		return e, errMalformed
	}
	e.SV, e.N = 1, AggregateRPC
	for _, c := range cells {
		if len(c) != 6 {
			return e, errMalformed
		}
		var s [5]string
		for i := range s {
			if json.Unmarshal(c[i], &s[i]) != nil {
				return e, errMalformed
			}
		}
		if len(c[5]) == 0 || c[5][0] == '"' {
			return e, errMalformed
		}
		n, ok := intVal(c[5])
		if !ok || n < 1 || n > MaxRPCCount {
			return e, errMalformed
		}
		op, ok := rpcOperation(s[0], s[1])
		if !rpcAPIs[s[0]] || !ok || !stellarNetworks[s[2]] || !rpcOutcomes[s[3]] || !rpcLatencies[s[4]] {
			return e, errMalformed
		}
		e.RPC = append(e.RPC, RPCCell{API: s[0], Operation: op, Network: s[2], Outcome: s[3], Latency: s[4], Count: n})
	}
	return e, nil
}

// IsRPCAggregate reports whether a parsed event is the browser RPC aggregate.
func (e Event) IsRPCAggregate() bool { return e.K == "wl" && e.SV == 1 && e.N == AggregateRPC }
