// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"maps"
	"math/rand/v2"
	"regexp"
	"slices"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

// Step 4d: anchor metrics of packages/anchor-otel and tools/ap-listener.

// anyDomain marks an open-valued key, checked by publicDomain / anchorClient instead of a set.
var anyDomain = newSet("\x00domain")

func init() {
	tx := map[string]set{keySep: withOther(anchorTxSeps), keyAnchorKind: withOther(anchorKinds), keyStellarNetwork: stellarNetworks}
	plus := func(m map[string]set, k string, s set) map[string]set { c := maps.Clone(m); c[k] = s; return c }
	allowedRuleKeys[MetricAnchorRequestDuration] = map[string]set{keySep: withOther(anchorSeps), keyAnchorStep: anchorSteps,
		keyAnchorOutcome: withOther(anchorOutcomes), keyAnchorHomeDomain: anyDomain, keyStellarNetwork: stellarNetworks}
	allowedRuleKeys[MetricAnchorEvents] = map[string]set{keyAnchorEvent: withOther(anchorEvents), keySep: withOther(anchorSeps),
		keyAnchorHomeDomain: anyDomain, keyStellarNetwork: stellarNetworks}
	allowedRuleKeys[MetricAnchorTransferCreated] = plus(tx, keyAnchorClient, anyDomain)
	allowedRuleKeys[MetricAnchorTransitions] = plus(plus(tx, keyAnchorStatusFrom, withOther(anchorStatusFrom)), keyAnchorStatus, withOther(anchorStatuses))
	allowedRuleKeys[MetricAnchorStatusDuration] = plus(tx, keyAnchorStatus, withOther(anchorStatuses))
	allowedRuleKeys[MetricAnchorTransferDuration] = plus(tx, keyAnchorStatus, withOther(anchorStatuses))
	allowedRuleKeys[MetricAnchorCustomerUpdates] = map[string]set{keyAnchorStatus: withOther(anchorCustomerState),
		keyAnchorClient: anyDomain, keyStellarNetwork: stellarNetworks}
	allowedRuleKeys[MetricAnchorQuotesCreated] = map[string]set{keyAnchorClient: anyDomain, keyStellarNetwork: stellarNetworks}
	for _, m := range []string{MetricAnchorRequestDuration, MetricAnchorStatusDuration, MetricAnchorTransferDuration} {
		ruleUnits[m] = "s"
	}
	ruleUnits[MetricAnchorEvents] = "{event}"
	ruleUnits[MetricAnchorTransferCreated] = "{transaction}"
	ruleUnits[MetricAnchorTransitions] = "{transition}"
	ruleUnits[MetricAnchorCustomerUpdates] = "{update}"
	ruleUnits[MetricAnchorQuotesCreated] = "{quote}"
}

func TestPublicDomainAndClient(t *testing.T) {
	for v, want := range map[string]string{
		"testanchor.stellar.org": "testanchor.stellar.org", "stellar.moneygram.com": "stellar.moneygram.com",
		"Anchor.Example.com": "", "localhost": "", "anchor.local": "", "anchor.test": "", "10.0.0.1": "",
		"anchor.com:8080": "", "https://anchor.com": "", "a." + strings.Repeat("b", 64) + ".com": "",
		strings.ToLower(hostileAccount) + ".com": "", strings.Repeat("ab", 20) + ".io": "",
		strings.Repeat("a.", 130) + "com": "", "anchor..com": "", "-anchor.com": "", "": "",
	} {
		if got := publicDomain(v); got != want {
			t.Errorf("publicDomain(%q) = %q, want %q", v, got, want)
		}
	}
	for v, want := range map[string]string{"vibrant.example.org": "vibrant.example.org", "my-wallet": "my-wallet",
		"_none": "_none", "Wallet": "_OTHER", hostileAccount: "_OTHER", strings.ToLower(hostileAccount): "_OTHER",
		"user@mail.com": "_OTHER", "a b": "_OTHER"} {
		if got := anchorClient(v); got != want {
			t.Errorf("anchorClient(%q) = %q, want %q", v, got, want)
		}
	}
}

func checkAnchorDomains(t *testing.T, md pmetric.Metrics) {
	t.Helper()
	for _, r := range md.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				for _, a := range pointAttrsOf(m) {
					if v, ok := a.Get(keyAnchorHomeDomain); ok && v.Str() != stellarOther && publicDomain(v.Str()) == "" {
						t.Errorf("%s: home domain %q", m.Name(), v.Str())
					}
					if v, ok := a.Get(keyAnchorClient); ok && anchorClient(v.Str()) != v.Str() {
						t.Errorf("%s: client %q", m.Name(), v.Str())
					}
				}
			}
		}
	}
}

