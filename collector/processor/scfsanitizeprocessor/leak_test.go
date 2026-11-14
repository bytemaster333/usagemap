// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"encoding/base32"
	"encoding/base64"
	"fmt"
	"maps"
	"math/rand/v2"
	"regexp"
	"slices"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor/processortest"
)

// Secret- and identifier-shaped values are generated at run time from their
// published formats; none is stored in the repository.

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// strKey encodes a SEP-23 StrKey: version byte ‖ payload ‖ CRC16-XModem (LE).
func strKey(version byte, payload []byte) string {
	raw := append([]byte{version}, payload...)
	crc := crc16XModem(raw)
	raw = append(raw, byte(crc), byte(crc>>8))
	return b32.EncodeToString(raw)
}

func crc16XModem(b []byte) uint16 {
	var crc uint16
	for _, c := range b {
		crc ^= uint16(c) << 8
		for range 8 {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

func payload(r *rand.Rand, n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(r.Uint32())
	}
	return b
}

// testSeed returns a valid-checksum secret seed (S…, version 18<<3).
func testSeed(n uint64) string {
	r := rand.New(rand.NewPCG(n, 42))
	return strKey(18<<3, payload(r, 32))
}

func testAccount(r *rand.Rand) string  { return strKey(6<<3, payload(r, 32)) }  // G…
func testContract(r *rand.Rand) string { return strKey(2<<3, payload(r, 32)) }  // C…
func testMuxed(r *rand.Rand) string    { return strKey(12<<3, payload(r, 40)) } // M…

func testJWT(r *rand.Rand) string {
	enc := base64.RawURLEncoding
	h := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	p := enc.EncodeToString(fmt.Appendf(nil, `{"sub":"%d","name":"canary"}`, r.Uint32()))
	return h + "." + p + "." + enc.EncodeToString(payload(r, 32))
}

func testEmail(r *rand.Rand) string {
	return fmt.Sprintf("canary.user%d@example%d.com", r.IntN(1000), r.IntN(10))
}

// Shapes that must never appear in a sanitised payload (wire-formats §f.5,
// ADR-0012, C-114): a seed anywhere in any case; a whole path segment or value
// that has the StrKey shape (any SEP-23 version letter, 56 or 69 base32
// characters, any case, valid checksum or not); an e-mail address; a JWT; the
// documentation IP ranges the generators use (203.0.113.0/24, 2001:db8::/32),
// with or without a port; a query string.
var leakPatterns = map[string]*regexp.Regexp{
	"seed":   regexp.MustCompile(`(?i)s[a-d][a-z2-7]{54}`),
	"strkey": regexp.MustCompile(`(?i)(^|[/"])[gmstxpclbw][a-z2-7]{55}([a-z2-7]{13})?([/"]|$)`),
	"email":  regexp.MustCompile(`(?i)[a-z0-9._%+-]+(@|%40)[a-z0-9-]+\.[a-z0-9.-]+`),
	// The JWT shape of pathnorm (S1.jwt): header and payload segments.
	"jwt":   regexp.MustCompile(`eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.`),
	"ipv4":  regexp.MustCompile(`203\.0\.113\.[0-9]`),
	"ipv6":  regexp.MustCompile(`(?i)2001:0?db8:`),
	"query": regexp.MustCompile(`(?i)[?&][a-z_]+=`),
}

// canaryPattern finds the canary values of the fixtures and generators in
// attributes that must have been dropped.
var canaryPattern = regexp.MustCompile(`(?i)canary`)

func assertNoLeak(t testing.TB, what string, b []byte, canaries bool) {
	t.Helper()
	if name, at := leakIn(b, canaries); name != "" {
		t.Fatalf("%s: %s-shaped value survived sanitising: …%s…", what, name, at)
	}
}

// leakIn returns the first leak-pattern match in b and its surroundings.
func leakIn(b []byte, canaries bool) (string, []byte) {
	patterns := maps.Clone(leakPatterns)
	if canaries {
		patterns["canary"] = canaryPattern
	}
	for _, name := range slices.Sorted(maps.Keys(patterns)) {
		if loc := patterns[name].FindIndex(b); loc != nil {
			from, to := max(0, loc[0]-40), min(len(b), loc[1]+40)
			return name, b[from:to]
		}
	}
	return "", nil
}

func marshalMetrics(t testing.TB, md pmetric.Metrics) []byte {
	b, err := (&pmetric.JSONMarshaler{}).MarshalMetrics(md)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func marshalTraces(t testing.TB, td ptrace.Traces) []byte {
	b, err := (&ptrace.JSONMarshaler{}).MarshalTraces(td)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// hostile builds a path-like string with every kind of secret and identifier
// in path segments, matrix parameters, the query and the fragment.
func hostile(r *rand.Rand, fuzz string) string {
	parts := []string{
		testSeed(r.Uint64()), strings.ToLower(testSeed(r.Uint64())), testAccount(r), testContract(r), testMuxed(r),
		testJWT(r), testEmail(r), strings.ReplaceAll(testEmail(r), "@", "%40"), "mailto:" + testEmail(r),
		"x" + testSeed(r.Uint64()) + "y", "sk_live_" + b32.EncodeToString(payload(r, 20)), fuzz,
		"USDC:" + testAccount(r), "prefix-" + testJWT(r),
	}
	r.Shuffle(len(parts), func(i, j int) { parts[i], parts[j] = parts[j], parts[i] })
	n := 1 + r.IntN(len(parts))
	var b strings.Builder
	if r.IntN(4) == 0 {
		b.WriteString("https://api.example")
	}
	for _, p := range parts[:n] {
		b.WriteString("/")
		b.WriteString(p)
		if r.IntN(8) == 0 {
			b.WriteString(";jsessionid=" + testJWT(r))
		}
	}
	switch r.IntN(3) {
	case 0:
		b.WriteString("?email=" + testEmail(r) + "&key=" + testSeed(r.Uint64()))
	case 1:
		b.WriteString("#" + testAccount(r))
	}
	return b.String()
}

// sensitive returns one value the sanitiser must remove or replace wherever
// it appears: a seed, StrKeys, a muxed address, a JWT, e-mail addresses, IP
// addresses with and without ports, a URL with a query, an API key.
func sensitive(r *rand.Rand) string {
	switch r.IntN(14) {
	case 0:
		return testSeed(r.Uint64())
	case 1:
		return strings.ToLower(testSeed(r.Uint64()))
	case 2:
		return testAccount(r)
	case 3:
		return testMuxed(r)
	case 4:
		return testContract(r)
	case 5:
		return testJWT(r)
	case 6:
		return testEmail(r)
	case 7:
		return fmt.Sprintf("203.0.113.%d", r.IntN(256))
	case 8:
		return fmt.Sprintf("203.0.113.%d:%d", r.IntN(256), 1+r.IntN(65535))
	case 9:
		return fmt.Sprintf("2001:db8::%x", r.IntN(65536))
	case 10:
		return fmt.Sprintf("[2001:db8::%x]:%d", r.IntN(65536), 1+r.IntN(65535))
	case 11:
		return "https://api.example/p?token=" + testJWT(r) + "&email=" + testEmail(r)
	case 12:
		return "sk_live_" + b32.EncodeToString(payload(r, 20))
	default:
		return "USDC:" + testAccount(r)
	}
}

// hostileGen produces hostile values and counts how many it placed.
type hostileGen struct {
	r     *rand.Rand
	fuzz  string
	paths int // hostile path-like values placed in route inputs
	vals  int // hostile values placed anywhere
}

// text is a free-text value: the canary marker, the fuzz input and at least
// one sensitive value, so the whole value must be replaced or dropped.
func (g *hostileGen) text() string {
	g.vals++
	sep := " "
	if g.r.IntN(2) == 0 {
		sep = "-" // no space: passes the rpc.* character set, must still be classified
	}
	return "canary" + sep + strings.ReplaceAll(g.fuzz, " ", "") + sep + sensitive(g.r)
}

// path is a route input full of secrets.
func (g *hostileGen) path() string {
	g.paths++
	g.vals++
	return hostile(g.r, g.fuzz) + "/" + sensitive(g.r)
}

// putAll sets key to a hostile value of every value type that can carry a
// string, cycling through them by variant.
func (g *hostileGen) put(m pcommon.Map, key string, variant int, path bool) {
	v := g.text()
	if path {
		v = g.path()
	}
	switch variant % 4 {
	case 0:
		m.PutStr(key, v)
	case 1:
		m.PutEmptyBytes(key).FromRaw([]byte(v))
	case 2:
		sl := m.PutEmptySlice(key)
		sl.AppendEmpty().SetStr(v)
		sl.AppendEmpty().SetStr(g.text())
	default:
		mm := m.PutEmptyMap(key)
		mm.PutStr("k", v)
		mm.PutEmptySlice("s").AppendEmpty().SetStr(g.text())
	}
}

var (
	hostileResourceKeys = []string{keyServiceName, keyServiceNamespace, keyServiceInstance, keyDeployEnvName, keyDeployEnvLegacy,
		"host.name", "process.command_args", "enduser.id", "tenant.id", AttrTenantID, AttrStreamInstance, AttrReceivedAt, AttrTenantLevel}
	hostilePointKeys = []string{keyHTTPRoute, keyHTTPTarget, keyURLPath, keyURLFull, keyHTTPURL, keyMethod, keyMethodLegacy,
		keyStatus, keyStatusLegacy, keyRPCMethod, keyRPCSystem, keyRPCSystemName, keyMetricOverflow,
		"user_agent.original", "client.address", "url.query", "enduser.id", "server.address", "http.host",
		"exception.message", AttrRoute, AttrRulesVersion, AttrMarker, AttrReason, AttrDroppedCount}
	routeKeys = map[string]bool{keyHTTPRoute: true, keyHTTPTarget: true, keyURLPath: true, keyURLFull: true, keyHTTPURL: true}
)

// resourceAttrs fills a resource: the variant decides the value types; for
// variant 0 the allow-listed keys are strings, so they reach the classifier.
func (g *hostileGen) resourceAttrs(m pcommon.Map, variant int) {
	for i, k := range hostileResourceKeys {
		g.put(m, k, variant+i*(variant%2), false)
	}
}

func (g *hostileGen) pointAttrs(m pcommon.Map, variant int) {
	for i, k := range hostilePointKeys {
		v := variant
		if variant > 0 {
			v += i
		}
		g.put(m, k, v, routeKeys[k])
	}
}

func (g *hostileGen) scope(sc pcommon.InstrumentationScope) {
	sc.SetName(g.text())
	sc.SetVersion(g.text())
	g.put(sc.Attributes(), "x", 0, false)
	sc.SetDroppedAttributesCount(7)
}

// hostileMetrics: hostile values in every string field of every level —
// resource attributes (all value types) and schema URL, scope name, version,
// attributes and schema URL, metric name, description, unit and metadata,
// point attributes (all value types, all allow-listed keys), exemplars — of
// kept and dropped metrics alike. Entity refs are added by withHostileRefs.
func (g *hostileGen) metrics() pmetric.Metrics {
	md := pmetric.NewMetrics()
	for variant := range 4 {
		r := md.ResourceMetrics().AppendEmpty()
		r.SetSchemaUrl("https://schema.example/" + g.text())
		g.resourceAttrs(r.Resource().Attributes(), variant)
		r.Resource().SetDroppedAttributesCount(3)
		sm := r.ScopeMetrics().AppendEmpty()
		sm.SetSchemaUrl("https://schema.example/" + g.text())
		g.scope(sm.Scope())
		for _, name := range []string{MetricServerDuration, MetricServerDurationLegacy, g.text()} {
			m := sm.Metrics().AppendEmpty()
			m.SetName(name)
			m.SetDescription(g.text())
			unit := "s"
			if name == MetricServerDurationLegacy {
				unit = "ms"
			}
			m.SetUnit(unit)
			g.put(m.Metadata(), "x", variant, false)
			h := m.SetEmptyHistogram()
			h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
			for p := range 3 {
				dp := addHistPoint(h.DataPoints(), testRecv-second, nil)
				g.pointAttrs(dp.Attributes(), variant*3+p)
				ex := dp.Exemplars().AppendEmpty()
				g.put(ex.FilteredAttributes(), "enduser.id", p, false)
				ex.SetDoubleValue(1)
			}
		}
		m := sm.Metrics().AppendEmpty()
		m.SetName(MetricServerDuration)
		m.SetUnit(g.text())
		addHistPoint(m.SetEmptyHistogram().DataPoints(), testRecv-second, nil)
		e := sm.Metrics().AppendEmpty()
		e.SetName(MetricServerDuration)
		e.SetUnit("s")
		eh := e.SetEmptyExponentialHistogram()
		eh.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
		dp := eh.DataPoints().AppendEmpty()
		expPoint(3, 1, []uint64{1, 2}, 1).CopyTo(dp)
		dp.SetStartTimestamp(pcommon.Timestamp(testRecv - minute))
		dp.SetTimestamp(pcommon.Timestamp(testRecv - second))
		g.pointAttrs(dp.Attributes(), variant)
		g.put(dp.Exemplars().AppendEmpty().FilteredAttributes(), "x", variant, false)
		s := sm.Metrics().AppendEmpty()
		s.SetName(g.text())
		g.pointAttrs(s.SetEmptySum().DataPoints().AppendEmpty().Attributes(), variant)
	}
	return md
}

// hostileTraces: as hostileMetrics, plus span name, status message, trace
// state, events (name, attributes) and links (trace state, attributes).
func (g *hostileGen) traces() ptrace.Traces {
	td := ptrace.NewTraces()
	for variant := range 4 {
		rs := td.ResourceSpans().AppendEmpty()
		rs.SetSchemaUrl("https://schema.example/" + g.text())
		g.resourceAttrs(rs.Resource().Attributes(), variant)
		ss := rs.ScopeSpans().AppendEmpty()
		ss.SetSchemaUrl("https://schema.example/" + g.text())
		g.scope(ss.Scope())
		for i := range 4 {
			sp := addServerSpan(ss.Spans(), testRecv-second, nil)
			g.pointAttrs(sp.Attributes(), variant*4+i)
			if i == 3 {
				sp.SetKind(ptrace.SpanKindClient)
			}
			sp.SetName("GET " + g.path())
			sp.Status().SetMessage(g.text())
			sp.Status().SetCode(ptrace.StatusCodeError)
			sp.TraceState().FromRaw("vendor=" + strings.ToLower(testAccount(g.r))[:20] + ",ot=th:c;rv:" + strings.Repeat("a", 14))
			ev := sp.Events().AppendEmpty()
			ev.SetName(g.text())
			g.put(ev.Attributes(), "exception.stacktrace", i, true)
			ln := sp.Links().AppendEmpty()
			ln.TraceState().FromRaw("vendor=" + strings.ToLower(testAccount(g.r))[:20])
			g.put(ln.Attributes(), "x", i, false)
			sp.SetDroppedAttributesCount(1)
		}
	}
	return td
}

// withHostileRefs adds hostile resource entity references (JSON round trip).
func withHostileRefs(t testing.TB, g *hostileGen, b []byte) []byte {
	g.vals += 6
	return withEntityRefs(t, b, []map[string]any{{
		"schemaUrl": "https://schema.example/" + g.text(), "type": g.text(),
		"idKeys": []string{g.text(), sensitive(g.r)}, "descriptionKeys": []string{g.text(), sensitive(g.r)},
	}})
}

func (g *hostileGen) metricsWithRefs(t testing.TB) pmetric.Metrics {
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(withHostileRefs(t, g, marshalMetrics(t, g.metrics())))
	if err != nil {
		t.Fatal(err)
	}
	return md
}

func (g *hostileGen) tracesWithRefs(t testing.TB) ptrace.Traces {
	td, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces(withHostileRefs(t, g, marshalTraces(t, g.traces())))
	if err != nil {
		t.Fatal(err)
	}
	return td
}

// checkHostileOutput: proto-level allow-list, every string on the wire free
// of leak shapes, the JSON form free of leak shapes and (outside scf.route,
// whose literal segments pathnorm keeps by design) of canaries.
func checkHostileOutput(t testing.TB, what string, json []byte, allow func(func(path, s string))) {
	t.Helper()
	allow(func(path, s string) {
		if name, at := leakIn([]byte(s), false); name != "" {
			t.Fatalf("%s: %s: %s-shaped value: …%s…", what, path, name, at)
		}
	})
	assertNoLeak(t, what, json, false)
	assertNoLeak(t, what, routesRemoved(json), true)
}

func runHostile(t testing.TB, ms func(pmetric.Metrics) pmetric.Metrics, ts func(ptrace.Traces) ptrace.Traces, g *hostileGen) {
	td := ts(g.tracesWithRefs(t))
	if td.SpanCount() == 0 {
		t.Fatal("no spans forwarded: the test would prove nothing")
	}
	checkHostileOutput(t, "traces", marshalTraces(t, td), func(f func(string, string)) { assertProtoAllowListTraces(t, td, f) })
	md := ms(g.metricsWithRefs(t))
	if md.DataPointCount() == 0 {
		t.Fatal("no points forwarded: the test would prove nothing")
	}
	checkHostileOutput(t, "metrics", marshalMetrics(t, md), func(f func(string, string)) { assertProtoAllowListMetrics(t, md, f) })
}

// TestNoSecretSurvives50k is the end-to-end leak check (C-114): hostile
// values — seeds in any case, StrKeys of four types, muxed addresses, JWTs,
// e-mail addresses (plain, %40, mailto:), IPv4/IPv6 with and without ports,
// URLs with queries, API keys, matrix parameters, fragments — in every string
// field and every string-carrying value type of traces and metrics, kept and
// dropped alike, until at least 50,000 hostile paths went through the route
// inputs. Nothing seed-, StrKey-, e-mail-, JWT-, IP- or query-shaped and no
// canary may survive, and the output passes the proto-level allow-list.
func TestNoSecretSurvives50k(t *testing.T) {
	h := newHarness(t)
	g := &hostileGen{r: rand.New(rand.NewPCG(2026, 11))}
	for i := 0; g.paths < 50_000; i++ {
		g.fuzz = fmt.Sprintf("seg%d", i)
		runHostile(t, func(md pmetric.Metrics) pmetric.Metrics { return h.runMetrics(defaultMeta(), md) },
			func(td ptrace.Traces) ptrace.Traces { return h.runTraces(defaultMeta(), td) }, g)
	}
	t.Logf("%d hostile paths, %d hostile values", g.paths, g.vals)
}

// FuzzSanitizeNoLeak lets the fuzzer choose one string, which is placed next
// to generated secrets in every field; canaries are checked.
func FuzzSanitizeNoLeak(f *testing.F) {
	for _, s := range []string{"", "x", "%2F..%2F", "{unknown}", "[...slug]", ":id", "a@b.c", "eyJhbGciOi.eyJzdWIi.x",
		"S" + strings.Repeat("A", 55), "canary", "?a=b", "203.0.113.9:80", "[2001:db8::1]:443", "\x00", "{redacted}"} {
		f.Add(s, uint64(1))
	}
	s, err := newSanitizer(processortest.NewNopSettings(componentType), createDefaultConfig())
	if err != nil {
		f.Fatal(err)
	}
	ctx := defaultMeta().ctx()
	f.Fuzz(func(t *testing.T, seg string, seed uint64) {
		g := &hostileGen{r: rand.New(rand.NewPCG(seed, 7)), fuzz: seg}
		runHostile(t, func(md pmetric.Metrics) pmetric.Metrics { out, _ := s.processMetrics(ctx, md); return out },
			func(td ptrace.Traces) ptrace.Traces { out, _ := s.processTraces(ctx, td); return out }, g)
	})
}
