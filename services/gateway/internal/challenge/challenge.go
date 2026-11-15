// SPDX-License-Identifier: Apache-2.0

// Package challenge implements the challenge token and the PBKDF2 proof-of-work of wire-formats §b.1–§b.3. It is
// stateless: any node holding the hourly key K_chal[kep] verifies any token.
package challenge

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
	"net/netip"
	"time"
)

const (
	// TokenLen is the binary token length; its b64u form is 123 characters.
	TokenLen = 92
	// TTL is how long a token is accepted (§b.3).
	TTL = 1800 * time.Second
	// FutureSkew is how far in the future issued_ms may be.
	FutureSkew = 60 * time.Second
	version    = 0x01

	// prof byte bits (§b.1): bit 0 strict, bit 1 issued to a dev request (C-137). Any other bit is invalid.
	profStrict = 0x01
	profDev    = 0x02
	profKnown  = profStrict | profDev
)

var b64 = base64.RawURLEncoding

// KeyFunc returns K_chal for an hour epoch, or nil if this node does not hold it.
type KeyFunc func(epoch uint32) []byte

// Epoch is the key epoch of t: floor(unix seconds / 3600).
func Epoch(t time.Time) uint32 { return uint32(t.Unix() / 3600) }

// SiteRef is the first 16 bytes of SHA-256(site key).
func SiteRef(siteKey string) [16]byte {
	h := sha256.Sum256([]byte(siteKey))
	var r [16]byte
	copy(r[:], h[:16])
	return r
}

// Net returns the truncated network of addr: /24 (4 bytes, last 0) for IPv4, /48 (16 bytes) for IPv6.
func Net(addr netip.Addr) []byte {
	addr = addr.Unmap()
	if addr.Is4() {
		p, _ := addr.Prefix(24)
		b := p.Addr().As4()
		return b[:]
	}
	p, _ := addr.Prefix(48)
	b := p.Addr().As16()
	return b[:]
}

// Ctx is the first 8 bytes of HMAC-SHA-256(K_chal, "ctx1" ‖ net ‖ 0x00 ‖ ua_class).
func Ctx(key, net []byte, uaClass string) [8]byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte("ctx1"))
	m.Write(net)
	m.Write([]byte{0})
	m.Write([]byte(uaClass))
	var c [8]byte
	copy(c[:], m.Sum(nil))
	return c
}

// DK is dk(c) = PBKDF2-HMAC-SHA-256("scf-pow-v1" ‖ nonce ‖ uint32be(c), salt = nonce, cost, 32) (§b.2).
func DK(nonce []byte, c uint32, cost int) []byte {
	pw := make([]byte, 0, 10+len(nonce)+4)
	pw = append(pw, "scf-pow-v1"...)
	pw = append(pw, nonce...)
	pw = binary.BigEndian.AppendUint32(pw, c)
	k, err := pbkdf2.Key(sha256.New, string(pw), nonce, cost, 32)
	if err != nil {
		panic(err) // only for invalid parameters, which callers never pass
	}
	return k
}

// Token is a decoded challenge token.
type Token struct {
	Epoch    uint32
	SiteRef  [16]byte
	IssuedMs int64
	Nonce    [16]byte
	Ctx      [8]byte
	Cost     uint16
	Max      uint16
	Pfx      [4]byte
	Strict   bool
	// Dev: issued to a dev request (§a.8); valid only on dev batches (C-137).
	Dev bool
}

func (t *Token) body() []byte {
	b := make([]byte, 0, TokenLen)
	b = append(b, version)
	b = binary.BigEndian.AppendUint32(b, t.Epoch)
	b = append(b, t.SiteRef[:]...)
	var ms [8]byte
	binary.BigEndian.PutUint64(ms[:], uint64(t.IssuedMs))
	b = append(b, ms[2:]...) // uint48
	b = append(b, t.Nonce[:]...)
	b = append(b, t.Ctx[:]...)
	b = binary.BigEndian.AppendUint16(b, t.Cost)
	b = binary.BigEndian.AppendUint16(b, t.Max)
	b = append(b, t.Pfx[:]...)
	var prof byte
	if t.Strict {
		prof |= profStrict
	}
	if t.Dev {
		prof |= profDev
	}
	return append(b, prof)
}

