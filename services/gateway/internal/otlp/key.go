// SPDX-License-Identifier: Apache-2.0

package otlp

import (
	"hash/crc32"
	"regexp"
)

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var reIngestKey = regexp.MustCompile(`^scfa_ing_([0-9A-Za-z]{12})_([0-9A-Za-z]{27})([0-9A-Za-z]{6})$`)

// checksum is the 6-character base62 CRC-32 (IEEE) of "scfa_ing_<id>_<secret>" (wire-formats §k).
func checksum(id, secret string) string {
	v := uint64(crc32.ChecksumIEEE([]byte("scfa_ing_" + id + "_" + secret)))
	b := []byte("000000")
	for i := 5; i >= 0 && v > 0; i-- {
		b[i] = base62[v%62]
		v /= 62
	}
	return string(b)
}

// ParseIngestKey checks the grammar and the CRC offline. It returns the public id and the secret.
func ParseIngestKey(k string) (id, secret string, ok bool) {
	m := reIngestKey.FindStringSubmatch(k)
	if m == nil || checksum(m[1], m[2]) != m[3] {
		return "", "", false
	}
	return m[1], m[2], true
}

// MakeIngestKey builds a key string (tests and tools).
func MakeIngestKey(id, secret string) string {
	return "scfa_ing_" + id + "_" + secret + checksum(id, secret)
}
