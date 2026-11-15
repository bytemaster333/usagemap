// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/netclass"
)

// The range-list fetcher shipped in the gateway image (bot.ip-multiplicity): fetch over HTTPS, log each
// source's SHA-256, write per-class files the gateway's classifier reads, keep the previous list when a fetch fails,
// refuse bad configuration, and repeat on an interval.

const awsJSON = `{"prefixes":[{"ip_prefix":"192.0.2.0/24"}],"ipv6_prefixes":[{"ipv6_prefix":"2001:db8:aa::/48"}]}`
const torList = "198.51.100.7\n198.51.100.8\n"

type publisher struct {
	srv  *httptest.Server
	fail atomic.Bool
	hits atomic.Int32
}

func newPublisher(t *testing.T) *publisher {
	p := &publisher{}
	p.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.hits.Add(1)
		if r.Header.Get("User-Agent") != "scf-rangelist-updater/1" {
			w.WriteHeader(400)
			return
		}
		if p.fail.Load() {
			w.WriteHeader(503)
			return
		}
		switch r.URL.Path {
		case "/aws.json":
			_, _ = w.Write([]byte(awsJSON))
		case "/tor":
			_, _ = w.Write([]byte(torList))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *publisher) config(t *testing.T) string {
	srcs := []map[string]string{
		{"name": "aws", "class": "datacenter", "url": p.srv.URL + "/aws.json", "format": "aws-json"},
		{"name": "tor-exits", "class": "tor", "url": p.srv.URL + "/tor", "format": "lines"},
	}
	b, _ := json.Marshal(srcs)
	f := filepath.Join(t.TempDir(), "sources.json")
	_ = os.WriteFile(f, b, 0o600)
	return f
}

func TestFetchOnceWritesClassFilesTheGatewayReads(t *testing.T) {
	p := newPublisher(t)
	dir := t.TempDir()
	var out, errb bytes.Buffer
	if code := run(context.Background(), []string{"-dir", dir, "-config", p.config(t)}, &out, &errb, p.srv.Client()); code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	c := netclass.New(dir)
	for ip, want := range map[string]string{"192.0.2.9": "datacenter", "2001:db8:aa::1": "datacenter", "198.51.100.7": "tor", "203.0.113.1": "unknown"} {
		if got := c.Class(netip.MustParseAddr(ip)); got != want {
			t.Errorf("class(%s) = %s, want %s", ip, got, want)
		}
	}
	sum := sha256.Sum256([]byte(awsJSON))
	if !strings.Contains(out.String(), hex.EncodeToString(sum[:])) || !strings.Contains(out.String(), `"msg":"range list fetched"`) {
		t.Fatalf("checksum log missing: %s", out.String())
	}
	var st []map[string]any
	b, _ := os.ReadFile(filepath.Join(dir, "sources.json"))
	if json.Unmarshal(b, &st) != nil || len(st) != 2 {
		t.Fatalf("status file: %s", b)
	}
}

func TestFailureKeepsThePreviousListAndExitCodes(t *testing.T) {
	p := newPublisher(t)
	dir := t.TempDir()
	cfg := p.config(t)
	var out, errb bytes.Buffer
	if code := run(context.Background(), []string{"-dir", dir, "-config", cfg}, &out, &errb, p.srv.Client()); code != 0 {
		t.Fatal(code)
	}
	before, _ := os.ReadFile(filepath.Join(dir, "datacenter.txt"))
	p.fail.Store(true)
	out.Reset()
	if code := run(context.Background(), []string{"-dir", dir, "-config", cfg}, &out, &errb, p.srv.Client()); code != 1 {
		t.Fatalf("every source failing must exit 1, got %d", code)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "datacenter.txt"))
	if !bytes.Equal(before, after) || len(after) == 0 {
		t.Fatal("previous list not kept")
	}
	if !strings.Contains(out.String(), "keeping the previous list") {
		t.Fatalf("failure not logged: %s", out.String())
	}
	if netclass.New(dir).Class(netip.MustParseAddr("192.0.2.9")) != "datacenter" {
		t.Fatal("classifier lost the list after a failed fetch")
	}
}

func TestBadConfigurationRefused(t *testing.T) {
	dir := t.TempDir()
	write := func(v string) string {
		f := filepath.Join(t.TempDir(), "c.json")
		_ = os.WriteFile(f, []byte(v), 0o600)
		return f
	}
	cases := map[string][]string{
		"plain http":     {"-config", write(`[{"name":"x","class":"datacenter","url":"http://example.org/x","format":"lines"}]`)},
		"unknown class":  {"-config", write(`[{"name":"x","class":"evil","url":"https://example.org/x","format":"lines"}]`)},
		"bad format":     {"-config", write(`[{"name":"x","class":"tor","url":"https://example.org/x","format":"xml"}]`)},
		"not json":       {"-config", write(`{`)},
		"short interval": {"-interval", "5m"},
		"unknown flag":   {"-bogus"},
	}
	for name, args := range cases {
		var out, errb bytes.Buffer
		if code := run(context.Background(), append([]string{"-dir", dir}, args...), &out, &errb, http.DefaultClient); code != 2 {
			t.Errorf("%s: exit %d", name, code)
		}
	}
}

// Interval mode keeps running until cancelled (the scheduled form: one long-running process per edge node).
func TestIntervalModeRunsUntilCancelled(t *testing.T) {
	p := newPublisher(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int)
	var out, errb bytes.Buffer
	go func() {
		done <- run(ctx, []string{"-dir", t.TempDir(), "-config", p.config(t), "-interval", "168h"}, &out, &errb, p.srv.Client())
	}()
	deadline := time.Now().Add(5 * time.Second)
	for p.hits.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case code := <-done:
		if code != 0 || p.hits.Load() != 2 {
			t.Fatalf("exit %d, fetches %d", code, p.hits.Load())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("did not stop on cancellation")
	}
}
