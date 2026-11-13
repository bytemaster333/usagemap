// SPDX-License-Identifier: Apache-2.0
package pathnorm

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Normalize turns a raw path or a tenant http.route into a low-cardinality
// route that contains no secret, personal identifier or Stellar identifier.
//
// It is pure, deterministic and idempotent:
// Normalize(Normalize(x, o).Route, o).Route == Normalize(x, o).Route.
// Query strings and fragments are always removed (after being scanned for
// secrets, which are counted only). It never returns {unknown} or {overflow};
// see NormalizeSpan for the former, the metrics writer owns the latter.
func Normalize(in string, opts Options) Result {
	var res Result
	route := opts.Input == InputRoute
	loc := LocPath
	if route {
		loc = LocRoute
	}

	// A0: empty input.
	if in == "" {
		res.fire(RuleEmpty)
		res.Flags |= FlagEmpty
		res.Route = "/"
		return res
	}
	// A1: input over 8 KiB. Still scanned for secrets so that the tenant is
	// warned (counter only).
	if len(in) > MaxInputBytes {
		res.fire(RuleTooLong)
		res.Flags |= FlagTooLong
		scanTail(in, &res, loc)
		res.Route = "/" + PhLong
		return res
	}
	// A2: absolute-form target → path.
	if m := rxAbsolute.FindStringIndex(in); m != nil {
		in = in[m[1]:]
		res.fire(RuleAbsolute)
	}
	// R0: "METHOD /route" (span-name style) sent as http.route.
	if route && len(in) > 4 && in[0] >= 'A' && in[0] <= '_' && rxMethodPrefix.MatchString(in) {
		in = in[strings.IndexByte(in, '/'):]
		res.fire(RuleStripMethod)
		res.Flags |= FlagMethodStripped
	}
	// A3: asterisk-form.
	if in == "*" {
		res.fire(RuleAsterisk)
		res.Route = "*"
		return res
	}
	// A4: query and fragment — scanned for secrets (counter only), dropped.
	if i := strings.IndexAny(in, "?#"); i >= 0 {
		scanTail(in[i+1:], &res, LocQuery)
		in = in[:i]
		res.fire(RuleQueryFragment)
		res.Flags |= FlagQueryStripped
	}
	// A5: leading slash.
	if !strings.HasPrefix(in, "/") {
		in = "/" + in
		res.fire(RuleLeadingSlash)
	}

	// A6–A9: split, drop empty segments, strip ;matrix parameters,
	// percent-decode once, reject invalid UTF-8 / control characters,
	// resolve dot-segments.
	var itemBuf [16]item
	items := itemBuf[:0]
	for s := range strings.SplitSeq(in[1:], "/") {
		if s == "" {
			continue // A6
		}
		if !route {
			if j := strings.IndexByte(s, ';'); j >= 0 {
				scanTail(s[j+1:], &res, LocQuery)
				s = s[:j]
				res.fire(RuleMatrix)
				if s == "" {
					continue
				}
			}
		}
		d := percentDecode(s)
		if !utf8.ValidString(d) {
			res.fire(RuleInvalidUTF8)
			res.Flags |= FlagInvalid
			items = append(items, item{fixed: PhInvalid})
			continue
		}
		if hasControl(d) {
			res.fire(RuleControlChar)
			res.Flags |= FlagInvalid
			items = append(items, item{fixed: PhInvalid})
			continue
		}
		switch d {
		case ".":
			res.fire(RuleDotSegment)
			continue
		case "..":
			res.fire(RuleDotSegment)
			if len(items) > 0 {
				items = items[:len(items)-1]
			}
			continue
		}
		items = append(items, item{dec: d})
	}
	// A10: depth cap.
	if len(items) > MaxDepth {
		items = append(items[:MaxDepth], item{fixed: PhRest})
		res.fire(RuleDepthCap)
		res.Flags |= FlagTruncated
	}

	// S/K/R: classify each segment.
	var outBuf [MaxDepth + 1]string
	out := outBuf[:0]
	for _, it := range items {
		if it.fixed != "" {
			out = append(out, it.fixed)
			continue
		}
		d := it.dec
		if route {
			if ph, ok := routePlaceholder(d); ok {
				res.fire(RuleRoutePlaceholder)
				out = append(out, ph)
				continue
			}
		}
		// K1: Horizon data-entry key after accounts/{account}/data/.
		if n := len(out); n >= 3 && out[n-1] == "data" && out[n-2] == PhAccount && out[n-3] == "accounts" {
			if isOwnPlaceholder(d) { // S0 first, as in classify (idempotence)
				out = append(out, d)
				continue
			}
			if ph, ok := classifySensitive(d, &res, loc); ok {
				out = append(out, ph)
				continue
			}
			res.fire(RuleHorizonDataKey)
			out = append(out, PhKey)
			continue
		}
		seg, literal := classify(d, &res, loc, opts.Folding)
		if literal {
			seg = encodeLiteral(seg)
		}
		out = append(out, seg)
	}

	// A11: output cap, cut at a segment boundary.
	size := 0
	for _, s := range out {
		size += 1 + len(s)
	}
	if size > MaxOutputBytes {
		keep, total := 0, 0
		for keep < len(out) && total+1+len(out[keep])+1+len(PhRest) <= MaxOutputBytes {
			total += 1 + len(out[keep])
			keep++
		}
		out = append(out[:keep], PhRest)
		res.fire(RuleOutputCap)
		res.Flags |= FlagTruncated
	}
	if len(out) == 0 {
		res.Route = "/"
		return res
	}
	res.Route = "/" + strings.Join(out, "/")
	return res
}

