// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/challenge"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
)

// Regression tests for the ingest-path security hardening (forged tokens, oversized and malformed batches, replay).

// forgeToken builds a well-formed token with a junk MAC, as a script that never called /v1/c would.
func forgeToken(epoch uint32, issued time.Time) string {
	b := []byte{1}
	b = binary.BigEndian.AppendUint32(b, epoch)
	ref := challenge.SiteRef(siteKey)
	b = append(b, ref[:]...)
	var ms [8]byte
	binary.BigEndian.PutUint64(ms[:], uint64(issued.UnixMilli()))
	b = append(b, ms[2:]...)
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	b = append(b, nonce...)
	b = append(b, make([]byte, 8)...)                 // ctx
	b = binary.BigEndian.AppendUint16(b, 256)         // cost
	b = binary.BigEndian.AppendUint16(b, 32)          // max
	b = append(b, 0, 0, 0, 0, 0)                      // pfx, prof
	b = append(b, []byte(strings.Repeat("x", 32))...) // mac
	return base64.RawURLEncoding.EncodeToString(b)
}

// A made-up token (any epoch the node does not hold) is rejected/challenge_invalid, never suspect.
func TestForgedTokenIsRejected(t *testing.T) {
	e := newEnv(t, nil, "")
	for _, epoch := range []uint32{7, challenge.Epoch(e.now) + 500, challenge.Epoch(e.now) - 3} {
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.9", ua: chrome, origin: "https://example.org", body: batch(forgeToken(epoch, e.now), nil, goodSG, pv("/f"))})
		if rr.Code != 202 {
			t.Fatalf("epoch %d: %d", epoch, rr.Code)
		}
	}
	if len(e.sp.recs) != 0 || e.reasons()["challenge_invalid"] != 3 || e.reasons()["challenge_unverifiable"] != 0 {
		t.Fatalf("forged tokens: records %d reasons %v", len(e.sp.recs), e.reasons())
	}
}

// One address cannot take a site's genuine visitors offline — neither with token-less junk (its own
// budget, answered 202) nor with a real token (the per-subnet limit is capped below the node's site share), and a
// request refused by the subnet limit never spends the site budget.
func TestOneSubnetCannotExhaustTheSiteBudget(t *testing.T) {
	e := newEnv(t, func(s *snapshot.Site) { s.RateLimitPerMin = 40 }, "")
	// Token-less flood from one address.
	for i := 0; i < 200; i++ {
		e.do(req{path: "/v1/e", ip: "198.51.100.66", ua: chrome, origin: "https://example.org", body: batch("", nil, goodSG, pv("/junk"))})
	}
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	if rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/legit"))}); rr.Code != 202 || len(e.sp.recs) != 1 {
		t.Fatalf("genuine visitor after a token-less flood: %d, %d records", rr.Code, len(e.sp.recs))
	}
	// Authenticated flood (a real token reused) from one subnet: capped at max(40/4, 10) = 10 per minute.
	atok, ac := e.browser("192.0.2.66", chrome, "https://example.org")
	codes := map[int]int{}
	for i := 0; i < 50; i++ {
		codes[e.do(req{path: "/v1/e", ip: "192.0.2.66", ua: chrome, origin: "https://example.org", body: batch(atok, &ac, goodSG, pv("/flood"))}).Code]++
	}
	if codes[202] != 10 || codes[429] != 40 {
		t.Fatalf("authenticated flood codes %v", codes)
	}
	tok2, c2 := e.browser("203.0.113.6", chrome, "https://example.org")
	if rr := e.do(req{path: "/v1/e", ip: "203.0.113.6", ua: chrome, origin: "https://example.org", body: batch(tok2, &c2, goodSG, pv("/legit2"))}); rr.Code != 202 {
		t.Fatalf("genuine visitor after an authenticated flood: %d", rr.Code)
	}
}

