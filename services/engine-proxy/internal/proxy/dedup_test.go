// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"net/http"
	"strings"
	"testing"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/dedup"
)

// Idempotent web delivery: a second copy of an event key is answered with the first copy's outcome and
// never reaches Umami; the key header is never forwarded; a malformed key is refused; without a key nothing changes.
func TestSendDeduplicatesByEventKey(t *testing.T) {
	h := newHarness(t, true)
	h.srv.c.Dedup = dedup.New(dedup.Config{})
	key := strings.Repeat("ab", 16)
	hd := sendHeaders("track")
	hd[HeaderEventKey] = key
	first := h.do(&edgeID, "POST", "/api/send", event(site, at(10, 0), ""), hd)
	if first.Code != 200 || len(h.umami.requests()) != 1 {
		t.Fatalf("first copy: %d, upstream %d", first.Code, len(h.umami.requests()))
	}
	if h.umami.last(t).Header.Get(HeaderEventKey) != "" {
		t.Fatal("the event key reached Umami")
	}
	// The retry (from the other edge node, a later receipt time) is answered without forwarding.
	again := h.do(&edgeID, "POST", "/api/send", event(site, at(10, 1), ""), hd)
	if again.Code != 200 || again.Body.String() != "{}" || len(h.umami.requests()) != 1 {
		t.Fatalf("second copy: %d %q, upstream %d", again.Code, again.Body, len(h.umami.requests()))
	}
	if h.metrics.Get("scf_engine_proxy_send_duplicates_total") != 1 {
		t.Fatal("duplicate not counted")
	}
	// Another key is forwarded; no key at all is forwarded every time.
	hd[HeaderEventKey] = strings.Repeat("cd", 16)
	h.do(&edgeID, "POST", "/api/send", event(site, at(10, 2), ""), hd)
	delete(hd, HeaderEventKey)
	h.do(&edgeID, "POST", "/api/send", event(site, at(10, 3), ""), hd)
	h.do(&edgeID, "POST", "/api/send", event(site, at(10, 3), ""), hd)
	if n := len(h.umami.requests()); n != 4 {
		t.Fatalf("upstream requests %d", n)
	}
	for _, bad := range []string{"xyz", strings.Repeat("AB", 16), strings.Repeat("a", 31), strings.Repeat("g", 32)} {
		hd[HeaderEventKey] = bad
		if w := h.do(&edgeID, "POST", "/api/send", event(site, at(10, 4), ""), hd); w.Code != http.StatusBadRequest {
			t.Errorf("key %q: %d", bad, w.Code)
		}
	}
}

// A copy whose first attempt failed upstream is forwarded again (the key is released), and Umami's bot answer is
// replayed to later copies.
func TestSendDedupAfterFailureAndBotAnswer(t *testing.T) {
	h := newHarness(t, true)
	h.srv.c.Dedup = dedup.New(dedup.Config{})
	hd := sendHeaders("none")
	hd[HeaderEventKey] = strings.Repeat("0f", 16)
	h.umamiTS.Close() // Umami down: 502
	h2 := newHarness(t, true)
	h2.srv.c.Dedup = h.srv.c.Dedup
	if w := h.do(&edgeID, "POST", "/api/send", event(site, at(10, 0), ""), hd); w.Code != http.StatusBadGateway {
		t.Fatalf("Umami down: %d", w.Code)
	}
	h2.umami.sendBody = `{"beep":"boop"}`
	if w := h2.do(&edgeID, "POST", "/api/send", event(site, at(10, 0), ""), hd); w.Code != 200 || len(h2.umami.requests()) != 1 {
		t.Fatalf("retry after a failure must be forwarded: %d", w.Code)
	}
	if w := h2.do(&edgeID, "POST", "/api/send", event(site, at(10, 0), ""), hd); w.Body.String() != `{"beep":"boop"}` || len(h2.umami.requests()) != 1 {
		t.Fatalf("bot answer replay: %q", w.Body)
	}
}
