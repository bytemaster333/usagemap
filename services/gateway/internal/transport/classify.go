// SPDX-License-Identifier: Apache-2.0

package transport

import "slices"

// RulesVersion names the classification rule set below. Change it with every rule change (C-124: the rule set is a
// versioned allow-list of real-browser transport families and is re-checked against current browser majors).
const RulesVersion = "scf-transport/1 (2026-11: Chromium 1xx, Firefox 1xx, Safari 17–26)"

// Families. Engines a User-Agent can claim, and what a connection's transport looks like.
const (
	Chromium = "chromium" // Chrome, Edge, Opera, Samsung Internet, Brave … (BoringSSL with GREASE and ALPS)
	Gecko    = "gecko"    // Firefox outside iOS (NSS: no GREASE, record_size_limit)
	Apple    = "apple"    // Safari and every iOS browser (Apple's TLS stack: GREASE, no ALPS)
	Library  = "library"  // a TLS library default: no GREASE and no NSS markers (Go, OpenSSL — curl, Python, Node —, rustls, Java …)
	None     = "none"     // no claim (unknown browser family), or no TLS fingerprint (plaintext listener)
)

// Results.
const (
	Match     = "match"
	Mismatch  = "mismatch"
	Unchecked = "unchecked"
)

// Claimed returns the transport family a User-Agent's browser family implies (uaclass families and OS): every iOS
// browser uses Apple's network stack; Safari outside Apple platforms (WebKitGTK/WPE, e.g. GNOME Web) is not checked.
func Claimed(family, os string) string {
	if os == "ios" {
		switch family {
		case "chrome", "edge", "firefox", "safari", "opera":
			return Apple
		}
		return None
	}
	switch family {
	case "chrome", "edge", "opera", "samsung":
		return Chromium
	case "firefox":
		return Gecko
	case "safari":
		if os == "macos" {
			return Apple
		}
	}
	return None
}

// Observed classifies a ClientHello into a family.
func Observed(h *Hello) string {
	if h == nil {
		return None
	}
	alps := h.HasExt(extALPSNew) || h.HasExt(extALPSDraft)
	switch {
	case h.Grease && alps:
		return Chromium
	case h.Grease:
		return Apple
	case h.HasExt(extRecordSizeLimit):
		return Gecko
	default:
		return Library
	}
}

// pseudo-header orders of the first request per engine (Akamai HTTP/2 fingerprint "PS" part).
var pseudoOrders = map[string][]string{
	Chromium: {"masp"},
	Gecko:    {"mpas"},
	Apple:    {"mspa", "msap"},
}

// Verdict is the outcome of comparing a claim with a connection's fingerprints.
type Verdict struct {
	Claimed  string
	Observed string
	Result   string // match, mismatch, unchecked
	// Why is a closed label for metrics/tests: tls_family, alpn, h2_order, or "".
	Why string
}

// Check compares the User-Agent's claimed family with the connection's fingerprints. It never decides on its own: the
// caller adds the suspect reason `transport_mismatch` (never a rejection).
//
// Mismatch when the UA claims a browser engine and (1) the ClientHello's family differs, or (2) the client did not
// offer h2 first in ALPN (every current browser does over TLS), or (3) on HTTP/2, the first request's pseudo-header
// order is not the claimed engine's. Unchecked when there is no claim or no TLS fingerprint.
func Check(family, os string, s Snapshot) Verdict {
	v := Verdict{Claimed: Claimed(family, os), Observed: Observed(s.Hello), Result: Unchecked}
	if v.Claimed == None || s.Hello == nil {
		return v
	}
	switch {
	case v.Observed != v.Claimed:
		v.Result, v.Why = Mismatch, "tls_family"
	case len(s.Hello.ALPN) == 0 || s.Hello.ALPN[0] != "h2":
		v.Result, v.Why = Mismatch, "alpn"
	case s.H2 != nil && s.H2.Pseudo != "" && !slices.Contains(pseudoOrders[v.Claimed], s.H2.Pseudo):
		v.Result, v.Why = Mismatch, "h2_order"
	default:
		v.Result = Match
	}
	return v
}
