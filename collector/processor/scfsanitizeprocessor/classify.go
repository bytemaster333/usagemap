// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strings"

	"github.com/bytemaster333/usagemap/packages/pathnorm"
)

// Free-text values that the allow-list keeps (service name, namespace and
// instance, deployment environment, scope name and version, rpc.*) are tenant
// controlled. C-114: each goes through pathnorm's sensitive-value classifier
// and is replaced by Redacted when it looks like a key, seed, Stellar address,
// e-mail address, JWT, IP address or URL with a query.
//
// pathnorm exports no value classifier (its classifySensitive/classifyStrKey
// are internal), so this wrapper drives the exported Normalize with the whole
// value as one path segment — which runs exactly pathnorm's S1 (seed anywhere,
// JWT, API key), S2 (e-mail, federation, phone, IP) and S4/S5 (StrKey, asset)
// rules on it — and with each token of the value. It adds what pathnorm's
// segment rules do not cover for free text: an IP address with a port or zone,
// an IPv4 address embedded in a longer token, any 56+ character base32 run
// (a StrKey shape whatever its version letter or checksum) and a query.

// Redacted replaces a kept free-text value that the classifier flagged. It is
// pathnorm's own placeholder, so no consumer can confuse it with tenant text.
const Redacted = pathnorm.PhRedacted

var (
	// rxBase32Run: a StrKey-shaped run of any version letter (56 characters
	// for G/C/S/T/X/L, 58 for B, 69 for M/W, more for P), any case.
	rxBase32Run = regexp.MustCompile(`(?i)[a-z2-7]{56,}`)
	// rxIPv4Run: a dotted quad anywhere; validated with netip.
	rxIPv4Run = regexp.MustCompile(`(?:^|[^0-9.])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?:[^0-9.]|$)`)
	// rxEmailLike: an e-mail shape anywhere (plain or %40), also with the
	// one-letter top-level labels pathnorm's stricter rule does not take.
	rxEmailLike = regexp.MustCompile(`(?i)[a-z0-9._%+-]+(@|%40)[a-z0-9-]+\.[a-z0-9.-]+`)
)

// tokenSep splits a free-text value into the tokens that are classified on
// their own: whitespace, path and list separators, quotes, brackets of URLs
// and query syntax. ':' and '.' stay inside tokens (IPv6, host:port, versions).
func tokenSep(r rune) bool {
	switch r {
	case ' ', '\t', '/', '\\', ',', ';', '=', '&', '?', '#', '"', '\'', '(', ')', '<', '>', '{', '}', '|', '!', '^', '`':
		return true
	}
	return false
}

// sensitiveValue reports whether a kept free-text value must be replaced.
func sensitiveValue(s string) bool {
	if s == "" {
		return false
	}
	// A query is never kept (URL with a query, or a path with one).
	if i := strings.IndexByte(s, '?'); i >= 0 && i < len(s)-1 {
		return true
	}
	if rxBase32Run.MatchString(s) || rxEmailLike.MatchString(s) {
		return true
	}
	if segmentSensitive(s) {
		return true
	}
	if pathSensitive(s) {
		return true
	}
	for _, m := range rxIPv4Run.FindAllStringSubmatchIndex(s, -1) {
		// A dotted quad right after "v"/"V" is a version ("v1.2.3.4", "release-v1.2.3.4"), not an address.
		// Without the "v" a four-part version stays redacted (fail closed).
		if m[2] > 0 && (s[m[2]-1] == 'v' || s[m[2]-1] == 'V') {
			continue
		}
		if a, err := netip.ParseAddr(s[m[2]:m[3]]); err == nil && a.Is4() {
			return true
		}
	}
	for tok := range strings.FieldsFuncSeq(s, tokenSep) {
		if tok != s && segmentSensitive(tok) {
			return true
		}
		if strings.IndexByte(tok, ':') >= 0 && hostPortSensitive(tok) {
			return true
		}
		// Finer splits for values glued to others: first on - + ~ * [ ] @ %
		// ("node-2001:db8::1", "x-[2001:db8::1]:443", "x-sk_live_…"), then
		// also on _ ("node_203.0.113.7:80").
		for _, sep := range [...]func(rune) bool{subTokenSep, subTokenSepUnderscore} {
			for sub := range strings.FieldsFuncSeq(tok, sep) {
				if sub == tok {
					continue
				}
				if segmentSensitive(sub) {
					return true
				}
				if strings.IndexByte(sub, ':') >= 0 && hostPortSensitive(sub) {
					return true
				}
			}
		}
	}
	return false
}

func subTokenSep(r rune) bool {
	switch r {
	case '-', '+', '~', '*', '[', ']', '@', '%':
		return true
	}
	return false
}

func subTokenSepUnderscore(r rune) bool { return r == '_' || subTokenSep(r) }

// segmentSensitive runs pathnorm's segment classifier on v as one segment.
func segmentSensitive(v string) bool {
	return resultSensitive(pathnorm.Normalize("/"+url.PathEscape(v), pathnorm.Options{Input: pathnorm.InputPath}))
}

// pathSensitive runs pathnorm on v as a path or absolute URL, so secrets in
// any of its segments are found.
func pathSensitive(v string) bool {
	return resultSensitive(pathnorm.Normalize(v, pathnorm.Options{Input: pathnorm.InputPath}))
}

// resultSensitive: a redaction (S1, S2) or a Stellar identifier (S4 StrKey of
// any type, also with a bad checksum; S5 asset with an issuer account).
func resultSensitive(r pathnorm.Result) bool {
	if r.Redactions.Total() > 0 || r.Flags.Has(pathnorm.FlagRedacted) {
		return true
	}
	for _, rule := range r.Rules {
		if strings.HasPrefix(string(rule), "S4.strkey") || rule == pathnorm.RuleAsset {
			return true
		}
	}
	return false
}

// hostPortSensitive: IP literals with a port ("203.0.113.7:8080",
// "[2001:db8::1]:443") or a zone ("fe80::1%eth0"), and each ':'-separated
// part ("USDC:G…", "stellar:G…", "user:secret").
func hostPortSensitive(tok string) bool {
	if _, err := netip.ParseAddrPort(tok); err == nil {
		return true
	}
	if _, err := netip.ParseAddr(strings.Trim(tok, "[]")); err == nil {
		return true
	}
	if host, _, err := net.SplitHostPort(tok); err == nil {
		if _, err := netip.ParseAddr(host); err == nil || segmentSensitive(host) {
			return true
		}
	}
	for part := range strings.SplitSeq(tok, ":") {
		if part != "" && part != tok && segmentSensitive(part) {
			return true
		}
	}
	return false
}

// freeText returns the value to keep for a tenant free-text string: ok is
// false when it is unusable (empty, too long, invalid UTF-8, control
// characters) and the attribute is to be omitted; redacted is true when it
// was replaced by Redacted.
func freeText(s string, maxLen int) (out string, ok, redacted bool) {
	clean, ok := cleanString(s, maxLen)
	if !ok {
		return "", false, false
	}
	if sensitiveValue(clean) {
		return Redacted, true, true
	}
	return clean, true, false
}

// rpcCharset: rpc.system, rpc.system.name and rpc.method are identifiers
// (grpc, connect_rpc, jsonrpc, GetAccount, pkg.Service/Method).
func rpcCharsetOK(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '.', c == '-', c == '/':
		default:
			return false
		}
	}
	return s != ""
}
