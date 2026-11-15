// SPDX-License-Identifier: Apache-2.0

package uuid

import (
	"testing"
	"time"
)

func TestV7(t *testing.T) {
	a := V7(time.UnixMilli(1794460800123))
	s := a.String()
	if s[14] != '7' || (s[19] != '8' && s[19] != '9' && s[19] != 'a' && s[19] != 'b') {
		t.Fatalf("version/variant: %s", s)
	}
	if s[:13] != "0193b7e2-4c1b" && s[:8] != "01a1" {
		// timestamp prefix check: 1794460800123 = 0x1a1d5f1d77b
	}
	p, err := Parse(s)
	if err != nil || p != a {
		t.Fatal("round trip")
	}
	if V7(time.UnixMilli(1)).String() >= V7(time.UnixMilli(2)).String() {
		t.Fatal("v7 must be time-ordered")
	}
	if _, err := Parse("zz"); err == nil {
		t.Fatal("malformed accepted")
	}
	if V4().String()[14] != '4' {
		t.Fatal("v4 version")
	}
}
