// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
)

// Tracker 1.2.0 schema v1 minor additions: wallet_connect_failed, wallet context,
// the WalletConnect funnel, the Privy wallet type, and the browser RPC aggregate (§a.3.2).

func TestStellarV1_2Additions(t *testing.T) {
	ok := []string{
		`"sv":1,"n":"wallet_connect_failed","wt":"freighter","net":"mainnet","fr":"wallet_not_installed","wc":"varial_inapp"`,
		`"sv":1,"n":"wallet_connect","wt":"privy","net":"testnet","ck":"new","wc":"none"`,
		`"sv":1,"n":"walletconnect_session","ws":"proposed","net":"mainnet","wc":"scopuly_inapp"`,
		`"sv":1,"n":"walletconnect_request","wm":"sign_submit_xdr","net":"testnet","ws":"rejected"`,
	}
	for _, f := range ok {
		if _, err := parseEvent(json.RawMessage(wl(f))); err != nil {
			t.Errorf("valid event refused: %s", f)
		}
	}
	bad := []string{
		`"sv":1,"n":"wallet_connect_failed","fr":"Error: wallet locked"`, // no error text
		`"sv":1,"n":"wallet_connect","wc":"freighter_5.2.1"`,             // never a version
		`"sv":1,"n":"walletconnect_request","wm":"stellar_signXDR"`,      // closed enum, not the raw method
		`"sv":1,"n":"walletconnect_session","ws":"expired"`,
		`"sv":1,"n":"wallet_connect","c":[]`, // cells only on the aggregate
	}
	for _, f := range bad {
		if _, err := parseEvent(json.RawMessage(wl(f))); err == nil {
			t.Errorf("schema violation accepted: %s", f)
		}
	}
	cases := []struct {
		in          string
		name, net   string
		props       map[string]string
		countedOnly bool
	}{
		{`"sv":1,"n":"wallet_connect_failed","wt":"lobstr","net":"mainnet","fr":"user_rejected","wc":"none"`, "wallet_connect_failed", "mainnet",
			map[string]string{"wallet": "lobstr", "failure_reason": "user_rejected", "wallet_context": "none"}, false},
		{`"sv":1,"n":"wallet_connect_failed","fr":"timeout"`, "wallet_connect_failed", "unknown",
			map[string]string{"wallet": "unknown", "failure_reason": "timeout"}, false},
		{`"sv":1,"n":"walletconnect_session","ws":"approved","net":"testnet","wc":"dcent_inapp"`, "walletconnect_session", "testnet",
			map[string]string{"wc_state": "approved", "wallet_context": "dcent_inapp"}, false},
		{`"sv":1,"n":"walletconnect_request","wm":"sign_xdr","net":"mainnet","ws":"approved"`, "walletconnect_request", "mainnet",
			map[string]string{"wc_method": "sign_xdr", "wc_state": "approved"}, true},
	}
	for _, c := range cases {
		e, err := parseEvent(json.RawMessage(wl(c.in)))
		if err != nil {
			t.Fatal(c.in, err)
		}
		st := ToStellar(e)
		if st.Name != c.name || st.Network != c.net || st.Stripped || st.CountedOnly() != c.countedOnly {
			t.Errorf("%s → %+v", c.in, st)
		}
		if len(st.Props) != len(c.props) {
			t.Errorf("%s props %v", c.in, st.Props)
		}
		for k, v := range c.props {
			if st.Props[k] != v {
				t.Errorf("%s: %s = %q, want %q", c.in, k, st.Props[k], v)
			}
			if !regexpLabel.MatchString(k) || !regexpLabel.MatchString(v) {
				t.Errorf("%s: %s/%s does not fit the rollup label pattern", c.in, k, v)
			}
		}
	}
}

func agg(cells string) string { return wl(`"sv":1,"n":"stellar_rpc","c":` + cells) }