// A subnet-refused request leaves the site budget untouched.
func TestSubnetRefusalDoesNotSpendSiteBudget(t *testing.T) {
	e := newEnv(t, func(s *snapshot.Site) { s.RateLimitPerMin = 12 }, "")
	e.payloadMod = func(p *snapshot.Payload) { p.Settings.WebRequestsPerMinSubnet = 2 }
	s := baseSite()
	s.RateLimitPerMin = 12
	e.apply(s, "active")
	atok, ac := e.browser("192.0.2.66", chrome, "https://example.org")
	for i := 0; i < 30; i++ {
		e.do(req{path: "/v1/e", ip: "192.0.2.66", ua: chrome, origin: "https://example.org", body: batch(atok, &ac, goodSG, pv("/a"))})
	}
	ok := 0
	for i := 0; i < 5; i++ { // five other subnets, two requests each: 10 of the 12 left after the attacker's 2
		ip := fmt.Sprintf("203.0.%d.5", 100+i)
		tok, c := e.browser(ip, chrome, "https://example.org")
		for j := 0; j < 2; j++ {
			if e.do(req{path: "/v1/e", ip: ip, ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/b"))}).Code == 202 {
				ok++
			}
		}
	}
	if ok != 10 {
		t.Fatalf("site budget spent by subnet refusals: %d of 10 accepted", ok)
	}
}

// fillHistory gives the site one day of history at one verified event per 10 minutes (p99 = 1).
func fillHistory(e *env) {
	for i := 145; i >= 1; i-- {
		e.srv.history.Add(siteID, 1, e.now.Add(-time.Duration(i)*10*time.Minute))
	}
}

// Junk (no token, bot UA, wrong origin) never feeds rate_anomaly; proof-solved traffic does.
func TestRateAnomalyIgnoresRejectedJunk(t *testing.T) {
	e := newEnv(t, nil, "")
	fillHistory(e)
	for i := 0; i < 30; i++ {
		ip := fmt.Sprintf("198.51.%d.9", i)
		e.do(req{path: "/v1/e", ip: ip, ua: "curl/8.14.0", origin: "https://evil.test", body: batch("", nil, "", pv("/1"), pv("/2"), pv("/3"))})
	}
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/legit"))})
	if len(e.sp.recs) != 1 || e.sp.recs[0].Tag != "v" || e.reasons()["rate_anomaly"] != 0 {
		t.Fatalf("genuine event after junk: recs %d reasons %v", len(e.sp.recs), e.reasons())
	}
	// Positive control: a burst of proof-solved events from many visitors is an anomaly.
	for i := 0; i < 12; i++ {
		ip := fmt.Sprintf("203.0.%d.7", 50+i)
		tk, n := e.browser(ip, chrome, "https://example.org")
		e.do(req{path: "/v1/e", ip: ip, ua: chrome, origin: "https://example.org", body: batch(tk, &n, goodSG, pv("/burst"))})
	}
	if e.reasons()["rate_anomaly"] == 0 {
		t.Fatal("a real burst must still raise rate_anomaly")
	}
}

type response struct {
	code   int
	body   string
	header http.Header
}

func snap(rr *httptest.ResponseRecorder) response {
	h := rr.Header().Clone()
	return response{rr.Code, rr.Body.String(), h}
}

func sameResponse(t *testing.T, what string, rs map[string]response) {
	t.Helper()
	var ref response
	var refName string
	names := make([]string, 0, len(rs))
	for n := range rs {
		names = append(names, n)
	}
	slices.Sort(names)
	for i, n := range names {
		r := rs[n]
		if i == 0 {
			ref, refName = r, n
			continue
		}
		if r.code != ref.code || r.body != ref.body || fmt.Sprint(r.header) != fmt.Sprint(ref.header) {
			t.Errorf("%s: %q answered %d %q %v, but %q answered %d %q %v", what, n, r.code, r.body, r.header, refName, ref.code, ref.body, ref.header)
		}
	}
}

// Accepted (verified, suspect), rejected and dropped batches get the same answer;
// once the node's quota share is used up, verified, suspect and rejected batches get the same 429; unknown-site
// answers do not depend on the batch content; a spool failure is a 503 whatever the verdict.
func TestSameResponseWhateverTheVerdict(t *testing.T) {
	dir := t.TempDir()
	e := newEnv(t, func(s *snapshot.Site) { s.ExcludeCountries = []string{"RU"} }, dir)
	o := "https://example.org"
	tok, c := e.browser("203.0.113.5", chrome, o)
	dupe := pv("/dup")
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(tok, &c, goodSG, dupe)})
	rtok, rc := e.browser("198.51.100.5", chrome, o) // RU: excluded country
	accepted := map[string]response{
		"verified":  snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(tok, &c, goodSG, pv("/v"))})),
		"suspect":   snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(tok, nil, goodSG, pv("/s"))})),
		"rejected":  snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch("", nil, goodSG, pv("/r"))})),
		"forged":    snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(forgeToken(7, e.now), nil, goodSG, pv("/f"))})),
		"bot":       snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: "curl/8.14.0", origin: o, body: batch(tok, &c, goodSG, pv("/b"))})),
		"duplicate": snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(tok, &c, goodSG, dupe)})),
		"excluded":  snap(e.do(req{path: "/v1/e", ip: "198.51.100.5", ua: chrome, origin: o, body: batch(rtok, &rc, goodSG, pv("/x"))})),
	}
	sameResponse(t, "accepted vs dropped", accepted)
	if accepted["verified"].code != 202 {
		t.Fatalf("baseline %d", accepted["verified"].code)
	}

	// Over the node's quota share: one verified event per day.
	q := newEnv(t, func(s *snapshot.Site) { s.DailyQuota = 1 }, "")
	qt, qc := q.browser("203.0.113.5", chrome, o)
	if rr := q.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(qt, &qc, goodSG, pv("/first"))}); rr.Code != 202 {
		t.Fatalf("first: %d", rr.Code)
	}
	over := map[string]response{
		"verified": snap(q.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(qt, &qc, goodSG, pv("/v"))})),
		"suspect":  snap(q.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(qt, nil, goodSG, pv("/s"))})),
		"rejected": snap(q.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch("", nil, goodSG, pv("/r"))})),
		"bot":      snap(q.do(req{path: "/v1/e", ip: "203.0.113.5", ua: "curl/8.14.0", origin: o, body: batch(qt, &qc, goodSG, pv("/b"))})),
	}
	sameResponse(t, "over quota", over)
	if over["verified"].code != 429 || over["verified"].body != `{"error":"quota_exceeded"}` {
		t.Fatalf("over quota: %+v", over["verified"])
	}

	// Unknown site: the same 404 (with CORS) whatever else the batch carries.
	other := func(body string) string { return strings.Replace(body, siteKey, "AAAAAAAAAAAAAAAAAAAAAA", 1) }
	unknown := map[string]response{
		"with token": snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: other(batch(tok, &c, goodSG, pv("/u")))})),
		"no token":   snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: other(batch("", nil, goodSG, pv("/u")))})),
		"bot":        snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: "curl/8.14.0", origin: o, body: other(batch("", nil, "", pv("/u")))})),
	}
	sameResponse(t, "unknown site", unknown)
	if u := unknown["no token"]; u.code != 404 || u.header.Get("Access-Control-Allow-Origin") != o {
		t.Fatalf("unknown site: %+v", u)
	}

	// Spool failure: 503 for every verdict.
	e.sp.fail = spool.ErrUnavailable
	failing := map[string]response{
		"verified": snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch(tok, &c, goodSG, pv("/v2"))})),
		"rejected": snap(e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch("", nil, goodSG, pv("/r2"))})),
		"excluded": snap(e.do(req{path: "/v1/e", ip: "198.51.100.5", ua: chrome, origin: o, body: batch(rtok, &rc, goodSG, pv("/x2"))})),
	}
	sameResponse(t, "spool failure", failing)
	if failing["rejected"].code != 503 {
		t.Fatalf("spool failure on a rejected batch: %d", failing["rejected"].code)
	}
}