func TestAnchorAttributeAllowList(t *testing.T) {
	h := newHarness(t, withSets(ClientSetAnchors))
	md, ms := stellarMetrics("wallet")
	d := histOf(ms, MetricAnchorRequestDuration, "ms")
	addHistPoint(d, testRecv, map[string]any{keySep: "24", keyAnchorStep: "deposit_interactive", keyAnchorOutcome: "ok",
		keyAnchorHomeDomain: "testanchor.stellar.org", keyStellarNetwork: "testnet",
		"url.full":        "https://testanchor.stellar.org/sep24/transactions/deposit/interactive?token=" + hostileSeed,
		"stellar.account": hostileAccount, "stellar.memo": "12345"})
	addHistPoint(d, testRecv, map[string]any{keySep: "99", keyAnchorStep: "steal", keyAnchorOutcome: "boom",
		keyAnchorHomeDomain: strings.ToLower(hostileAccount) + ".com", keyStellarNetwork: "mainnet"})
	addHistPoint(d, testRecv, map[string]any{keySep: "24"}) // no marker
	ev := sumOf(ms, MetricAnchorEvents, true)
	addCount(ev, testRecv, 2, map[string]any{keyAnchorEvent: "deposit_completed", keySep: "24",
		keyAnchorHomeDomain: "testanchor.stellar.org", keyStellarNetwork: "testnet", "stellar.amount": "100"})
	tr := sumOf(ms, MetricAnchorTransitions, true)
	addCount(tr, testRecv, 1, map[string]any{keySep: "31", keyAnchorKind: "receive", keyAnchorStatusFrom: "_new",
		keyAnchorStatus: "pending_receiver", keyStellarNetwork: "testnet", "stellar.anchor.transaction_id": "tx-" + hostileHash})
	cu := sumOf(ms, MetricAnchorCustomerUpdates, true)
	addCount(cu, testRecv, 1, map[string]any{keyAnchorStatus: "ACCEPTED", keyAnchorClient: "wallet.example.org",
		keyStellarNetwork: "testnet", "stellar.anchor.customer_id": hostileAccount})
	q := sumOf(ms, MetricAnchorQuotesCreated, true)
	addCount(q, testRecv, 1, map[string]any{keyStellarNetwork: "testnet"})
	addCount(q, testRecv, 1, map[string]any{keyStellarNetwork: "testnet", keyAnchorClient: hostileAccount})

	out := h.runMetrics(defaultMeta(), md)
	checkRuleInvariants(t, out)
	checkAnchorDomains(t, out)
	assertProtoAllowListMetrics(t, out, func(string, string) {})
	assertNoLeak(t, "anchor allow-list", marshalMetrics(t, out), false)
	if got, want := droppedCounts(t, out), map[string]int64{"wallet/" + ReasonMetricNotAllowed: 1}; !maps.Equal(got, want) {
		t.Errorf("drops %v, want %v", got, want)
	}
	got := map[string][]map[string]any{}
	for _, r := range out.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				for _, a := range pointAttrsOf(m) {
					got[m.Name()] = append(got[m.Name()], a.AsRaw())
				}
			}
		}
	}
	want := map[string][]map[string]any{
		MetricAnchorRequestDuration: {
			{keySep: "24", keyAnchorStep: "deposit_interactive", keyAnchorOutcome: "ok", keyAnchorHomeDomain: "testanchor.stellar.org", keyStellarNetwork: "testnet"},
			{keySep: "_OTHER", keyAnchorStep: "other", keyAnchorOutcome: "_OTHER", keyAnchorHomeDomain: "_OTHER", keyStellarNetwork: "mainnet"},
		},
		MetricAnchorEvents:          {{keyAnchorEvent: "deposit_completed", keySep: "24", keyAnchorHomeDomain: "testanchor.stellar.org", keyStellarNetwork: "testnet"}},
		MetricAnchorTransitions:     {{keySep: "31", keyAnchorKind: "receive", keyAnchorStatusFrom: "_new", keyAnchorStatus: "pending_receiver", keyStellarNetwork: "testnet"}},
		MetricAnchorCustomerUpdates: {{keyAnchorStatus: "ACCEPTED", keyAnchorClient: "wallet.example.org", keyStellarNetwork: "testnet"}},
		MetricAnchorQuotesCreated:   {{keyAnchorClient: "_none", keyStellarNetwork: "testnet"}, {keyAnchorClient: "_OTHER", keyStellarNetwork: "testnet"}},
	}
	for name, w := range want {
		g := got[name]
		if len(g) != len(w) {
			t.Errorf("%s: %v, want %v", name, g, w)
			continue
		}
		for i := range w {
			if !maps.Equal(g[i], w[i]) {
				t.Errorf("%s[%d] = %v, want %v", name, i, g[i], w[i])
			}
		}
	}
}

