// SPDX-License-Identifier: Apache-2.0

// Package transport computes per-connection transport fingerprints on the gateway's own TLS listener — a JA4-style
// TLS ClientHello fingerprint and an HTTP/2 connection-preface fingerprint (SETTINGS, WINDOW_UPDATE, PRIORITY and the
// pseudo-header order of the first request) — and classifies them into a small, versioned set of transport families
// (C-124, wire-formats §h.2 `transport_mismatch`). Fingerprints live in memory for the life of one connection only;
// they are never logged, stored, spooled or forwarded. Only the family labels leave this package.
package transport

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"slices"
	"strconv"
	"strings"
)

// Extension code points used by the fingerprint and the classifier.
const (
	extSNI             = 0x0000
	extALPN            = 0x0010
	extRecordSizeLimit = 0x001c
	extALPSNew         = 0x44cd // application_settings (ALPS), the codepoint Chromium moved to in 2025
	extALPSDraft       = 0x4469 // application_settings (ALPS), the draft codepoint used by earlier Chromium
)

// IsGREASE reports whether v is a GREASE value (RFC 8701): 0x?a?a with equal bytes.
func IsGREASE(v uint16) bool { return v&0x0f0f == 0x0a0a && v>>8 == v&0xff }

// Hello is the reduced ClientHello of one connection.
type Hello struct {
	JA4        string   // t13d1516h2_8daaf6152771_02713d6af862 (FoxIO JA4 layout)
	Version    uint16   // highest offered version (GREASE ignored)
	SNI        bool     // server_name extension present
	ALPN       []string // offered protocols in order
	Ciphers    []uint16 // GREASE removed, original order
	Extensions []uint16 // GREASE removed, original order
	SigAlgs    []uint16 // original order
	Grease     bool     // GREASE in the cipher list or the extension list
}

// HasExt reports whether the ClientHello carried extension e.
func (h *Hello) HasExt(e uint16) bool { return slices.Contains(h.Extensions, e) }

// FromClientHello reduces a ClientHelloInfo. The info is not retained.
func FromClientHello(chi *tls.ClientHelloInfo) Hello {
	var h Hello
	for _, c := range chi.CipherSuites {
		if IsGREASE(c) {
			h.Grease = true
			continue
		}
		h.Ciphers = append(h.Ciphers, c)
	}
	for _, e := range chi.Extensions {
		if IsGREASE(e) {
			h.Grease = true
			continue
		}
		h.Extensions = append(h.Extensions, e)
		if e == extSNI {
			h.SNI = true
		}
	}
	for _, v := range chi.SupportedVersions {
		if !IsGREASE(v) && v > h.Version {
			h.Version = v
		}
	}
	for _, s := range chi.SignatureSchemes {
		if !IsGREASE(uint16(s)) {
			h.SigAlgs = append(h.SigAlgs, uint16(s))
		}
	}
	h.ALPN = append([]string(nil), chi.SupportedProtos...)
	h.JA4 = ja4(&h)
	return h
}

func versionCode(v uint16) string {
	switch v {
	case 0x0304:
		return "13"
	case 0x0303:
		return "12"
	case 0x0302:
		return "11"
	case 0x0301:
		return "10"
	case 0x0300:
		return "s3"
	case 0x0002:
		return "s2"
	}
	return "00"
}

func isAlnum(b byte) bool {
	return b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

func alpnCode(alpn []string) string {
	if len(alpn) == 0 || alpn[0] == "" {
		return "00"
	}
	a := alpn[0]
	f, l := a[0], a[len(a)-1]
	if isAlnum(f) && isAlnum(l) {
		return string([]byte{f, l})
	}
	hf, hl := hex.EncodeToString([]byte{f}), hex.EncodeToString([]byte{l})
	return hf[:1] + hl[1:]
}

func count2(n int) string {
	if n > 99 {
		n = 99
	}
	s := strconv.Itoa(n)
	if len(s) == 1 {
		return "0" + s
	}
	return s
}

func hexList(v []uint16) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = hex.EncodeToString([]byte{byte(x >> 8), byte(x)})
	}
	return strings.Join(parts, ",")
}

func hash12(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:12]
}

// ja4 renders the JA4 TLS client fingerprint (FoxIO JA4 specification, TCP only): JA4_a "t" ‖ version ‖ d|i ‖
// cipher count ‖ extension count ‖ ALPN first+last character; JA4_b = SHA-256 prefix of the sorted cipher list;
// JA4_c = SHA-256 prefix of the sorted extension list without SNI and ALPN, "_", the signature algorithms in order.
func ja4(h *Hello) string {
	sni := "i"
	if h.SNI {
		sni = "d"
	}
	a := "t" + versionCode(h.Version) + sni + count2(len(h.Ciphers)) + count2(len(h.Extensions)) + alpnCode(h.ALPN)
	b := "000000000000"
	if len(h.Ciphers) > 0 {
		cs := slices.Clone(h.Ciphers)
		slices.Sort(cs)
		b = hash12(hexList(cs))
	}
	c := "000000000000"
	var ext []uint16
	for _, e := range h.Extensions {
		if e != extSNI && e != extALPN {
			ext = append(ext, e)
		}
	}
	if len(ext) > 0 {
		slices.Sort(ext)
		s := hexList(ext)
		if len(h.SigAlgs) > 0 {
			s += "_" + hexList(h.SigAlgs)
		}
		c = hash12(s)
	}
	return a + "_" + b + "_" + c
}