// Issued is a new challenge (§a.2 response fields).
type Issued struct {
	Token string
	Cost  int
	Max   int
	Pfx   string // 8 hex characters
	TTL   int
}

// IssueParams are the inputs of Issue.
type IssueParams struct {
	Key     []byte // K_chal[Epoch(Now)]
	Now     time.Time
	SiteKey string
	Net     []byte
	UAClass string
	Cost    int // pow_cost, ≥ 1
	Max     int // pow_max × multiplier, 1…65535
	Strict  bool
	// Dev sets the dev bit (§b.1, C-137): the request came from a dev origin of the site.
	Dev bool
}

// Issue creates a token: draws the secret counter c* in [0, max) and publishes pfx = dk(c*)[0..4].
func Issue(p IssueParams) (Issued, error) {
	if p.Cost < 1 || p.Cost > 65535 || p.Max < 1 || p.Max > 65535 || len(p.Key) != 32 {
		return Issued{}, errors.New("challenge: bad parameters")
	}
	t := Token{
		Epoch:    Epoch(p.Now),
		SiteRef:  SiteRef(p.SiteKey),
		IssuedMs: p.Now.UnixMilli(),
		Ctx:      Ctx(p.Key, p.Net, p.UAClass),
		Cost:     uint16(p.Cost),
		Max:      uint16(p.Max),
		Strict:   p.Strict,
		Dev:      p.Dev,
	}
	if _, err := rand.Read(t.Nonce[:]); err != nil {
		return Issued{}, err
	}
	cs, err := rand.Int(rand.Reader, big.NewInt(int64(p.Max)))
	if err != nil {
		return Issued{}, err
	}
	copy(t.Pfx[:], DK(t.Nonce[:], uint32(cs.Int64()), p.Cost)[:4])
	body := t.body()
	m := hmac.New(sha256.New, p.Key)
	m.Write(body)
	raw := append(body, m.Sum(nil)...)
	return Issued{Token: b64.EncodeToString(raw), Cost: p.Cost, Max: p.Max, Pfx: hex.EncodeToString(t.Pfx[:]), TTL: int(TTL / time.Second)}, nil
}

// Outcome of a verification: the reasons it adds (closed list of wire-formats §h.2) and, when the token is usable,
// its contents.
type Outcome struct {
	Token        *Token
	Reject       string // "", challenge_missing, challenge_invalid, challenge_expired, proof_invalid
	Unverifiable bool   // suspect/challenge_unverifiable: epoch key unknown on this node
	CtxMoved     bool   // suspect/ctx_moved
	ProofMissing bool   // suspect/proof_missing
	ProofOK      bool
}

// VerifyParams are the inputs of Verify.
type VerifyParams struct {
	Token   string
	Counter *uint32 // nil = no proof
	SiteKey string
	Net     []byte
	UAClass string
	Now     time.Time
	Keys    KeyFunc
	// KeySince returns when this node generated the epoch's key itself (zero when the key was adopted from a peer or
	// is unknown). A token whose MAC fails and that claims to be issued before that moment was signed with a key this
	// node never had — the previous key of a restarted single node, or another partition's — so it is
	// `challenge_unverifiable` (suspect), like an unknown epoch key, not `challenge_invalid` (C-68, C-124).
	KeySince func(epoch uint32) time.Time
	// DevBatch: the batch comes from a dev origin of the site (§a.8). A dev-issued token is valid only then (C-137).
	DevBatch bool
}

