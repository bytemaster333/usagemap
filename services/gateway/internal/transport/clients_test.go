// SPDX-License-Identifier: Apache-2.0

package transport

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/testpki"
)

// observation is what the test server saw for one client (test and evidence output only).
type observation struct {
	Client   string `json:"client"`
	JA4      string `json:"ja4"`
	ALPN     string `json:"alpn"`
	H2       string `json:"h2,omitempty"`
	Observed string `json:"observed_family"`
	// AsChrome is Check() when the client claims Chrome 131 on Windows; AsOwn when it claims its real identity.
	AsChrome string `json:"verdict_claiming_chrome"`
	AsOwn    string `json:"verdict_claiming_own_ua,omitempty"`
	Why      string `json:"why_claiming_chrome,omitempty"`
	UA       string `json:"ua_family_os,omitempty"`
}

type testServer struct {
	url string
	mu  sync.Mutex
	got map[string]Snapshot
	ua  map[string]string
}

// newTestServer serves HTTPS on localhost through the fingerprinting Listener, exactly as the gateway does.
func newTestServer(t *testing.T) *testServer {
	t.Helper()
	ca := testpki.NewCA()
	cert := ca.Issue("", "localhost", "localhost", "127.0.0.1")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ts := &testServer{got: map[string]Snapshot{}, ua: map[string]string{}}
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			name := strings.TrimPrefix(r.URL.Path, "/c/")
			ts.mu.Lock()
			if _, seen := ts.got[name]; !seen {
				ts.got[name] = FromContext(r.Context()).Snapshot()
				ts.ua[name] = r.UserAgent()
			}
			ts.mu.Unlock()
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<!doctype html><title>t</title>ok"))
		}),
		ConnContext:       ConnContext,
		ReadHeaderTimeout: 5 * time.Second,
	}
	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	srv.Protocols = p
	go func() {
		_ = srv.Serve(NewListener(ln, &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert.TLS}}))
	}()
	t.Cleanup(func() { _ = srv.Close() })
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	ts.url = "https://localhost:" + port
	return ts
}

func (ts *testServer) snapshot(name string) (Snapshot, string, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	s, ok := ts.got[name]
	return s, ts.ua[name], ok
}

const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

func goClient(h2 bool) func(url string) error {
	return func(url string) error {
		tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ForceAttemptHTTP2: h2} //nolint:gosec // test server
		if !h2 {
			tr.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
		}
		req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader("{}"))
		req.Header.Set("User-Agent", chromeUA)
		resp, err := (&http.Client{Transport: tr, Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			return err
		}
		return resp.Body.Close()
	}
}

func execClient(name string, args ...string) func(url string) error {
	return func(url string) error {
		if _, err := exec.LookPath(name); err != nil {
			return errSkip{name + " not installed"}
		}
		a := make([]string, len(args))
		for i, x := range args {
			a[i] = strings.ReplaceAll(strings.ReplaceAll(x, "{URL}", url), "{UA}", chromeUA)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, name, a...)
		cmd.Env = append(os.Environ(), "NODE_TLS_REJECT_UNAUTHORIZED=0", "NODE_NO_WARNINGS=1")
		out, err := cmd.CombinedOutput()
		if err != nil {
			if strings.Contains(string(out), "SKIP:") {
				return errSkip{strings.TrimSpace(string(out))}
			}
			return fmt.Errorf("%s: %v: %s", name, err, out)
		}
		return nil
	}
}

type errSkip struct{ why string }

func (e errSkip) Error() string { return e.why }

const pyClient = `import ssl,sys,urllib.request
ctx=ssl.create_default_context();ctx.check_hostname=False;ctx.verify_mode=ssl.CERT_NONE
r=urllib.request.Request(sys.argv[1],data=b"{}",headers={"User-Agent":sys.argv[2]})
urllib.request.urlopen(r,context=ctx).read()`

const nodeFetch = `await fetch(process.argv[1],{method:"POST",body:"{}",headers:{"user-agent":process.argv[2]}}).then(r=>r.text())`

const nodeH2 = `const h2=await import("node:http2");const c=h2.connect(process.argv[1],{rejectUnauthorized:false});
const r=c.request({":method":"POST",":path":new URL(process.argv[1]).pathname,"user-agent":process.argv[2]});r.end("{}");
r.on("data",()=>{});r.on("end",()=>c.close());r.on("error",e=>{console.error(e);process.exit(1)})`

// playwrightModule locates @playwright/test from the tests workspace; SCF_PLAYWRIGHT_MODULE overrides.
func playwrightModule() string {
	if m := os.Getenv("SCF_PLAYWRIGHT_MODULE"); m != "" {
		return m
	}
	p, _ := filepath.Abs("../../../../tests/node_modules/@playwright/test/index.mjs")
	return p
}

