// SPDX-License-Identifier: Apache-2.0

package probe

import (
	"bytes"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/challenge"
)

// TestSolveMatchesGateway: the probe's solver finds the counter the gateway's issuer hid.
func TestSolveMatchesGateway(t *testing.T) {
	key := bytes.Repeat([]byte{3}, 32)
	is, err := challenge.Issue(challenge.IssueParams{Key: key, Now: time.Now(), SiteKey: "Q4mZ8bS1pTn0aR7cLx2VwE", Net: []byte{1, 2, 3, 0}, UAClass: "chrome/131/windows", Cost: 256, Max: 64})
	if err != nil {
		t.Fatal(err)
	}
	c, ok := Solve(is.Token, is.Cost, is.Max, is.Pfx)
	if !ok {
		t.Fatal("not solved")
	}
	o := challenge.Verify(challenge.VerifyParams{Token: is.Token, Counter: &c, SiteKey: "Q4mZ8bS1pTn0aR7cLx2VwE", Net: []byte{1, 2, 3, 0}, UAClass: "chrome/131/windows", Now: time.Now(),
		Keys: func(uint32) []byte { return key }})
	if !o.ProofOK {
		t.Fatalf("%+v", o)
	}
}