// Verify checks a token and its proof per §b.3, in the table's order. The per-nonce event cap is the caller's
// (it needs node-local state).
func Verify(p VerifyParams) Outcome {
	raw, err := b64.DecodeString(p.Token)
	if err != nil || len(raw) != TokenLen || len(p.Token) != 123 || raw[0] != version {
		return Outcome{Reject: "challenge_missing"}
	}
	var t Token
	t.Epoch = binary.BigEndian.Uint32(raw[1:5])
	copy(t.SiteRef[:], raw[5:21])
	var ms [8]byte
	copy(ms[2:], raw[21:27])
	t.IssuedMs = int64(binary.BigEndian.Uint64(ms[:]))
	copy(t.Nonce[:], raw[27:43])
	copy(t.Ctx[:], raw[43:51])
	t.Cost = binary.BigEndian.Uint16(raw[51:53])
	t.Max = binary.BigEndian.Uint16(raw[53:55])
	copy(t.Pfx[:], raw[55:59])
	prof := raw[59]
	t.Strict, t.Dev = prof&profStrict != 0, prof&profDev != 0
	if prof&^profKnown != 0 {
		return Outcome{Reject: "challenge_invalid"} // an unknown prof bit (§b.3)
	}
	// A dev-issued token on a production batch is invalid whatever else holds (C-137): even a token whose epoch key
	// this node lacks cannot buy a counted event with a dev bit.
	devMisuse := t.Dev && !p.DevBatch
	// A genuine token carries the epoch of its own issue time, and that epoch is one whose tokens can still be inside
	// the TTL now (the previous or current hour, or the next within the future skew). Anything else was made up by the
	// client: it is never "unverifiable", whatever key this node holds.
	plausible := Epoch(time.UnixMilli(t.IssuedMs)) == t.Epoch &&
		t.Epoch >= Epoch(p.Now.Add(-TTL)) && t.Epoch <= Epoch(p.Now.Add(FutureSkew))
	key := p.Keys(t.Epoch)
	if key == nil {
		if !plausible {
			return Outcome{Reject: "challenge_invalid"}
		}
		// Epoch key unknown on this node (restart, partition): suspect, never rejected (C-68). Nothing in the token
		// can be trusted, so no proof check either; the age check still applies to the claimed issue time.
		if devMisuse {
			return Outcome{Reject: "challenge_invalid"}
		}
		o := Outcome{Unverifiable: true, Token: &t}
		if !ageOK(t.IssuedMs, p.Now) {
			o.Reject = "challenge_expired"
		}
		return o
	}
	m := hmac.New(sha256.New, key)
	m.Write(raw[:60])
	if !hmac.Equal(m.Sum(nil), raw[60:]) {
		if p.KeySince != nil {
			if since := p.KeySince(t.Epoch); plausible && !since.IsZero() && t.IssuedMs < since.UnixMilli() && !devMisuse {
				o := Outcome{Unverifiable: true, Token: &t}
				if !ageOK(t.IssuedMs, p.Now) {
					o.Reject = "challenge_expired"
				}
				return o
			}
		}
		return Outcome{Reject: "challenge_invalid"}
	}
	if ref := SiteRef(p.SiteKey); !hmac.Equal(ref[:], t.SiteRef[:]) {
		return Outcome{Reject: "challenge_invalid"}
	}
	if t.Cost == 0 || t.Max == 0 || devMisuse {
		return Outcome{Reject: "challenge_invalid"}
	}
	o := Outcome{Token: &t}
	if !ageOK(t.IssuedMs, p.Now) {
		o.Reject = "challenge_expired"
		return o
	}
	if c := Ctx(key, p.Net, p.UAClass); !hmac.Equal(c[:], t.Ctx[:]) {
		o.CtxMoved = true
	}
	if p.Counter == nil {
		o.ProofMissing = true
		return o
	}
	if *p.Counter >= uint32(t.Max) || !hmac.Equal(DK(t.Nonce[:], *p.Counter, int(t.Cost))[:4], t.Pfx[:]) {
		o.Reject = "proof_invalid"
		return o
	}
	o.ProofOK = true
	return o
}

func ageOK(issuedMs int64, now time.Time) bool {
	n := now.UnixMilli()
	return n-issuedMs <= TTL.Milliseconds() && issuedMs <= n+FutureSkew.Milliseconds()
}

// Solve searches the counter for a challenge (used by the probe client and tests; the tracker does the same in
// WebCrypto). It returns false when no counter in [0, max) matches.
func Solve(token string, cost, max int, pfxHex string) (uint32, bool) {
	raw, err := b64.DecodeString(token)
	if err != nil || len(raw) != TokenLen {
		return 0, false
	}
	pfx, err := hex.DecodeString(pfxHex)
	if err != nil || len(pfx) != 4 {
		return 0, false
	}
	nonce := raw[27:43]
	for c := 0; c < max; c++ {
		if hmac.Equal(DK(nonce, uint32(c), cost)[:4], pfx) {
			return uint32(c), true
		}
	}
	return 0, false
}
