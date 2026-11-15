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

// Stellar event schema v1 (wire-formats §a.3.1, C-136, C-137): schema, legacy mapping, placement, counted-only
// routing and the property rows of the counter record.

func wl(fields string) string { return `{"id":"` + eid() + `","k":"wl","u":"/swap",` + fields + `}` }

func TestStellarV1Schema(t *testing.T) {
	ok := []string{
		`"sv":1,"n":"wallet_modal_opened"`,
		`"sv":1,"n":"sign_rejected","wt":"freighter","net":"mainnet","sk":"tx","dur":"lt5s","ec":"user_rejected"`,
		`"sv":1,"n":"tx_submitted","wt":"freighter","net":"testnet","rc":"try_again_later"`,
		`"sv":1,"n":"passkey_used","po":"sign","net":"futurenet"`,
		`"sv":1,"n":"smart_wallet_created","net":"local","wt":"passkey"`,
		`"sv":1,"n":"wallet_connect","wt":"injected_other","net":"unknown","ck":"restored"`,
		`"sv":1,"n":"sign_approved","ec":"internal"`, // misplaced but valid enum: stripped, not rejected
	}
	for _, f := range ok {
		if _, err := parseEvent(json.RawMessage(wl(f))); err != nil {
			t.Errorf("valid v1 event refused: %s", f)
		}
	}
	bad := []string{
		`"sv":2,"n":"wallet_connect"`,                                // only sv 1 exists
		`"sv":"1","n":"wallet_connect"`,                              // sv is an integer
		`"sv":1,"n":"wallet_connected"`,                              // legacy name under sv
		`"sv":1,"n":"wallet_connect","wid":"xbull"`,                  // legacy key under sv
		`"sv":1,"n":"wallet_connect","wt":"varial"`,                  // alias is not a v1 value
		`"sv":1,"n":"wallet_connect","net":"public"`,                 // legacy network value
		`"sv":1,"n":"tx_submitted","rc":"success","hash":"ab"`,       // no hashes, ever
		`"sv":1,"n":"wallet_connect","address":"GA7QYNF7SOWQ3GLR2B"`, // no addresses, ever
		`"sv":1,"n":"sign_rejected","ec":"Error: user said no"`,      // no error text
		`"n":"wallet_connect","wt":"xbull"`,                          // v1 key without sv
		`"n":"tx_submitted"`,                                         // v1 name without sv
	}
	for _, f := range bad {
		if _, err := parseEvent(json.RawMessage(wl(f))); err == nil {
			t.Errorf("schema violation accepted: %s", f)
		}
	}
}

