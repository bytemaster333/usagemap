// SPDX-License-Identifier: Apache-2.0

// Package guard scrubs what a browser sends before anything is spooled: page paths go through the pathnorm rule
// set with the site's folding (C-52, C-65, C-70: query and fragment dropped, identifiers folded, secrets and personal
// identifiers redacted), and custom-event names and property values pass the same value guard as the tracker plus
// pathnorm's API-key prefixes (wire-formats §a.4, C-100).
package guard

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/bytemaster333/usagemap/packages/pathnorm"
)

// RulesVersion is the pathnorm rule set linked into this binary.
const RulesVersion = pathnorm.RuleSetVersion

// Path normalises a page path for a site. redacted reports that a secret or personal identifier was removed
// (counted `drop/path_redacted`). The result never contains a query string or fragment.
func Path(raw, folding string) (path string, redacted bool) {
	f, err := pathnorm.ParseFolding(folding)
	if err != nil {
		f = pathnorm.FoldingFull
	}
	res := pathnorm.NormalizeWebPage(raw, f)
	p := res.Route
	if i := strings.IndexAny(p, "?#"); i >= 0 { // defence in depth: pathnorm never returns one
		p = p[:i]
	}
	if p == "" || p[0] != '/' {
		p = "/"
	}
	if len(p) > 500 {
		p = p[:500]
	}
	return p, res.Redactions.Total() > 0
}

var (
	reEmail = regexp.MustCompile(`[^@\s]+@[^@\s]+\.[A-Za-z]{2,}`)
	reJWT   = regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`)
	reLong  = regexp.MustCompile(`[A-Za-z0-9+/]{32,}`)
	// rePhoneRun finds the candidates for pathnorm's phone rule inside free text: a '+', a digit, then digits and
	// the separators the rule allows. Each candidate is judged by pathnorm itself.
	rePhoneRun = regexp.MustCompile(`\+[0-9][0-9 ().-]*`)
)

// sensitive are the pathnorm redaction kinds that make a value unsafe: every secret and every personal identifier
// (IP literals, phone numbers and federation addresses as well as seeds, JWTs, API keys, e-mail).
var sensitive = []pathnorm.Kind{pathnorm.KindStellarSeed, pathnorm.KindJWT, pathnorm.KindAPIKey, pathnorm.KindEmail,
	pathnorm.KindFederation, pathnorm.KindPhone, pathnorm.KindIP}

// pathnormSensitive runs pathnorm's own detectors on one candidate string (as a single path segment).
func pathnormSensitive(v string) bool {
	if v == "" {
		return false
	}
	res := pathnorm.Normalize("/"+url.PathEscape(v), pathnorm.Options{Input: pathnorm.InputPath})
	for _, k := range sensitive {
		if res.Redactions.ByKind(k) > 0 {
			return true
		}
	}
	return false
}

// tokenSeps split free text into the words pathnorm judges one by one. ':' is not a separator in the first pass
// (an IPv6 literal contains it) but is in the second (an IPv4 literal with a port).
const tokenSeps = " \t\r\n,;()[]{}<>\"'|=!?/\\"

func words(v, seps string) []string {
	return strings.FieldsFunc(v, func(r rune) bool { return strings.ContainsRune(seps, r) })
}

// Unsafe reports whether a custom-event name or property value must be dropped (`drop/prop_redacted`): an e-mail
// address (also with `%40`), a JWT, any run of ≥ 32 base64/hex characters (every StrKey and hash), or anything the
// pathnorm rule set redacts as a secret (seed, JWT, API-key prefix) or personal identifier (e-mail, federation
// address, phone number, IP literal) — judged on the whole value, on every word of it and on every phone-shaped run,
// because a property value is free text, not a path segment.
func Unsafe(v string) bool {
	decoded := strings.NewReplacer("%40", "@", "%2540", "@").Replace(v)
	if reEmail.MatchString(decoded) || reJWT.MatchString(v) || reLong.MatchString(v) {
		return true
	}
	if pathnormSensitive(v) {
		return true
	}
	for _, seps := range []string{tokenSeps, tokenSeps + ":"} {
		for _, w := range words(v, seps) {
			if w = strings.Trim(w, ".:-_*+"); w != v && pathnormSensitive(w) {
				return true
			}
			if strings.HasPrefix(strings.TrimLeft(w, ".:-_"), "+") && pathnormSensitive(strings.TrimLeft(w, ".:-_")) {
				return true
			}
		}
	}
	for _, run := range rePhoneRun.FindAllString(v, -1) {
		if run = strings.TrimRight(run, " ().-"); pathnormSensitive(run) {
			return true
		}
	}
	return false
}
