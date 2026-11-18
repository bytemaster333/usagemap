// SPDX-License-Identifier: Apache-2.0

// Package logscan is the production log scanner behind `LogPIIDetected` (monitoring plan §7.1, TM-PRV-06.M.1): it
// reads the last window of operational logs from VictoriaLogs and counts lines that contain a public IP address
// (IPv4 or IPv6, including the 2001:db8::/32 visitor surrogates), a User-Agent string, a bearer token, an `scfa_`
// key, a Stellar secret seed or account id. It exports counts per class only; the matching text is never logged,
// stored or exported. Infrastructure-internal addresses (loopback, RFC 1918, link-local, ULA, CGNAT) are not
// personal data and are not counted.
package logscan

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Classes of findings (closed list; the metric label).
const (
	ClassIPv4   = "ipv4"
	ClassIPv6   = "ipv6"
	ClassUA     = "user_agent"
	ClassBearer = "bearer_token"
	ClassAPIKey = "api_key"
	ClassSeed   = "stellar_seed"
	ClassG      = "stellar_account"
)

var (
	reIPv4   = regexp.MustCompile(`(?:^|[^0-9.])((?:\d{1,3}\.){3}\d{1,3})(?:$|[^0-9.])`)
	reIPv6   = regexp.MustCompile(`(?i)(?:^|[^0-9a-f:])([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})(?:$|[^0-9a-f:])`)
	reUA     = regexp.MustCompile(`Mozilla/\d|AppleWebKit/|Gecko/\d|Chrome/\d+\.|Safari/\d|curl/\d|python-requests/|okhttp/`)
	reBearer = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/=-]{12,}`)
	reKey    = regexp.MustCompile(`scfa_[a-z]{2,4}_[A-Za-z0-9]{6,}`)
	reSeed   = regexp.MustCompile(`\bS[A-Z2-7]{55}\b`)
	reG      = regexp.MustCompile(`\bG[A-Z2-7]{55}\b`)
	cgnat    = netip.MustParsePrefix("100.64.0.0/10")
)

func internal(a netip.Addr) bool {
	return a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsUnspecified() || a.IsMulticast() || cgnat.Contains(a)
}

// Classify returns the classes found in one log line.
func Classify(line string) []string {
	var out []string
	for _, m := range reIPv4.FindAllStringSubmatch(line, -1) {
		if a, err := netip.ParseAddr(m[1]); err == nil && !internal(a) {
			out = append(out, ClassIPv4)
			break
		}
	}
	for _, m := range reIPv6.FindAllStringSubmatch(line, -1) {
		if !strings.Contains(m[1], "::") && strings.Count(m[1], ":") < 7 {
			continue // times like 12:30:45 are not addresses
		}
		if a, err := netip.ParseAddr(m[1]); err == nil && a.Is6() && !internal(a) {
			out = append(out, ClassIPv6)
			break
		}
	}
	for cls, re := range map[string]*regexp.Regexp{ClassUA: reUA, ClassBearer: reBearer, ClassAPIKey: reKey, ClassSeed: reSeed, ClassG: reG} {
		if re.MatchString(line) {
			out = append(out, cls)
		}
	}
	return out
}

// Scan queries VictoriaLogs for the last window and counts findings per class and stream (container/service name).
func Scan(ctx context.Context, client *http.Client, base string, window time.Duration, limit int) (map[string]int, int, error) {
	q := url.Values{"query": {fmt.Sprintf("_time:%ds", int(window.Seconds()))}, "limit": {fmt.Sprint(limit)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/select/logsql/query?"+q.Encode(), nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("victorialogs answered %d", resp.StatusCode)
	}
	counts := map[string]int{}
	lines := 0
	sc := bufio.NewScanner(io.LimitReader(resp.Body, 256<<20))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var rec map[string]any
		if json.Unmarshal(sc.Bytes(), &rec) != nil {
			continue
		}
		lines++
		var b strings.Builder
		for k, v := range rec {
			if k == "_time" || k == "_stream_id" {
				continue
			}
			if s, ok := v.(string); ok {
				b.WriteString(s)
				b.WriteByte(' ')
			}
		}
		for _, c := range Classify(b.String()) {
			counts[c]++
		}
	}
	return counts, lines, sc.Err()
}
