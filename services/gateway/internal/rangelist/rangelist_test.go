// SPDX-License-Identifier: Apache-2.0

package rangelist

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bytemaster333/usagemap/services/gateway/internal/netclass"
)

func TestParseFormats(t *testing.T) {
	cases := map[string]string{
		"lines":       "# tor\n185.220.101.1\n2a0b:f4c0::/32\n",
		"csv":         "172.224.224.0/31,GB,GB-EN,London,\n2a02:26f7:b3c0:4000::/64,US,US-CA,,\n",
		"aws-json":    `{"prefixes":[{"ip_prefix":"3.4.12.4/32"}],"ipv6_prefixes":[{"ipv6_prefix":"2600:1f00::/24"}]}`,
		"gcp-json":    `{"prefixes":[{"ipv4Prefix":"34.1.208.0/20"},{"ipv6Prefix":"2600:1900::/35"}]}`,
		"oracle-json": `{"regions":[{"cidrs":[{"cidr":"129.146.0.0/21"}]}]}`,
	}
	for f, body := range cases {
		ps, err := Parse(f, []byte(body))
		if err != nil || len(ps) == 0 {
			t.Errorf("%s: %v %v", f, ps, err)
		}
	}
	if _, err := Parse("lines", []byte("# nothing\n")); err == nil {
		t.Fatal("an empty list must fail (keep the previous one)")
	}
}

func TestRunWritesClassFilesAndKeepsPreviousOnFailure(t *testing.T) {
	fail := false
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			http.Error(w, "down", 500)
			return
		}
		switch r.URL.Path {
		case "/aws":
			_, _ = io.WriteString(w, `{"prefixes":[{"ip_prefix":"192.0.2.0/24"}],"ipv6_prefixes":[]}`)
		case "/tor":
			_, _ = io.WriteString(w, "198.51.100.7\n")
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	u := &Updater{Dir: dir, Client: srv.Client(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Sources: []Source{
		{Name: "aws", Class: "datacenter", URL: srv.URL + "/aws", Format: "aws-json"},
		{Name: "tor-exits", Class: "tor", URL: srv.URL + "/tor", Format: "lines"},
	}}
	if err := Validate(u.Sources); err != nil {
		t.Fatal(err)
	}
	st := u.Run(context.Background())
	if st[0].Error != "" || len(st[0].SHA256) != 64 {
		t.Fatalf("status %+v", st)
	}
	c := netclass.New(dir)
	if c.Class(netip.MustParseAddr("192.0.2.9")) != "datacenter" || c.Class(netip.MustParseAddr("198.51.100.7")) != "tor" {
		t.Fatal("class files not usable by the gateway")
	}
	fail = true
	st = u.Run(context.Background())
	if st[0].Error == "" {
		t.Fatal("expected failure")
	}
	b, _ := os.ReadFile(filepath.Join(dir, "datacenter.txt"))
	if !strings.Contains(string(b), "192.0.2.0/24") {
		t.Fatal("previous list lost after a failed fetch")
	}
}

func TestValidateRejects(t *testing.T) {
	for _, s := range []Source{{Name: "x", Class: "nope", URL: "https://a", Format: "lines"}, {Name: "x", Class: "tor", URL: "http://a", Format: "lines"}, {Name: "../x", Class: "tor", URL: "https://a", Format: "lines"}} {
		if Validate([]Source{s}) == nil {
			t.Errorf("accepted %+v", s)
		}
	}
	if Validate(Defaults) != nil {
		t.Fatal("defaults invalid")
	}
}
