// SPDX-License-Identifier: Apache-2.0
package pathnorm

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

// SEP-23 v1.4.0 §Tests, stellar-protocol @ ced008c (2026-11-04).
var sep23Valid = []struct {
	key     string
	typ     StrKeyType
	payload string // hex; "" = not checked beyond length
}{
	{"GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ", StrKeyAccount, sep23Hash},
	{"MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ", StrKeyMuxedAccount, sep23Hash + "0000000000000000"},
	{"MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK", StrKeyMuxedAccount, sep23Hash + "8000000000000000"},
	{"PA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAQACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6IBZGM", StrKeySignedPayload,
		sep23Hash + "00000020" + "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"},
	{"PA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAOQCAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUAAAAFGBU", StrKeySignedPayload,
		sep23Hash + "0000001d" + "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d" + "000000"},
	{"CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA", StrKeyContract, sep23Hash},
	{"LA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUPJN", StrKeyLiquidityPool, sep23Hash},
	{"BAAD6DBUX6J22DMZOHIEZTEQ64CVCHEDRKWZONFEUL5Q26QD7R76RGR4TU", StrKeyClaimableBalance, "00" + sep23Hash},
	{"WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAWWC", StrKeyMuxedContract, sep23Hash + "0000000000000000"},
	{"WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAACWJY", StrKeyMuxedContract, sep23Hash + "8000000000000000"},
}

const sep23Hash = "3f0c34bf93ad0d9971d04ccc90f705511c838aad9734a4a2fb0d7a03fc7fe89a"

var sep23Invalid = []string{
	"GAAAAAAAACGC6",
	"MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUR",
	"GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZA",
	"GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUACUSI",
	"G47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVP2I",
	"MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLKA",
	"MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAAV75I",
	"M47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ",
	"MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUK===",
	"MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUO",
	"PA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAQACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6IAAAAAAAAPM",
	"PA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAOQCAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4Z2PQ",
	"PA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAOQCAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DXFH6",
	"BAAD6DBUX6J22DMZOHIEZTEQ64CVCHEDRKWZONFEUL5Q26QD7R76RGR4TV",
	"BAAT6DBUX6J22DMZOHIEZTEQ64CVCHEDRKWZONFEUL5Q26QD7R76RGXACA",
	"WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAWWD",
	"WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAWWCA",
	"WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAAIOUI",
	"W47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAADXHW",
	"WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAWWA",
}

func TestDecodeStrKeySEP23Valid(t *testing.T) {
	for _, v := range sep23Valid {
		typ, p, err := DecodeStrKey(v.key)
		if err != nil {
			t.Errorf("%s: %v", v.key, err)
			continue
		}
		if typ != v.typ {
			t.Errorf("%s: type %c, want %c", v.key, typ, v.typ)
		}
		want, _ := hex.DecodeString(v.payload)
		if !bytes.Equal(p, want) {
			t.Errorf("%s: payload %x, want %x", v.key, p, want)
		}
		if got := encodeStrKey(typ, p); got != v.key {
			t.Errorf("%s: re-encodes to %s", v.key, got)
		}
	}
}

func TestDecodeStrKeySEP23Invalid(t *testing.T) {
	if len(sep23Invalid) != 20 {
		t.Fatalf("%d invalid vectors, SEP-23 v1.4.0 has 20", len(sep23Invalid))
	}
	for _, s := range sep23Invalid {
		if typ, _, err := DecodeStrKey(s); err == nil {
			t.Errorf("%s: accepted as %c, must be rejected", s, typ)
		}
	}
}

func TestDecodeStrKeyRejectsLowerCase(t *testing.T) {
	if _, _, err := DecodeStrKey(strings.ToLower(sep23Valid[0].key)); err == nil {
		t.Fatal("lower-case StrKey accepted; SEP-23 defines upper case only")
	}
}

// Every type round-trips, including the seed type (decoder only; Normalize
// never decodes seeds).
func TestStrKeyAllTypesRoundTrip(t *testing.T) {
	h := bytes.Repeat([]byte{0xAB}, 32)
	payloads := map[StrKeyType][]byte{
		StrKeyAccount: h, StrKeySeed: h, StrKeyPreAuthTx: h, StrKeyHashX: h, StrKeyContract: h,
		StrKeyLiquidityPool: h, StrKeyMuxedAccount: append(bytes.Clone(h), 1, 2, 3, 4, 5, 6, 7, 8),
		StrKeyMuxedContract:    append(bytes.Clone(h), 8, 7, 6, 5, 4, 3, 2, 1),
		StrKeyClaimableBalance: append([]byte{0}, h...),
		StrKeySignedPayload:    append(append(bytes.Clone(h), 0, 0, 0, 1), 0x42, 0, 0, 0),
	}
	if len(payloads) != 10 {
		t.Fatalf("%d types, want 10", len(payloads))
	}
	for typ, p := range payloads {
		s := encodeStrKey(typ, p)
		if s[0] != byte(typ) {
			t.Errorf("%c: encodes with prefix %c", typ, s[0])
		}
		got, gp, err := DecodeStrKey(s)
		if err != nil || got != typ || !bytes.Equal(gp, p) {
			t.Errorf("%c: round trip failed: %v %c %x", typ, err, got, gp)
		}
	}
}

// All 16 signed-payload lengths are accepted by the shape check.
func TestSignedPayloadLengths(t *testing.T) {
	want := []int{69, 76, 82, 88, 95, 101, 108, 114, 120, 127, 133, 140, 146, 152, 159, 165}
	var got []int
	for n, ok := range signedPayloadLengths {
		if ok {
			got = append(got, n)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("lengths %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("lengths %v, want %v", got, want)
		}
	}
}

func TestCRC16XModem(t *testing.T) {
	// CRC-16/XMODEM check value for "123456789".
	if got := crc16XModem([]byte("123456789")); got != 0x31C3 {
		t.Fatalf("crc16 = %#04x, want 0x31c3", got)
	}
}

func FuzzDecodeStrKey(f *testing.F) {
	for _, v := range sep23Valid {
		f.Add(v.key)
	}
	for _, s := range sep23Invalid {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		typ, p, err := DecodeStrKey(s)
		if err != nil {
			return
		}
		if got := encodeStrKey(typ, p); got != s {
			t.Fatalf("accepted %q but it re-encodes to %q", s, got)
		}
	})
}
