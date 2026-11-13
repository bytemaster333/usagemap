// SPDX-License-Identifier: Apache-2.0
package pathnorm

import "errors"

// StrKeyType is one of the ten SEP-23 v1.4.0 StrKey types, identified by the
// first character of its encoding.
type StrKeyType byte

// The ten StrKey types of SEP-23 v1.4.0.
const (
	StrKeyAccount          StrKeyType = 'G' // ed25519 public key
	StrKeySeed             StrKeyType = 'S' // ed25519 secret seed — never decoded by Normalize
	StrKeyMuxedAccount     StrKeyType = 'M' // CAP-27
	StrKeyPreAuthTx        StrKeyType = 'T'
	StrKeyHashX            StrKeyType = 'X'
	StrKeySignedPayload    StrKeyType = 'P' // CAP-40
	StrKeyContract         StrKeyType = 'C'
	StrKeyLiquidityPool    StrKeyType = 'L'
	StrKeyClaimableBalance StrKeyType = 'B'
	StrKeyMuxedContract    StrKeyType = 'W' // CAP-84
)

// versionByte maps each type to its SEP-23 version byte (type << 3 | alg, alg = 0).
var versionByte = [...]struct {
	t StrKeyType
	v byte
}{
	{StrKeyAccount, 6 << 3},
	{StrKeySeed, 18 << 3},
	{StrKeyMuxedAccount, 12 << 3},
	{StrKeyPreAuthTx, 19 << 3},
	{StrKeyHashX, 23 << 3},
	{StrKeySignedPayload, 15 << 3},
	{StrKeyContract, 2 << 3},
	{StrKeyLiquidityPool, 11 << 3},
	{StrKeyClaimableBalance, 1 << 3},
	{StrKeyMuxedContract, 22 << 3},
}

// ErrInvalidStrKey is returned by DecodeStrKey for anything that is not a
// strictly valid SEP-23 StrKey.
var ErrInvalidStrKey = errors.New("pathnorm: invalid strkey")

const b32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

// b32Value maps an upper-case RFC 4648 base32 character to its value, or -1.
var b32Value = func() (t [256]int8) {
	for i := range t {
		t[i] = -1
	}
	for i := 0; i < len(b32Alphabet); i++ {
		t[b32Alphabet[i]] = int8(i)
	}
	return t
}()

// crc16XModem is CRC-16/XMODEM (polynomial 0x1021, init 0), as used by SEP-23.
func crc16XModem(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc ^= uint16(b) << 8
		for range 8 {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// DecodeStrKey strictly decodes a SEP-23 v1.4.0 StrKey (upper case only, as
// SEP-23 defines no lower-case form). It enforces every strict-validity rule
// of the specification: no padding, length not ≡ 1, 3 or 6 (mod 8), zero
// unused trailing bits, CRC16-XModem checksum (little-endian), a known version
// byte with zero algorithm bits, the payload length of the type, claimable
// balance type V0, and the signed-payload length prefix and zero padding.
//
// It returns the type and the payload (without version byte and checksum).
// Normalize never calls it on a secret-seed shape: seeds are redacted on shape
// alone.
func DecodeStrKey(s string) (StrKeyType, []byte, error) {
	t, p, ok := decodeInto(s, make([]byte, 0, len(s)*5/8))
	if !ok {
		return 0, nil, ErrInvalidStrKey
	}
	return t, p, nil
}

// decodeInto decodes s into raw (appending), so callers can use a stack
// buffer. The returned payload aliases raw.
func decodeInto[S string | []byte](s S, raw []byte) (StrKeyType, []byte, bool) {
	n := len(s)
	if n < 5 {
		return 0, nil, false
	}
	switch n % 8 {
	case 1, 3, 6:
		return 0, nil, false
	}
	var acc uint32
	bits := 0
	for i := 0; i < n; i++ {
		v := b32Value[s[i]]
		if v < 0 {
			return 0, nil, false
		}
		acc = acc<<5 | uint32(v)
		bits += 5
		if bits >= 8 {
			bits -= 8
			raw = append(raw, byte(acc>>uint(bits)))
		}
	}
	// Unused trailing bits must be zero (equivalent to the re-encode check).
	if bits > 0 && acc&(1<<uint(bits)-1) != 0 {
		return 0, nil, false
	}
	if len(raw) < 3 {
		return 0, nil, false
	}
	body, chk := raw[:len(raw)-2], raw[len(raw)-2:]
	crc := crc16XModem(body)
	if chk[0] != byte(crc) || chk[1] != byte(crc>>8) {
		return 0, nil, false
	}
	var typ StrKeyType
	for _, vb := range versionByte {
		if vb.v == body[0] {
			typ = vb.t
			break
		}
	}
	if typ == 0 {
		return 0, nil, false
	}
	p := body[1:]
	switch typ {
	case StrKeyAccount, StrKeySeed, StrKeyPreAuthTx, StrKeyHashX, StrKeyContract, StrKeyLiquidityPool:
		if len(p) != 32 {
			return 0, nil, false
		}
	case StrKeyMuxedAccount, StrKeyMuxedContract:
		if len(p) != 40 {
			return 0, nil, false
		}
	case StrKeyClaimableBalance:
		if len(p) != 33 || p[0] != 0 {
			return 0, nil, false
		}
	case StrKeySignedPayload:
		if len(p) < 32+4+4 || len(p) > 32+4+64 {
			return 0, nil, false
		}
		l := int(p[32])<<24 | int(p[33])<<16 | int(p[34])<<8 | int(p[35])
		if l < 1 || l > 64 {
			return 0, nil, false
		}
		pad := (4 - l%4) % 4
		if len(p) != 36+l+pad {
			return 0, nil, false
		}
		for _, b := range p[36+l:] {
			if b != 0 {
				return 0, nil, false
			}
		}
	}
	return typ, p, true
}

// encodeStrKey encodes payload as a StrKey of type t. It is used by the tests
// to derive test-only keys at run time, so that no seed-shaped value is ever
// stored in a file.
func encodeStrKey(t StrKeyType, payload []byte) string {
	var ver byte
	for _, vb := range versionByte {
		if vb.t == t {
			ver = vb.v
		}
	}
	body := make([]byte, 0, len(payload)+3)
	body = append(body, ver)
	body = append(body, payload...)
	crc := crc16XModem(body)
	body = append(body, byte(crc), byte(crc>>8))
	out := make([]byte, 0, (len(body)*8+4)/5)
	var acc uint32
	bits := 0
	for _, b := range body {
		acc = acc<<8 | uint32(b)
		bits += 8
		for bits >= 5 {
			bits -= 5
			out = append(out, b32Alphabet[acc>>uint(bits)&31])
		}
	}
	if bits > 0 {
		out = append(out, b32Alphabet[acc<<uint(5-bits)&31])
	}
	return string(out)
}

// signedPayloadLengths are the 16 encoded lengths a signed-payload StrKey can
// have (inner payload 1..64 bytes, padded to a multiple of 4).
var signedPayloadLengths = func() (m [166]bool) {
	for p := 4; p <= 64; p += 4 {
		bytes := 1 + 32 + 4 + p + 2
		m[(bytes*8+4)/5] = true
	}
	return m
}()
