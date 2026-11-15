// SPDX-License-Identifier: Apache-2.0

package challenge

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"
)

// The dev bit of the prof byte (wire-formats §b.1, §b.3, C-137).

func issueDev(t *testing.T, dev, strict bool) Issued {
	t.Helper()
	is, err := Issue(IssueParams{Key: key, Now: now, SiteKey: site, Net: net4, UAClass: "chrome/131/windows", Cost: 16, Max: 8, Strict: strict, Dev: dev})
	if err != nil {
		t.Fatal(err)
	}
	return is
}

func verify(is Issued, devBatch bool, ks KeyFunc) Outcome {
	c, _ := Solve(is.Token, is.Cost, is.Max, is.Pfx)
	return Verify(VerifyParams{Token: is.Token, Counter: &c, SiteKey: site, Net: net4, UAClass: "chrome/131/windows",
		Now: now.Add(time.Second), Keys: ks, DevBatch: devBatch})
}

func TestDevBitOnlyOnDevBatches(t *testing.T) {
	for _, strict := range []bool{false, true} {
		dev := issueDev(t, true, strict)
		raw, _ := b64.DecodeString(dev.Token)
		want := byte(0x02)
		if strict {
			want = 0x03
		}
		if raw[59] != want {
			t.Fatalf("prof byte %#x, want %#x", raw[59], want)
		}
		if o := verify(dev, true, keys); o.Reject != "" || !o.ProofOK || !o.Token.Dev || o.Token.Strict != strict {
			t.Fatalf("dev token on a dev batch: %+v", o)
		}
		if o := verify(dev, false, keys); o.Reject != "challenge_invalid" {
			t.Fatalf("dev token on a production batch: %+v", o)
		}
		// Even when this node lacks the epoch key (normally only `challenge_unverifiable`).
		if o := verify(dev, false, func(uint32) []byte { return nil }); o.Reject != "challenge_invalid" {
			t.Fatalf("dev token with an unknown epoch key on a production batch: %+v", o)
		}
		prod := issueDev(t, false, strict)
		if o := verify(prod, true, keys); o.Reject != "" || o.Token.Dev {
			t.Fatalf("production token on a dev batch: %+v", o)
		}
	}
}

func TestUnknownProfBitIsInvalid(t *testing.T) {
	is := issueDev(t, false, false)
	raw, _ := b64.DecodeString(is.Token)
	for _, prof := range []byte{0x04, 0x80, 0x07} {
		raw[59] = prof
		m := hmac.New(sha256.New, key) // a correctly MAC'd token: the bit itself is refused
		m.Write(raw[:60])
		forged := append(append([]byte(nil), raw[:60]...), m.Sum(nil)...)
		tok := base64.RawURLEncoding.EncodeToString(forged)
		for _, devBatch := range []bool{false, true} {
			o := Verify(VerifyParams{Token: tok, SiteKey: site, Net: net4, UAClass: "chrome/131/windows", Now: now, Keys: keys, DevBatch: devBatch})
			if o.Reject != "challenge_invalid" {
				t.Fatalf("prof %#x dev=%v: %+v", prof, devBatch, o)
			}
		}
	}
}