func TestAnchorNoSecretSurvives(t *testing.T) {
	h := newHarness(t, withSets(ClientSetAnchors))
	g := &hostileGen{r: rand.New(rand.NewPCG(2026, 1121))}
	keys := []string{keySep, keyAnchorStep, keyAnchorOutcome, keyAnchorHomeDomain, keyAnchorEvent, keyAnchorKind,
		keyAnchorStatus, keyAnchorStatusFrom, keyAnchorClient, "url.full", "stellar.account", "stellar.memo"}
	kept := 0
	names := slices.Sorted(maps.Keys(clientMetricSets[ClientSetAnchors]))
	for i := range 200 {
		g.fuzz = "an" + string(rune('a'+i%26))
		md, ms := stellarMetrics("wallet")
		g.resourceAttrs(md.ResourceMetrics().At(0).Resource().Attributes(), i)
		for _, n := range names {
			var a pcommon.Map
			if clientMetricSets[ClientSetAnchors][n].histogram() {
				a = addHistPoint(histOf(ms, n, "s"), testRecv, nil).Attributes()
			} else {
				dps := sumOf(ms, n, true)
				addCount(dps, testRecv, 1, nil)
				a = dps.At(0).Attributes()
			}
			for j, k := range keys {
				g.put(a, k, i+j, false)
			}
			g.pointAttrs(a, i)
			a.PutStr(keyStellarNetwork, g.text())
		}
		out := h.runMetrics(defaultMeta(), md)
		for _, n := range checkRuleInvariants(t, out) {
			kept += n
		}
		checkAnchorDomains(t, out)
		checkHostileOutput(t, "anchors", marshalMetrics(t, out), func(f func(string, string)) { assertProtoAllowListMetrics(t, out, f) })
		if t.Failed() {
			return
		}
	}
	if kept == 0 {
		t.Fatal("nothing kept")
	}
}

// The closed sets here equal packages/anchor-otel/src/classify.ts and tools/ap-listener/classify.go.
func TestAnchorSetsMatchSources(t *testing.T) {
	ts := string(readFile(t, "../../../packages/anchor-otel/src/classify.ts"))
	array := func(name string) set {
		m := regexp.MustCompile(`(?s)export const ` + name + ` = \[(.*?)\] as const;`).FindStringSubmatch(ts)
		if m == nil {
			t.Fatalf("%s not found", name)
		}
		out := newSet()
		for _, v := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(m[1], -1) {
			out[v[1]] = struct{}{}
		}
		return out
	}
	events := array("EVENTS")
	for k := range array("KINDS") {
		for l := range array("LIFECYCLE") {
			events[k+"_"+l] = struct{}{}
		}
	}
	gosrc := string(readFile(t, "../../../tools/ap-listener/classify.go"))
	goSet := func(name string) set {
		m := regexp.MustCompile(`(?s)\b` + name + `\s+= newSet\((.*?)\)\n`).FindStringSubmatch(gosrc)
		if m == nil {
			t.Fatalf("%s not found in ap-listener", name)
		}
		out := newSet()
		for _, v := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(m[1], -1) {
			out[v[1]] = struct{}{}
		}
		return out
	}
	for _, c := range []struct {
		name      string
		got, want set
	}{{"SEPS", array("SEPS"), anchorSeps}, {"STEPS", array("STEPS"), anchorSteps}, {"OUTCOMES", array("OUTCOMES"), anchorOutcomes},
		{"EVENTS", events, anchorEvents}, {"NETWORKS", array("NETWORKS"), stellarNetworks},
		{"txSeps", goSet("txSeps"), anchorTxSeps}, {"kinds", goSet("kinds"), anchorKinds},
		{"statuses", goSet("statuses"), anchorStatuses}, {"customerStatuses", goSet("customerStatuses"), anchorCustomerState},
		{"nonPublicTLD", goSet("nonPublicTLD"), nonPublicTLD}} {
		if !maps.Equal(c.got, c.want) {
			t.Errorf("%s: source %v\nCollector %v", c.name, slices.Sorted(maps.Keys(c.got)), slices.Sorted(maps.Keys(c.want)))
		}
	}
	if len(anchorEvents) != 44 || len(anchorSteps) != 27 || len(anchorOutcomes) != 12 || len(anchorStatuses) != 20 {
		t.Errorf("set sizes %d/%d/%d/%d", len(anchorEvents), len(anchorSteps), len(anchorOutcomes), len(anchorStatuses))
	}
	proc := string(readFile(t, "../../../tools/ap-listener/processor.go"))
	for _, n := range []string{MetricAnchorTransferCreated, MetricAnchorTransitions, MetricAnchorStatusDuration,
		MetricAnchorTransferDuration, MetricAnchorCustomerUpdates, MetricAnchorQuotesCreated} {
		if !strings.Contains(proc, `"`+n+`"`) {
			t.Errorf("ap-listener no longer emits %s", n)
		}
	}
}
