// SPDX-License-Identifier: Apache-2.0

package otlp

import (
	"encoding/base64"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

var rePepper = regexp.MustCompile(`^([1-9][0-9]{0,4}):([A-Za-z0-9+/_=-]+)$`)

// ParsePeppers reads the pepper_ing set in the control plane's format (`<version>:<base64 of ≥ 32 bytes>`,
// comma-separated; SCF_PEPPER_ING, C-81). Every version still referenced by a token must be present.
func ParsePeppers(v string) (map[int][]byte, error) {
	out := map[int][]byte{}
	for _, part := range strings.Split(strings.TrimSpace(v), ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		m := rePepper.FindStringSubmatch(part)
		if m == nil {
			return nil, errors.New("pepper set must be `<version>:<base64>`, comma-separated")
		}
		raw := m[2]
		var key []byte
		var err error
		if strings.ContainsAny(raw, "-_") {
			key, err = base64.RawURLEncoding.DecodeString(strings.TrimRight(raw, "="))
		} else {
			key, err = base64.StdEncoding.DecodeString(raw)
			if err != nil {
				key, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(raw, "="))
			}
		}
		ver, _ := strconv.Atoi(m[1])
		if err != nil || len(key) < 32 || ver > 32767 {
			return nil, errors.New("pepper must be base64 of at least 32 bytes")
		}
		out[ver] = key
	}
	if len(out) == 0 {
		return nil, errors.New("empty pepper set")
	}
	return out, nil
}
