// SPDX-License-Identifier: Apache-2.0

package transport

import (
	"crypto/tls"
	"testing"
)

// The FoxIO JA4 README's worked example (Chrome): cipher list → JA4_b 8daaf6152771, extensions + signature
// algorithms → JA4_c e5627efa2ab1, JA4_a t13d1516h2.
var chromeCiphers = []uint16{0x0a0a, 0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035}
var chromeExts = []uint16{0x1a1a, 0x0000, 0x0017, 0xff01, 0x000a, 0x000b, 0x0023, 0x0010, 0x0005, 0x000d, 0x0012, 0x0033, 0x002d, 0x002b, 0x001b, 0x4469, 0x0015, 0x2a2a}
var chromeSig = []tls.SignatureScheme{0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601}

func TestJA4ReferenceVector(t *testing.T) {
	h := FromClientHello(&tls.ClientHelloInfo{
		CipherSuites: chromeCiphers, Extensions: chromeExts, SignatureSchemes: chromeSig,
		SupportedVersions: []uint16{0x7a7a, 0x0304, 0x0303}, SupportedProtos: []string{"h2", "http/1.1"}, ServerName: "example.com",
	})
	if want := "t13d1516h2_8daaf6152771_e5627efa2ab1"; h.JA4 != want {
		t.Fatalf("JA4 = %s, want %s", h.JA4, want)
	}
	if !h.Grease || !h.SNI || h.Version != 0x0304 || len(h.Ciphers) != 15 || len(h.Extensions) != 16 {
		t.Fatalf("reduced hello wrong: %+v", h)
	}
	// Extension order does not matter (Chromium permutes extensions per connection since 2023).
	perm := append([]uint16(nil), chromeExts...)
	for i, j := 0, len(perm)-1; i < j; i, j = i+1, j-1 {
		perm[i], perm[j] = perm[j], perm[i]
	}
	h2 := FromClientHello(&tls.ClientHelloInfo{CipherSuites: chromeCiphers, Extensions: perm, SignatureSchemes: chromeSig,
		SupportedVersions: []uint16{0x0304}, SupportedProtos: []string{"h2"}})
	if h2.JA4 != h.JA4 {
		t.Fatalf("permuted extensions changed JA4: %s vs %s", h2.JA4, h.JA4)
	}
}

func TestJA4Parts(t *testing.T) {
	for _, c := range []struct {
		name string
		chi  tls.ClientHelloInfo
		want string
	}{
		{"no sni, no alpn, tls1.2, empty lists", tls.ClientHelloInfo{SupportedVersions: []uint16{0x0303}}, "t12i000000_000000000000_000000000000"},
		{"http/1.1 alpn", tls.ClientHelloInfo{SupportedVersions: []uint16{0x0304}, SupportedProtos: []string{"http/1.1"}, Extensions: []uint16{0x0010}}, "t13i0001h1_000000000000_000000000000"},
		{"non-alnum alpn", tls.ClientHelloInfo{SupportedVersions: []uint16{0x0304}, SupportedProtos: []string{"\xabx\xcd"}}, "t13i0000ad_000000000000_000000000000"},
	} {
		if got := FromClientHello(&c.chi).JA4; got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
	for _, g := range []uint16{0x0a0a, 0x1a1a, 0xfafa} {
		if !IsGREASE(g) {
			t.Errorf("%04x should be GREASE", g)
		}
	}
	for _, g := range []uint16{0x0a1a, 0x1301, 0x4469} {
		if IsGREASE(g) {
			t.Errorf("%04x is not GREASE", g)
		}
	}
}