// The browser loads the page (navigation) and then sends a tracker-like fetch on a fresh connection path.
const pwScript = `const [mod, browser, url] = process.argv.slice(1);
let pw; try { pw = await import(mod); } catch (e) { console.log("SKIP: playwright not importable"); process.exit(3); }
let b; try { b = await pw[browser].launch(); } catch (e) { console.log("SKIP: " + browser + " not installed: " + String(e).split("\n")[0]); process.exit(3); }
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto(url);
await b.close();`

func TestRealClients(t *testing.T) {
	ts := newTestServer(t)
	pw := playwrightModule()
	clients := []struct {
		name   string
		run    func(url string) error
		expect string // observed family the rules must give ("" = record only)
	}{
		{"go-net-http-h2", goClient(true), Library},
		{"go-net-http-h1", goClient(false), Library},
		{"curl-h2", execClient("curl", "-sk", "--http2", "-o", "/dev/null", "-A", "{UA}", "-d", "{}", "{URL}"), Library},
		{"curl-h1", execClient("curl", "-sk", "--http1.1", "-o", "/dev/null", "-A", "{UA}", "-d", "{}", "{URL}"), Library},
		{"python-urllib", execClient("python3", "-I", "-c", pyClient, "{URL}", "{UA}"), Library},
		{"node-fetch-undici", execClient("node", "--input-type=module", "-e", nodeFetch, "{URL}", "{UA}"), Library},
		{"node-http2", execClient("node", "--input-type=module", "-e", nodeH2, "{URL}", "{UA}"), Library},
		{"playwright-chromium", execClient("node", "--input-type=module", "-e", pwScript, pw, "chromium", "{URL}"), Chromium},
		{"playwright-firefox", execClient("node", "--input-type=module", "-e", pwScript, pw, "firefox", "{URL}"), Gecko},
		{"playwright-webkit-linux", execClient("node", "--input-type=module", "-e", pwScript, pw, "webkit", "{URL}"), ""},
	}
	var obs []observation
	for _, c := range clients {
		t.Run(c.name, func(t *testing.T) {
			err := c.run(ts.url + "/c/" + c.name)
			if e, ok := err.(errSkip); ok {
				if os.Getenv("SCF_TRANSPORT_REQUIRE_ALL") == "1" {
					t.Fatalf("client unavailable: %s", e.why)
				}
				t.Skip(e.why)
			}
			if err != nil {
				t.Fatal(err)
			}
			s, ua, ok := ts.snapshot(c.name)
			if !ok || s.Hello == nil {
				t.Fatalf("no fingerprint recorded (ok=%v)", ok)
			}
			o := observation{Client: c.name, JA4: s.Hello.JA4, ALPN: s.ALPN, Observed: Observed(s.Hello)}
			if s.H2 != nil {
				o.H2 = s.H2.String()
			}
			asChrome := Check("chrome", "windows", s)
			o.AsChrome, o.Why = asChrome.Result, asChrome.Why
			if strings.HasPrefix(c.name, "playwright-") {
				fam, os := uaFamilyOS(ua)
				o.UA = fam + "/" + os
				o.AsOwn = Check(fam, os, s).Result
			}
			obs = append(obs, o)
			t.Logf("%s: ja4=%s alpn=%s h2=%s family=%s claiming-chrome=%s(%s) own=%s", c.name, o.JA4, o.ALPN, o.H2, o.Observed, o.AsChrome, o.Why, o.AsOwn)
			if c.expect != "" && o.Observed != c.expect {
				t.Errorf("observed family %s, want %s", o.Observed, c.expect)
			}
			switch c.expect {
			case Library:
				if o.AsChrome != Mismatch {
					t.Errorf("a %s claiming Chrome must be a mismatch, got %s", c.name, o.AsChrome)
				}
			case Chromium, Gecko:
				if o.AsOwn != Match {
					t.Errorf("a real browser with its own UA must match, got %s (h2 %s)", o.AsOwn, o.H2)
				}
			}
			if c.expect == Gecko && o.AsChrome != Mismatch {
				t.Errorf("Firefox claiming Chrome must be a mismatch")
			}
		})
	}
	if out := os.Getenv("SCF_TRANSPORT_OBSERVED"); out != "" {
		sort.Slice(obs, func(i, j int) bool { return obs[i].Client < obs[j].Client })
		b, _ := json.MarshalIndent(map[string]any{"rules_version": RulesVersion, "observed_at": time.Now().UTC().Format(time.RFC3339), "clients": obs}, "", "  ")
		if err := os.WriteFile(out, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// uaFamilyOS is a tiny stand-in for uaclass (which this package must not import): enough for the browsers above.
func uaFamilyOS(ua string) (string, string) {
	os := "other"
	switch {
	case strings.Contains(ua, "Windows"):
		os = "windows"
	case strings.Contains(ua, "Macintosh"):
		os = "macos"
	case strings.Contains(ua, "Linux"):
		os = "linux"
	}
	switch {
	case strings.Contains(ua, "Firefox/"):
		return "firefox", os
	case strings.Contains(ua, "Chrome/"):
		return "chrome", os
	case strings.Contains(ua, "Safari/"):
		return "safari", os
	}
	return "other", os
}