func TestRPCAggregateSchema(t *testing.T) {
	e, err := parseEvent(json.RawMessage(agg(`[["rpc","get_latest_ledger","mainnet","ok","lt100ms",3],["horizon","accounts_id_payments","testnet","http_429","gt2000ms",1],["rpc","get_brand_new_method","testnet","ok","lt100ms",2]]`)))
	if err != nil {
		t.Fatal(err)
	}
	if !e.IsRPCAggregate() || len(e.RPC) != 3 || e.RPC[0] != (RPCCell{"rpc", "get_latest_ledger", "mainnet", "ok", "lt100ms", 3}) ||
		e.RPC[2].Operation != "other" {
		t.Fatalf("%+v", e)
	}
	many := make([]string, MaxRPCCells+1)
	for i := range many {
		many[i] = `["rpc","get_health","mainnet","ok","lt100ms",1]`
	}
	bad := []string{
		`[]`,
		`[["rpc","get_health","mainnet","ok","lt100ms"]]`,                         // five values
		`[["rpc","get_health","mainnet","ok","lt100ms","1"]]`,                     // count is a number
		`[["rpc","get_health","mainnet","ok","lt100ms",0]]`,                       // count ≥ 1
		`[["rpc","get_health","mainnet","ok","lt100ms",1000001]]`,                 // count ≤ 1e6
		`[["rpc","get_health","mainnet","ok","lt100ms",1.5]]`,                     // integer
		`[["grpc","get_health","mainnet","ok","lt100ms",1]]`,                      // api
		`[["rpc","get_health","pubnet","ok","lt100ms",1]]`,                        // network
		`[["rpc","get_health","mainnet","500","lt100ms",1]]`,                      // outcome
		`[["rpc","get_health","mainnet","ok","123ms",1]]`,                         // latency
		`[["horizon","/accounts/GA7QYNF7SOWQ3GLR2B","mainnet","ok","lt100ms",1]]`, // a URL or an address
		`[["rpc","` + strings.Repeat("a", 64) + `","mainnet","ok","lt100ms",1]]`,  // a hash
		`[` + strings.Join(many, ",") + `]`,
	}
	for _, c := range bad {
		if _, err := parseEvent(json.RawMessage(agg(c))); err == nil {
			t.Errorf("accepted %s", c)
		}
	}
	if _, err := parseEvent(json.RawMessage(wl(`"sv":1,"n":"stellar_rpc","wt":"freighter","c":[["rpc","get_health","mainnet","ok","lt100ms",1]]`))); err == nil {
		t.Error("an aggregate takes no wallet fields")
	}
	if _, err := parseEvent(json.RawMessage(wl(`"sv":1,"n":"stellar_rpc"`))); err == nil {
		t.Error("an aggregate needs cells")
	}
}

func TestRPCAggregateIsCountedOnlyAsDailyCells(t *testing.T) {
	e := newEnv(t, nil, "")
	e.payloadMod = func(p *snapshot.Payload) { p.Settings.CounterFeatures = []string{"props", "dev", "rpc"} }
	e.apply(baseSite(), "active")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	body := batch(tok, &c, goodSG, agg(`[["rpc","get_latest_ledger","mainnet","ok","lt100ms",3],["rpc","get_latest_ledger","mainnet","ok","lt100ms",2],["horizon","root","testnet","http_5xx","gt2000ms",1]]`))
	if rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: body}); rr.Code != 202 {
		t.Fatal(rr.Code)
	}
	// a retry of the same body (same event id) is not counted again
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: body})
	if len(e.sp.recs) != 0 {
		t.Fatalf("the aggregate reached the spool: %+v", e.sp.recs)
	}
	if rows := e.agg.WebRows(siteID); len(rows) != 0 {
		t.Fatalf("the aggregate produced web counters %v", rows)
	}
	if e.agg.PropRows(siteID) != 0 {
		t.Fatal("the aggregate is not a wallet event")
	}
	key := func(api, op, net, out, lat string) counters.RPCKey {
		return counters.RPCKey{Tenant: tenant, Site: siteID, API: api, Operation: op, Network: net, Outcome: out, Latency: lat, Verdict: "verified"}
	}
	if got := e.agg.GetRPC(key("rpc", "get_latest_ledger", "mainnet", "ok", "lt100ms"), e.now); got != 5 {
		t.Errorf("rpc cell = %d, want 5", got)
	}
	if got := e.agg.GetRPC(key("horizon", "root", "testnet", "http_5xx", "gt2000ms"), e.now); got != 1 {
		t.Errorf("horizon cell = %d, want 1", got)
	}
	// Next to a page view, the page view is spooled alone and counted; the aggregate adds nothing to it.
	tok, c = e.browser("203.0.113.6", chrome, "https://example.org")
	e.do(req{path: "/v1/e", ip: "203.0.113.6", ua: chrome, origin: "https://example.org",
		body: batch(tok, &c, goodSG, pv("/swap"), agg(`[["rpc","get_health","mainnet","ok","lt100ms",1]]`))})
	if len(e.sp.recs) != 1 || e.sp.recs[0].Kind != "pageview" {
		t.Fatalf("records %+v", e.sp.recs)
	}
	if e.agg.Get(tenant, siteID, e.now, "verdict", "verified") != 1 {
		t.Fatalf("verdict counts the page view only: %v", e.agg.WebRows(siteID))
	}
	// Without a challenge token the aggregate is rejected and never counted.
	e.do(req{path: "/v1/e", ip: "203.0.113.7", ua: chrome, origin: "https://example.org",
		body: batch("", nil, goodSG, agg(`[["rpc","get_events","mainnet","ok","lt100ms",9]]`))})
	if got := e.agg.GetRPC(key("rpc", "get_events", "mainnet", "ok", "lt100ms"), e.now); got != 0 {
		t.Errorf("rejected aggregate counted: %d", got)
	}
}

var regexpLabel = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)