type item struct {
	fixed string // already final ({invalid}, {rest})
	dec   string // decoded segment to classify
}

// SpanInputs are the span/data-point attributes the Collector's sanitise
// step may have (wire-formats §f.6).
type SpanInputs struct {
	Route   string // http.route (tenant template)
	URLPath string // url.path
	Target  string // http.target (legacy; query is stripped)
	URL     string // url.full or http.url (legacy); its path is used
}

// NormalizeSpan applies the input precedence http.route → url.path →
// http.target → path of url.full/http.url. When none is present it returns
// the route {unknown} (C-16, C-89); Normalize itself never does.
func NormalizeSpan(in SpanInputs) Result {
	switch {
	case in.Route != "":
		return Normalize(in.Route, Options{Input: InputRoute})
	case in.URLPath != "":
		return Normalize(in.URLPath, Options{Input: InputPath})
	case in.Target != "":
		return Normalize(in.Target, Options{Input: InputPath})
	case in.URL != "":
		return Normalize(in.URL, Options{Input: InputPath})
	}
	return Result{Route: PhUnknown}
}

// NormalizeWebPage normalises a web page path for the gateway with the
// site's folding setting.
func NormalizeWebPage(path string, folding Folding) Result {
	return Normalize(path, Options{Input: InputWebPage, Folding: folding})
}

// Route-mode placeholder syntaxes (R1). Names: ^[A-Za-z_][A-Za-z0-9_]{0,31}$.
var routeSyntaxes = []*regexp.Regexp{
	regexp.MustCompile(`^:([A-Za-z_][A-Za-z0-9_]{0,31})\??$`),                      // Express/Koa :id
	regexp.MustCompile(`^\{([A-Za-z_][A-Za-z0-9_]{0,31})(?::[^}]*)?\}$`),           // chi/OpenAPI {id}, {id:\w+}
	regexp.MustCompile(`^<(?:[a-z]+:)?([A-Za-z_][A-Za-z0-9_]{0,31})>$`),            // Flask <int:id>
	regexp.MustCompile(`^\[{1,2}(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]{0,31})\]{1,2}$`), // Next.js [id], [...slug], [[...slug]]
}