func TestLegacyMappingAndPlacement(t *testing.T) {
	cases := []struct {
		in        string
		name, net string
		props     map[string]string
		stripped  bool
	}{
		{`"n":"wallet_connected","wid":"varial","net":"public"`, "wallet_connect", "mainnet",
			map[string]string{"wallet": "freighter", "connect_kind": "new"}, false},
		{`"n":"wallet_session_restored","wid":"hot_wallet","net":"testnet"`, "wallet_connect", "testnet",
			map[string]string{"wallet": "hot", "connect_kind": "restored"}, false},
		{`"n":"wallet_disconnected","wid":"wallet_connect"`, "wallet_disconnect", "unknown",
			map[string]string{"wallet": "walletconnect"}, false},
		{`"n":"sign_failed","wid":"other","sk":"auth_entry","dur":"gt30s","err":"rejected","net":"other"`, "sign_rejected", "unknown",
			map[string]string{"wallet": "unknown", "sign_kind": "auth_entry", "duration": "gt30s", "error_class": "user_rejected"}, false},
		{`"n":"sign_completed","wid":"xbull","sk":"tx_submit","dur":"lt5s"`, "sign_approved", "unknown",
			map[string]string{"wallet": "xbull", "sign_kind": "tx_submit", "duration": "lt5s"}, false},
		{`"n":"wallet_modal_closed","out":"dismissed","wid":"albedo"`, "wallet_modal_closed", "unknown",
			map[string]string{"outcome": "dismissed"}, true},
		{`"n":"wallet_modal_closed","out":"connected","wid":"albedo"`, "wallet_modal_closed", "unknown",
			map[string]string{"outcome": "connected", "wallet": "albedo"}, false},
		{`"n":"wallet_selected"`, "wallet_selected", "unknown", map[string]string{"wallet": "unknown"}, false},
		{`"sv":1,"n":"wallet_modal_opened","net":"mainnet"`, "wallet_modal_opened", "unknown", map[string]string{}, true},
		{`"sv":1,"n":"tx_submitted","rc":"failed"`, "tx_submitted", "unknown", map[string]string{"result_class": "failed"}, false},
		{`"sv":1,"n":"passkey_used","po":"register","wt":"passkey","net":"testnet"`, "passkey_used", "testnet",
			map[string]string{"passkey_op": "register"}, true},
		{`"sv":1,"n":"sign_requested","sk":"message","rc":"success"`, "sign_requested", "unknown",
			map[string]string{"wallet": "unknown", "sign_kind": "message"}, true},
	}
	for _, c := range cases {
		e, err := parseEvent(json.RawMessage(wl(c.in)))
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		st := ToStellar(e)
		if st.Name != c.name || st.Network != c.net || st.Stripped != c.stripped || len(st.Props) != len(c.props) {
			t.Errorf("%s → %+v", c.in, st)
			continue
		}
		for k, v := range c.props {
			if st.Props[k] != v {
				t.Errorf("%s: %s = %q, want %q", c.in, k, st.Props[k], v)
			}
		}
	}
}

// Every wallet value and key that can reach a counter record or Umami fits the database's closed lists
// (web_event_property_daily check, data-model §12.1) and carries no StrKey-shaped string.
func TestStellarValuesFitTheRollupCheck(t *testing.T) {
	allowed := map[string]map[string]bool{
		"_total": set("all"), "wallet": stellarWallets, "connect_kind": stellarConnect, "sign_kind": signKinds,
		"error_class": stellarErrClasses, "result_class": stellarResults, "duration": durations, "outcome": outcomes,
		"passkey_op": stellarPasskeyOps,
	}
	for legacy := range walletIDs {
		e := Event{K: "wl", N: "wallet_selected", WID: legacy}
		if v := ToStellar(e).Props["wallet"]; !stellarWallets[v] {
			t.Errorf("legacy wallet %q maps to %q, outside the v1 list", legacy, v)
		}
	}
	for n := range walletNames {
		e := Event{K: "wl", N: n, WID: "other", SK: "tx", Net: "public", Out: "connected", Dur: "lt5s", Err: "timeout"}
		st := ToStellar(e)
		if !stellarNames[st.Name] || !stellarNetworks[st.Network] {
			t.Errorf("legacy %s → %s/%s", n, st.Name, st.Network)
		}
		for _, kv := range st.PropRows() {
			if !allowed[kv[0]][kv[1]] {
				t.Errorf("%s: row %v outside the closed lists", n, kv)
			}
		}
	}
}