// An all-rejected batch still passes through the spool's commit barrier.
func TestRejectedBatchWaitsForTheCommitBarrier(t *testing.T) {
	e := newEnv(t, nil, "")
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch("", nil, goodSG, pv("/r"))})
	if e.sp.barriers != 1 {
		t.Fatalf("barriers %d", e.sp.barriers)
	}
}

// IP addresses, phone numbers and federation addresses never reach the spool through custom properties.
func TestPropertyGuardRefusesPersonalIdentifiers(t *testing.T) {
	e := newEnv(t, nil, "")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG,
		`{"id":"`+eid()+`","k":"ev","u":"/","n":"signup","d":{"ip":"203.0.113.5","v6":"2001:db8:1:2::77","ph":"+4915112345678","fed":"alice*example.com","note":"from 198.51.100.7 today","plan":"pro"}}`)})
	if rr.Code != 202 || len(e.sp.recs) != 1 {
		t.Fatalf("%d records %d", rr.Code, len(e.sp.recs))
	}
	d := e.sp.recs[0].Data
	if len(d) != 1 || d["plan"] != "pro" {
		t.Fatalf("custom data %v", d)
	}
	if got := e.agg.Get(tenant, siteID, e.now, "drop", "prop_redacted"); got != 5 {
		t.Fatalf("prop_redacted %d", got)
	}
}

// Outside debug mode a dev entry carries no bot-detection verdict (a client claiming a dev origin learns
// nothing about header, transport, UA or network checks); in debug mode (audited, time-boxed) it does.
func TestDevPanelIsNoDetectionOracle(t *testing.T) {
	e := devEnv(t, nil)
	tok, c := e.browser("203.0.113.5", chrome, devOrigin)
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: "curl/8.14.0", origin: devOrigin, headers: map[string]string{"Accept-Language": "", "Sec-Fetch-Mode": "navigate"},
		body: batch(tok, &c, goodSG, pv("/bot"))})
	d := e.agg.Dev(siteID)
	if len(d) != 1 || d[0].WouldBe != "verified" || d[0].Reason != nil {
		t.Fatalf("dev entry outside debug mode reveals detection: %+v", d)
	}
	// Protocol and configuration reasons stay visible (proof missing).
	tok2, _ := e.browser("203.0.113.5", chrome, devOrigin)
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: "curl/8.14.0", origin: devOrigin, body: batch(tok2, nil, goodSG, pv("/np"))})
	if d := e.agg.Dev(siteID); len(d) != 2 || d[1].Reason == nil || *d[1].Reason != "proof_missing" {
		t.Fatalf("protocol reason hidden: %+v", d)
	}
	// Debug mode on: the full would-be verdict.
	dbg := devEnv(t, debugUntil(time.Hour))
	tok3, c3 := dbg.browser("203.0.113.5", chrome, devOrigin)
	dbg.do(req{path: "/v1/e", ip: "203.0.113.5", ua: "curl/8.14.0", origin: devOrigin, body: batch(tok3, &c3, goodSG, pv("/bot"))})
	if d := dbg.agg.Dev(siteID); len(d) != 1 || d[0].WouldBe != "rejected" || d[0].Reason == nil || *d[0].Reason != "ua_bot" {
		t.Fatalf("debug mode dev entry: %+v", d)
	}
}

