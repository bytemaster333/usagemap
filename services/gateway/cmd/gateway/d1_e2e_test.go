// SPDX-License-Identifier: Apache-2.0

package main

// Process-level tests of the rules (C-136, C-137) against the gateway binary and a fake core: dev requests are
// never counted anywhere, counted-only Stellar events
// never reach the spool or Umami, a dev-issued token is refused on a production batch, the optional counter-record
// parts survive an older control plane (§d.3 upgrade rule), and the spool and logs hold no address, User-Agent, token
// or origin host.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
	"github.com/bytemaster333/usagemap/services/gateway/pkg/probe"
)

const (
	d1UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Safari/537.36 " + marker
	devOrigin = "http://localhost:3000"
)

type client struct {
	h      *harness
	origin string
	tokens []string // every token handed out, for the privacy scan
	ids    []string // every event id sent
	n      int
}

func (c *client) post(path, body string) *http.Response {
	c.h.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+c.h.pub+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	req.Header.Set("Origin", c.origin)
	req.Header.Set("User-Agent", d1UA)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	req.Header.Set("Sec-Fetch-Dest", "empty")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.h.t.Fatal(err)
	}
	return resp
}

// challenge fetches and solves a challenge like the tracker.
func (c *client) challenge() (string, uint32) {
	c.h.t.Helper()
	resp := c.post("/v1/c", `{"v":1,"s":"`+eSiteKey+`","p":"standard","tv":"1.0.0"}`)
	defer resp.Body.Close()
	var ch struct {
		T   string `json:"t"`
		Pow struct {
			Cost, Max int
			Pfx       string
		} `json:"pow"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&ch) != nil {
		c.h.t.Fatalf("challenge: %d", resp.StatusCode)
	}
	n, ok := probe.Solve(ch.T, ch.Pow.Cost, ch.Pow.Max, ch.Pow.Pfx)
	if !ok {
		c.h.t.Fatal("unsolvable")
	}
	c.tokens = append(c.tokens, ch.T)
	return ch.T, n
}

func (c *client) id() string {
	c.n++
	id := fmt.Sprintf("%s%04d", strings.Repeat("Z", 18), c.n)
	if strings.HasPrefix(c.origin, "http://") {
		id = fmt.Sprintf("%s%04d", strings.Repeat("D", 18), c.n)
	}
	c.ids = append(c.ids, id)
	return id
}

// send posts one batch with the given token and events (each a JSON object without "id").
func (c *client) send(token string, counter uint32, events ...string) *http.Response {
	c.h.t.Helper()
	var es []string
	for _, e := range events {
		es = append(es, `{"id":"`+c.id()+`",`+strings.TrimPrefix(e, "{"))
	}
	body := fmt.Sprintf(`{"v":1,"s":"%s","p":"standard","tv":"1.0.0","t":"%s","c":%d,"sg":{"wd":0,"vis":"v","act":1},"e":[%s]}`,
		eSiteKey, token, counter, strings.Join(es, ","))
	resp := c.post("/v1/e", body)
	resp.Body.Close()
	return resp
}

func d1Snapshot(features []string, quota int) func(*snapshot.Payload) {
	return func(p *snapshot.Payload) {
		p.Settings.CounterFeatures = features
		p.Sites[0].DevOrigins = []string{"localhost"}
		p.Sites[0].DailyQuota = quota
	}
}

func (h *harness) counterRecords() []spool.CounterRecord {
	h.core.mu.Lock()
	defer h.core.mu.Unlock()
	return append([]spool.CounterRecord(nil), h.core.counters...)
}

func (h *harness) sendsSnapshot() []sendReq {
	h.core.mu.Lock()
	defer h.core.mu.Unlock()
	return append([]sendReq(nil), h.core.sends...)
}

// (a) + (b) + (d) + (g), end to end.
func TestDevNeverCountedAndCountedOnlyNeverForwarded(t *testing.T) {
	h := newHarness(t, d1Snapshot([]string{"props", "dev"}, 2))
	h.start()
	dev := &client{h: h, origin: devOrigin}
	prod := &client{h: h, origin: "https://example.org"}

	// Dev traffic with valid proofs: page views, a forwarded-kind wallet event, counted-only events, a custom event.
	var devTok string
	var devC uint32
	for i := 0; i < 3; i++ {
		devTok, devC = dev.challenge()
		r := dev.send(devTok, devC, fmt.Sprintf(`{"k":"pv","u":"/dev/%d"}`, i),
			`{"k":"wl","sv":1,"u":"/dev","n":"wallet_connect","wt":"freighter","net":"futurenet","ck":"new"}`,
			`{"k":"wl","sv":1,"u":"/dev","n":"tx_submitted","net":"futurenet","rc":"success"}`,
			`{"k":"ev","u":"/dev","n":"dev_signup"}`)
		if r.StatusCode != 202 || r.Header.Get("X-Scf-Debug") != "v=1; class=dev; reasons=dev_origin" {
			t.Fatalf("dev batch: %d %q", r.StatusCode, r.Header.Get("X-Scf-Debug"))
		}
	}
	// (b) the dev token spent on a production batch: accepted (202, no oracle) and rejected.
	if r := prod.send(devTok, devC, `{"k":"pv","u":"/stolen-dev-token"}`); r.StatusCode != 202 || r.Header.Get("X-Scf-Debug") != "" {
		t.Fatalf("dev token on production: %d %q", r.StatusCode, r.Header.Get("X-Scf-Debug"))
	}
	// Production: a page view and a forwarded wallet event (2 verified = the whole quota), plus counted-only events.
	tok, c := prod.challenge()
	r := prod.send(tok, c, `{"k":"pv","u":"/prod"}`,
		`{"k":"wl","u":"/prod","n":"wallet_connected","wid":"varial","net":"public"}`,
		`{"k":"wl","u":"/prod","n":"sign_completed","wid":"varial","sk":"tx_submit","dur":"lt5s"}`,
		`{"k":"wl","sv":1,"u":"/prod","n":"tx_submitted","wt":"freighter","net":"mainnet","rc":"success"}`,
		`{"k":"wl","sv":1,"u":"/prod","n":"passkey_used","po":"sign","net":"mainnet"}`)
	if r.StatusCode != 202 {
		t.Fatalf("production batch: %d (dev or counted-only events consumed the quota?)", r.StatusCode)
	}
	tok, c = prod.challenge()
	if r := prod.send(tok, c, `{"k":"pv","u":"/over"}`); r.StatusCode != 429 {
		t.Fatalf("quota of 2 must refuse the third verified event: %d", r.StatusCode)
	}

	// Umami receives exactly the two forwarded production events.
	h.waitFor("forwarded events", 10*time.Second, func() bool { return len(h.sendsSnapshot()) >= 2 })
	time.Sleep(1500 * time.Millisecond) // let anything else surface
	sends := h.sendsSnapshot()
	if len(sends) != 2 {
		t.Fatalf("Umami received %d events, want 2", len(sends))
	}
	names := map[string]map[string]any{}
	for _, s := range sends {
		pl := s.body["payload"].(map[string]any)
		n, _ := pl["name"].(string)
		d, _ := pl["data"].(map[string]any)
		names[fmt.Sprint(pl["url"])+"#"+n] = d
	}
	d, ok := names["/prod#wallet_connect"]
	if _, pvOK := names["/prod#"]; !ok || !pvOK || d["wallet"] != "freighter" || d["network"] != "mainnet" || d["connect_kind"] != "new" {
		t.Fatalf("forwarded events %v", names)
	}

	// Counter records: production counts only; props only from production; dev entries only from dev.
	h.waitFor("counter records with dev entries and props", 10*time.Second, func() bool {
		var dv, pr int
		for _, rec := range h.counterRecords() {
			dv += len(rec.Dev)
			pr += len(rec.Props)
		}
		return dv == 12 && pr > 0
	})
	time.Sleep(1500 * time.Millisecond)
	web := map[string]int64{}
	props := map[string]int64{}
	var fsynced int64
	for _, rec := range h.counterRecords() {
		fsynced += rec.Spool.Fsynced
		for _, w := range rec.Web {
			web[w.Counter+"/"+w.Label] += w.Count
		}
		for _, p := range rec.Props {
			if p.Network == "futurenet" {
				t.Fatalf("a dev event reached the property rollup: %+v", p)
			}
			props[p.Event+"/"+p.Network+"/"+p.Key+"/"+p.Value] += p.Count
		}
		for _, d := range rec.Dev {
			if !strings.HasPrefix(d.Path, "/dev") || d.WouldBe != "verified" {
				t.Fatalf("dev entry %+v", d)
			}
		}
	}
	if fsynced != 2 {
		t.Fatalf("spooled event records %d, want 2 (dev and counted-only events are never spooled)", fsynced)
	}
	// verified = page view + wallet_connect; rejected = the dev token; the quota 429 is a drop.
	if web["verdict/verified"] != 2 || web["verdict/rejected"] != 1 || web["verdict/suspect"] != 0 || web["reason/challenge_invalid"] != 1 ||
		web["tracker_version/v1_0_0"] != 2 || web["drop/quota_exceeded"] != 1 || web["identifier/identified"] != 2 {
		t.Fatalf("web counters %v", web)
	}
	for _, want := range []string{"wallet_connect/mainnet/_total/all", "wallet_connect/mainnet/wallet/freighter", "sign_approved/unknown/sign_kind/tx_submit",
		"tx_submitted/mainnet/result_class/success", "passkey_used/mainnet/passkey_op/sign"} {
		if props[want] != 1 {
			t.Errorf("prop %s = %d (%v)", want, props[want], props)
		}
	}
	h.stop()
	privacyScan(t, h)
	d1PrivacyScan(t, h, append(dev.tokens, prod.tokens...), append(dev.ids, prod.ids...))
}

// d1PrivacyScan extends privacyScan: no token, no event id and no origin host in the spool or the logs (g).
func d1PrivacyScan(t *testing.T, h *harness, tokens, ids []string) {
	t.Helper()
	var spoolBytes strings.Builder
	_ = filepath.Walk(filepath.Join(h.dir, "state"), func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && (strings.HasSuffix(p, ".seg") || strings.HasSuffix(p, ".ack")) {
			b, _ := os.ReadFile(p)
			spoolBytes.Write(b)
		}
		return nil
	})
	h.logMu.Lock()
	logs := h.allLogs.String()
	h.logMu.Unlock()
	if !strings.Contains(spoolBytes.String(), `"type":"counter"`) {
		t.Fatal("scan saw no spool content")
	}
	needles := append(append([]string{"localhost", "127.0.0.1", marker, "Chrome/131.0.6778", "Sec-Fetch"}, tokens...), ids...)
	for name, hay := range map[string]string{"spool": spoolBytes.String(), "logs": logs} {
		for _, n := range needles {
			if n != "" && strings.Contains(hay, n) {
				t.Errorf("%s contains %q", name, n)
			}
		}
	}
}

// (e) the upgrade test: the snapshot (wrongly) advertises the parts to a control plane that rejects them (422) —
// every record is still delivered, without them; and with the setting [] nothing is ever refused.
func TestUpgradeAgainstOldControlPlane(t *testing.T) {
	for _, features := range [][]string{{"props", "dev"}, nil} {
		t.Run(fmt.Sprint(features), func(t *testing.T) {
			h := newHarness(t, d1Snapshot(features, 1000))
			h.core.strict = true
			h.start()
			prod := &client{h: h, origin: "https://example.org"}
			dev := &client{h: h, origin: devOrigin}
			tok, c := prod.challenge()
			prod.send(tok, c, `{"k":"pv","u":"/up"}`, `{"k":"wl","sv":1,"u":"/up","n":"wallet_selected","wt":"xbull"}`,
				`{"k":"wl","sv":1,"u":"/up","n":"sign_requested","wt":"xbull","net":"mainnet","sk":"tx"}`)
			dtok, dc := dev.challenge()
			dev.send(dtok, dc, `{"k":"pv","u":"/dev"}`)
			h.waitFor("verified counters at the old control plane", 10*time.Second, func() bool {
				var v, f int64
				for _, rec := range h.counterRecords() {
					f += rec.Spool.Fsynced
					for _, w := range rec.Web {
						if w.Counter == "verdict" && w.Label == "verified" {
							v += w.Count
						}
					}
				}
				return v == 2 && f == 2
			})
			for _, rec := range h.counterRecords() {
				if rec.Props != nil || rec.Dev != nil {
					t.Fatal("the old control plane accepted a record with the optional parts")
				}
			}
			h.core.mu.Lock()
			refused := h.core.refused
			h.core.mu.Unlock()
			if features == nil && refused != 0 {
				t.Fatalf("with counter_features [] no record may carry the parts (%d refused)", refused)
			}
			if features != nil && refused == 0 {
				t.Fatal("the wrongly advertised parts should have been refused once")
			}
			if n := h.metricMatching("scf_gateway_forward_total{", `kind="counter"`, `outcome="rejected"`); n > 0 {
				t.Fatalf("%v counter records discarded", n)
			}
			h.stop()
		})
	}
}

// metricMatching sums the series of a metric whose labels contain every given label pair (0 when absent).
func (h *harness) metricMatching(prefix string, labels ...string) float64 {
	r, err := http.Get("http://127.0.0.1:" + h.metrics + "/metrics")
	if err != nil {
		return -1
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	var sum float64
next:
	for _, l := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(l, prefix) {
			continue
		}
		for _, lb := range labels {
			if !strings.Contains(l, lb) {
				continue next
			}
		}
		var v float64
		_, _ = fmt.Sscan(l[strings.LastIndex(l, " ")+1:], &v)
		sum += v
	}
	return sum
}
