// SPDX-License-Identifier: Apache-2.0

package logscan

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	for line, want := range map[string][]string{
		`{"level":"info","msg":"canary round","elapsed_ms":312,"time":"2026-11-13T12:30:45Z"}`: nil,
		`connection from 10.0.3.7 port 5432`:                                                   nil,
		`listening on 127.0.0.1:9464 and [::1]:9464`:                                           nil,
		`version 3.5.0 build 1.2.3`:                                                            nil,
		`client 203.0.113.9 sent event`:                                                        {ClassIPv4},
		`surrogate 2001:db8:4f1a::9 forwarded`:                                                 {ClassIPv6},
		`ua=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36`:                                {ClassUA},
		`Authorization: Bearer abcdefghijklmnopqrst`:                                           {ClassBearer},
		"key scfa_op_" + "1a2b3c4d5e_x presented":                                              {ClassAPIKey},
		"seed S" + strings.Repeat("A", 55):                                                     {ClassSeed},
		"wallet G" + strings.Repeat("B", 55):                                                   {ClassG},
	} {
		got := Classify(line)
		slices.Sort(got)
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Errorf("%q: got %v, want %v", line, got, want)
		}
	}
}

func TestScanCountsWithoutReturningText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/select/logsql/query" || r.URL.Query().Get("query") != "_time:300s" {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write([]byte(`{"_time":"2026-11-13T12:00:00Z","_msg":"ok","service":"gateway"}
{"_time":"2026-11-13T12:00:01Z","_msg":"from 198.51.100.4","service":"gateway"}
not json
{"_time":"2026-11-13T12:00:02Z","_msg":"Bearer abcdefghijklmnop","service":"control-plane"}
`))
	}))
	defer srv.Close()
	counts, lines, err := Scan(context.Background(), srv.Client(), srv.URL, 5*time.Minute, 1000)
	if err != nil || lines != 3 || counts[ClassIPv4] != 1 || counts[ClassBearer] != 1 {
		t.Fatalf("%v %d %v", counts, lines, err)
	}
}
