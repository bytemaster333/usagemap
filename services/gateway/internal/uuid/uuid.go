// SPDX-License-Identifier: Apache-2.0

// Package uuid generates RFC 9562 UUIDs (version 7 for record ids, version 4 for boot ids) and parses UUID text.
package uuid

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"time"
)

// UUID is 16 bytes.
type UUID [16]byte

// V7 returns a time-ordered UUID for t.
func V7(t time.Time) UUID {
	var u UUID
	_, _ = rand.Read(u[:])
	ms := uint64(t.UnixMilli())
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], ms)
	copy(u[0:6], b[2:8])
	u[6] = 0x70 | u[6]&0x0f
	u[8] = 0x80 | u[8]&0x3f
	return u
}

// V4 returns a random UUID.
func V4() UUID {
	var u UUID
	_, _ = rand.Read(u[:])
	u[6] = 0x40 | u[6]&0x0f
	u[8] = 0x80 | u[8]&0x3f
	return u
}

// String is the canonical 8-4-4-4-12 form.
func (u UUID) String() string {
	var b [36]byte
	hex.Encode(b[0:8], u[0:4])
	b[8] = '-'
	hex.Encode(b[9:13], u[4:6])
	b[13] = '-'
	hex.Encode(b[14:18], u[6:8])
	b[18] = '-'
	hex.Encode(b[19:23], u[8:10])
	b[23] = '-'
	hex.Encode(b[24:], u[10:])
	return string(b[:])
}

// Parse parses the canonical text form (any case).
func Parse(s string) (UUID, error) {
	var u UUID
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return u, errors.New("uuid: malformed")
	}
	h := s[0:8] + s[9:13] + s[14:18] + s[19:23] + s[24:]
	if _, err := hex.Decode(u[:], []byte(h)); err != nil {
		return u, errors.New("uuid: malformed")
	}
	return u, nil
}