// A repeated event id inside one batch is spooled once.
func TestDuplicateIDsInsideOneBatch(t *testing.T) {
	e := newEnv(t, nil, "")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	ev := pv("/same")
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, ev, ev, ev, ev)})
	if len(e.sp.recs) != 1 || e.agg.Get(tenant, siteID, e.now, "drop", "duplicate_event_id") != 3 {
		t.Fatalf("records %d dups %d", len(e.sp.recs), e.agg.Get(tenant, siteID, e.now, "drop", "duplicate_event_id"))
	}
}

// 404 and early 503 answers of both routes carry CORS, so the tracker can read them.
func TestEarlyAnswersCarryCORS(t *testing.T) {
	e := newEnv(t, nil, "")
	o := "https://anything.example"
	for _, path := range []string{"/v1/c", "/v1/e"} {
		body := `{"v":1,"s":"AAAAAAAAAAAAAAAAAAAAAA","p":"standard","tv":"1.0.0"}`
		if path == "/v1/e" {
			body = strings.Replace(batch("", nil, "", pv("/")), siteKey, "AAAAAAAAAAAAAAAAAAAAAA", 1)
		}
		rr := e.do(req{path: path, ip: "203.0.113.5", ua: chrome, origin: o, body: body})
		if rr.Code != 404 || rr.Header().Get("Access-Control-Allow-Origin") != o || rr.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Errorf("%s 404: %d %v", path, rr.Code, rr.Header())
		}
	}
	e.srv.Draining = func() bool { return true }
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: o, body: batch("", nil, "", pv("/"))})
	if rr.Code != 503 || rr.Header().Get("Access-Control-Allow-Origin") != o || rr.Header().Get("Access-Control-Expose-Headers") != "Retry-After" {
		t.Errorf("early 503: %d %v", rr.Code, rr.Header())
	}
}

// /v1/c applies this node's share of the site limit too.
func TestChallengeSiteShare(t *testing.T) {
	e := newEnv(t, func(s *snapshot.Site) { s.RateLimitPerMin = 40 }, "")
	ok := 0
	for i := 0; i < 60; i++ { // 60 different subnets: only the site share (40) limits
		ip := fmt.Sprintf("203.0.%d.5", i)
		if e.do(req{path: "/v1/c", ip: ip, ua: chrome, origin: "https://example.org", body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`}).Code == 200 {
			ok++
		}
	}
	if ok != 40 {
		t.Fatalf("challenges issued %d, want the site share 40", ok)
	}
}

// Every copy of one event carries the same event key and — when unidentified — the same surrogate,
// whichever node receives it; distinct events differ.
func TestEventKeyAndUnidentifiedSurrogateAreStablePerEvent(t *testing.T) {
	mk := func() *env {
		return newEnv(t, func(s *snapshot.Site) { s.VisitorID = "off" }, "")
	}
	a, b := mk(), mk() // two nodes (independent rings, same site)
	ev := pv("/twice")
	for _, n := range []*env{a, b} {
		tok, c := n.browser("203.0.113.5", chrome, "https://example.org")
		n.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, ev, pv("/other"))})
	}
	if len(a.sp.recs) != 2 || len(b.sp.recs) != 2 {
		t.Fatal("records")
	}
	ra, rb := a.sp.recs[0], b.sp.recs[0]
	if ra.EventKey == "" || ra.EventKey != rb.EventKey || ra.Surrogate != rb.Surrogate || ra.Target != "twin" {
		t.Fatalf("copies differ: %+v / %+v", ra, rb)
	}
	if a.sp.recs[1].EventKey == ra.EventKey || a.sp.recs[1].Surrogate == ra.Surrogate {
		t.Fatal("distinct events must differ")
	}
	if len(ra.EventKey) != 32 || strings.Contains(fmt.Sprint(ra), ev[7:29]) {
		t.Fatalf("event key %q must be a 32-hex digest, never the id", ra.EventKey)
	}
}