// routePlaceholder canonicalises a framework placeholder: named parameters
// become {lower-cased name}; the catch-alls *, **, *name and (.*) become
// {wildcard}. The names unknown and overflow are reserved for route-level
// placeholders and are treated as ordinary text.
func routePlaceholder(d string) (string, bool) {
	if d == "" {
		return "", false
	}
	switch d[0] {
	case '*':
		if d == "*" || d == "**" || isIdent(d[1:]) {
			return PhWildcard, true
		}
		return "", false
	case '(':
		if d == "(.*)" {
			return PhWildcard, true
		}
		return "", false
	case ':', '{', '<', '[':
	default:
		return "", false
	}
	for _, rx := range routeSyntaxes {
		m := rx.FindStringSubmatch(d)
		if m == nil {
			continue
		}
		name := strings.ToLower(m[1])
		if name == "unknown" || name == "overflow" {
			return "", false
		}
		return "{" + name + "}", true
	}
	return "", false
}

// isIdent: ^[A-Za-z_][A-Za-z0-9_]{0,31}$.
func isIdent(s string) bool {
	if len(s) < 1 || len(s) > MaxParamName {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isLetter(c) || c == '_' || i > 0 && c >= '0' && c <= '9' {
			continue
		}
		return false
	}
	return true
}

// scanTail scans a query string, fragment, matrix parameter or over-long
// input for secrets. Hits are counted at loc; nothing else is kept.
func scanTail(tail string, res *Result, loc Location) {
	if tail == "" {
		return
	}
	d := percentDecode(tail)
	start := -1
	for i := 0; i <= len(d); i++ {
		if i < len(d) && (isAlnum(d[i]) || d[i] == '_' || d[i] == '.' || d[i] == '-') {
			if start < 0 {
				start = i
			}
			continue
		}
		if start >= 0 {
			scanToken(d[start:i], res, loc)
			start = -1
		}
	}
}

func scanToken(t string, res *Result, loc Location) {
	switch {
	case len(t) >= 56 && (rxSeedWhole.MatchString(t) || rxSeedEmbed.MatchString(t)):
		res.redact(KindStellarSeed, loc)
	case strings.Contains(t, "eyJ") && (rxJWT.MatchString(t) || rxJWTEmbed.MatchString(t)):
		res.redact(KindJWT, loc)
	case len(t) >= 16 && (rxAPIKey.MatchString(t) || rxAPIKeyEmbed.MatchString(t)):
		res.redact(KindAPIKey, loc)
	}
}

// percentDecode decodes %XX escapes once; malformed escapes are kept as text.
func percentDecode(s string) string {
	i := strings.IndexByte(s, '%')
	if i < 0 {
		return s
	}
	b := make([]byte, 0, len(s))
	b = append(b, s[:i]...)
	for ; i < len(s); i++ {
		c := s[i]
		if c == '%' && i+2 < len(s) && isHexDigit(s[i+1]) && isHexDigit(s[i+2]) {
			b = append(b, unhex(s[i+1])<<4|unhex(s[i+2]))
			i += 2
			continue
		}
		b = append(b, c)
	}
	return string(b)
}

func isHexDigit(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func unhex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	}
	return c - 'A' + 10
}

// hasControl reports C0 controls, DEL and C1 controls.
func hasControl(d string) bool {
	for _, r := range d {
		if r < 0x20 || r == 0x7F || r >= 0x80 && r <= 0x9F {
			return true
		}
	}
	return false
}

// encodeLiteral re-emits a decoded literal with canonical percent-encoding:
// unreserved characters raw, everything else as upper-case %XX of its UTF-8
// bytes (only "/", "?", "#" and non-ASCII can reach this point).
func encodeLiteral(d string) string {
	i := 0
	for i < len(d) && isUnreserved(d[i]) {
		i++
	}
	if i == len(d) {
		return d
	}
	const hexd = "0123456789ABCDEF"
	b := make([]byte, 0, len(d)+16)
	b = append(b, d[:i]...)
	for ; i < len(d); i++ {
		c := d[i]
		if isUnreserved(c) {
			b = append(b, c)
			continue
		}
		b = append(b, '%', hexd[c>>4], hexd[c&15])
	}
	return string(b)
}
