// SPDX-License-Identifier: Apache-2.0
package main

import (
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"regexp"
	"strings"
)

// Secrets never come from argv (visible in `ps` and shell history): only from
// an environment variable or a file. They are never printed, not even in part.
const (
	envIngestToken = "USAGEMAP_INGEST_TOKEN"
	envShareKey    = "USAGEMAP_SHARE_KEY"
)

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var (
	reKey     = regexp.MustCompile(`^scfa_(op|ing|pub)_([0-9A-Za-z]{12})_([0-9A-Za-z]{27})([0-9A-Za-z]{6})$`)
	reSiteKey = regexp.MustCompile(`^[0-9A-Za-z]{22}$`)
)

// keyChecksum is the 6-character base62 CRC-32 (IEEE) of
// "scfa_<kind>_<id>_<secret>" (wire-formats §k; gateway internal/otlp/key.go).
func keyChecksum(kind, id, secret string) string {
	v := uint64(crc32.ChecksumIEEE([]byte("scfa_" + kind + "_" + id + "_" + secret)))
	b := []byte("000000")
	for i := 5; i >= 0 && v > 0; i-- {
		b[i] = base62[v%62]
		v /= 62
	}
	return string(b)
}

// checkKey validates grammar, kind and CRC offline, exactly as the gateway
// does before any lookup. Errors never contain the key.
func checkKey(k, kind string) error {
	m := reKey.FindStringSubmatch(k)
	if m == nil {
		return fmt.Errorf("not a UsageMap scfa_%s_… key (wrong length or characters)", kind)
	}
	if m[1] != kind {
		return fmt.Errorf("this is an scfa_%s_… key; an scfa_%s_… key is needed here", m[1], kind)
	}
	if keyChecksum(m[1], m[2], m[3]) != m[4] {
		return errors.New("the key's checksum is wrong: it was mistyped or truncated when copied")
	}
	return nil
}

// readSecret returns the secret from file (when given) or the environment
// variable; "" when neither is set.
func readSecret(file, env string) (string, error) {
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("reading the key file: %w", err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	return strings.TrimSpace(os.Getenv(env)), nil
}