func TestCountedOnlyEventsNeverSpooled(t *testing.T) {
	e := newEnv(t, nil, "")
	e.payloadMod = func(p *snapshot.Payload) { p.Settings.CounterFeatures = []string{"props", "dev"} }
	e.apply(baseSite(), "active")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG,
		wl(`"sv":1,"n":"sign_requested","wt":"freighter","net":"mainnet","sk":"tx_submit"`),
		wl(`"sv":1,"n":"sign_approved","wt":"freighter","net":"mainnet","sk":"tx_submit","dur":"lt5s"`),
		wl(`"sv":1,"n":"tx_submitted","wt":"freighter","net":"mainnet","rc":"success"`),
		wl(`"sv":1,"n":"smart_wallet_created","wt":"passkey","net":"testnet"`),
		wl(`"sv":1,"n":"passkey_used","po":"sign","net":"testnet"`))})
	if rr.Code != 202 {
		t.Fatal(rr.Code)
	}
	if len(e.sp.recs) != 0 {
		t.Fatalf("counted-only events reached the spool: %+v", e.sp.recs)
	}
	// Only property rows: no verdict, reason, tracker-version, identifier, multiplicity or batch-level counter.
	if rows := e.agg.WebRows(siteID); len(rows) != 0 {
		t.Fatalf("counted-only events produced web counters %v", rows)
	}
	for _, c := range []struct{ ev, net, key, val string }{
		{"sign_requested", "mainnet", "_total", "all"}, {"sign_requested", "mainnet", "sign_kind", "tx_submit"},
		{"sign_approved", "mainnet", "duration", "lt5s"}, {"tx_submitted", "mainnet", "result_class", "success"},
		{"smart_wallet_created", "testnet", "wallet", "passkey"}, {"passkey_used", "testnet", "passkey_op", "sign"},
	} {
		if got := e.agg.GetProp(counters.PropKey{Tenant: tenant, Site: siteID, Event: c.ev, Network: c.net, Key: c.key, Value: c.val, Verdict: "verified"}, e.now); got != 1 {
			t.Errorf("%v = %d", c, got)
		}
	}
	// A mixed batch: the forwarded wallet event and the page view are spooled, the counted-only one is not.
	tok, c = e.browser("203.0.113.6", chrome, "https://example.org")
	e.do(req{path: "/v1/e", ip: "203.0.113.6", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/swap"),
		wl(`"sv":1,"n":"wallet_connect","wt":"xbull","net":"testnet","ck":"new"`),
		wl(`"sv":1,"n":"sign_rejected","wt":"xbull","net":"testnet","sk":"tx","dur":"5_30s","ec":"timeout"`))})
	if len(e.sp.recs) != 2 || e.sp.recs[1].Name != "wallet_connect" {
		t.Fatalf("records %+v", e.sp.recs)
	}
	d := e.sp.recs[1].Data
	if d["wallet"] != "xbull" || d["network"] != "testnet" || d["connect_kind"] != "new" || len(d) != 3 {
		t.Fatalf("forwarded data under rollup keys: %v", d)
	}
	if e.agg.Get(tenant, siteID, e.now, "verdict", "verified") != 2 {
		t.Fatalf("verdict counter must count the two forwarded events only: %v", e.agg.WebRows(siteID))
	}
	all, _ := json.Marshal(e.sp.recs)
	if regexp.MustCompile(`[GCMSTXPLBW][A-Z2-7]{55}`).Match(all) || strings.Contains(string(all), "sign_rejected") {
		t.Fatalf("spool %s", all)
	}
}

func TestCountedOnlyEventsDoNotUseQuota(t *testing.T) {
	e := newEnv(t, func(s *snapshot.Site) { s.DailyQuota = 1 }, "")
	for i := 0; i < 3; i++ {
		tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org",
			body: batch(tok, &c, goodSG, wl(`"sv":1,"n":"tx_submitted","net":"mainnet","rc":"success"`))})
		if rr.Code != 202 {
			t.Fatalf("counted-only event refused by the quota: %d", rr.Code)
		}
	}
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	if rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"))}); rr.Code != 202 {
		t.Fatalf("the quota's one verified event must still be available: %d", rr.Code)
	}
	tok, c = e.browser("203.0.113.5", chrome, "https://example.org")
	if rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"))}); rr.Code != 429 {
		t.Fatalf("quota of 1 must refuse the second page view: %d", rr.Code)
	}
}

func TestRejectedWalletEventsHaveNoProps(t *testing.T) {
	e := newEnv(t, nil, "")
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org",
		body: batch("", nil, goodSG, wl(`"sv":1,"n":"wallet_connect","wt":"xbull","net":"mainnet","ck":"new"`))})
	if e.agg.PropRows(siteID) != 0 {
		t.Fatal("a rejected event must never be counted in the property rollup")
	}
	if e.agg.Get(tenant, siteID, e.now, "verdict", "rejected") != 1 {
		t.Fatal("a rejected forwarded-kind event still counts its verdict")
	}
}
