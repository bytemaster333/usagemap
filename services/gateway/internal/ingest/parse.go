// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
)

// Closed schemas of wire-formats §a.2/§a.3, checked by hand (additionalProperties: false everywhere). A violation
// is `400 malformed`; the only relaxation is the challenge token: a missing or malformed `t` is not a schema error
// but the reject reason `challenge_missing` (§h.2), so a scripted POST without a challenge is answered 202 and
// counted `rejected` like every other well-formed batch (no oracle, C-39).

var (
	errMalformed = errors.New("malformed")
	reSiteKey    = regexp.MustCompile(`^[0-9A-Za-z]{22}$`)
	reVersion    = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	reToken      = regexp.MustCompile(`^[A-Za-z0-9_-]{123}$`)
	reEventID    = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
	reRefHost    = regexp.MustCompile(`^[a-z0-9.-]+$`)
	reLang       = regexp.MustCompile(`^[a-z]{2,3}$`)
	reEventName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`)
	rePropName   = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
)

var (
	walletNames = set("wallet_modal_opened", "wallet_modal_closed", "wallet_selected", "wallet_connected",
		"wallet_session_restored", "wallet_disconnected", "sign_requested", "sign_completed", "sign_failed")
	walletIDs = set("albedo", "varial", "fordefi", "rabet", "xbull", "lobstr", "hana", "klever", "onekey", "bitget",
		"cactuslink", "dcent", "scopuly", "metamask", "ghostsig", "ledger", "trezor", "wallet_connect", "hot_wallet", "other")
	signKinds  = set("tx", "auth_entry", "message", "tx_submit")
	networks   = set("public", "testnet", "futurenet", "other")
	outcomes   = set("connected", "dismissed", "error")
	durations  = set("lt5s", "5_30s", "gt30s")
	errClasses = set("rejected", "timeout", "unsupported", "other")
)

func set(v ...string) map[string]bool {
	m := map[string]bool{}
	for _, x := range v {
		m[x] = true
	}
	return m
}

// ChallengeRequest of §a.2.
type ChallengeRequest struct {
	S, P, TV string
}

// Signals of `sg` (standard profile).
type Signals struct {
	Present bool
	WD      *int
	Vis     string
	Act     *int
}

// Event of §a.3 after validation.
type Event struct {
	ID, K, U string
	// pageview
	R, W, L string
	WK      bool
	// custom and wallet
	N string
	D map[string]any
	// wallet: SV is the Stellar event schema version (0 = legacy ADR-0029, 1 = §a.3.1)
	SV                          int
	WID, SK, Net, Out, Dur, Err string // legacy (and the v1 fields with the same keys)
	WT, CK, EC, RC, PO          string // v1 only
	FR, WC, WS, WM              string // v1 only (tracker 1.2.0)
	// RPC holds the cells of a `stellar_rpc` aggregate (§a.3.2); such an event has no other fields.
	RPC []RPCCell
}

// Batch of §a.3.
type Batch struct {
	S, P, TV   string
	T          string // may be empty or malformed → challenge_missing
	TokenValid bool
	C          *uint32
	SG         Signals
	E          []Event
}

func decodeObject(b []byte) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var m map[string]json.RawMessage
	if err := d.Decode(&m); err != nil || m == nil {
		return nil, errMalformed
	}
	if d.More() {
		return nil, errMalformed
	}
	return m, nil
}

func onlyKeys(m map[string]json.RawMessage, allowed ...string) bool {
	ok := set(allowed...)
	for k := range m {
		if !ok[k] {
			return false
		}
	}
	return true
}

func str(m map[string]json.RawMessage, k string) (string, bool) {
	raw, ok := m[k]
	if !ok {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

func intVal(raw json.RawMessage) (int64, bool) {
	var n json.Number
	if json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}

func checkVersionFields(m map[string]json.RawMessage) (s, p, tv string, err error) {
	v, ok := m["v"]
	if !ok {
		return "", "", "", errMalformed
	}
	if n, ok := intVal(v); !ok || n != 1 {
		return "", "", "", errMalformed
	}
	s, ok1 := str(m, "s")
	p, ok2 := str(m, "p")
	tv, ok3 := str(m, "tv")
	if !ok1 || !ok2 || !ok3 || !reSiteKey.MatchString(s) || (p != "standard" && p != "strict") || !reVersion.MatchString(tv) || len(tv) > 32 {
		return "", "", "", errMalformed
	}
	return s, p, tv, nil
}

// ParseChallenge validates a ChallengeRequest.
func ParseChallenge(b []byte) (ChallengeRequest, error) {
	m, err := decodeObject(b)
	if err != nil || !onlyKeys(m, "v", "s", "p", "tv") {
		return ChallengeRequest{}, errMalformed
	}
	s, p, tv, err := checkVersionFields(m)
	return ChallengeRequest{S: s, P: p, TV: tv}, err
}

// ParseBatch validates an EventBatch.
func ParseBatch(b []byte) (Batch, error) {
	var out Batch
	m, err := decodeObject(b)
	if err != nil || !onlyKeys(m, "v", "s", "p", "tv", "t", "c", "sg", "e") {
		return out, errMalformed
	}
	if out.S, out.P, out.TV, err = checkVersionFields(m); err != nil {
		return out, err
	}
	if raw, ok := m["t"]; ok {
		var t string
		if json.Unmarshal(raw, &t) == nil && reToken.MatchString(t) {
			out.T, out.TokenValid = t, true
		}
	}
	if raw, ok := m["c"]; ok && string(raw) != "null" {
		n, ok := intVal(raw)
		if !ok || n < 0 || n > 524287 {
			return out, errMalformed
		}
		c := uint32(n)
		out.C = &c
	}
	if raw, ok := m["sg"]; ok {
		sg, err := decodeObject(raw)
		if err != nil || !onlyKeys(sg, "wd", "vis", "act") {
			return out, errMalformed
		}
		out.SG.Present = true
		for _, k := range []string{"wd", "act"} {
			if r, ok := sg[k]; ok {
				n, ok := intVal(r)
				if !ok || (n != 0 && n != 1) {
					return out, errMalformed
				}
				v := int(n)
				if k == "wd" {
					out.SG.WD = &v
				} else {
					out.SG.Act = &v
				}
			}
		}
		if _, ok := sg["vis"]; ok {
			vis, ok := str(sg, "vis")
			if !ok || (vis != "v" && vis != "h" && vis != "p") {
				return out, errMalformed
			}
			out.SG.Vis = vis
		}
	}
	rawE, ok := m["e"]
	if !ok {
		return out, errMalformed
	}
	var evs []json.RawMessage
	if json.Unmarshal(rawE, &evs) != nil || len(evs) < 1 || len(evs) > 10 {
		return out, errMalformed
	}
	for _, re := range evs {
		e, err := parseEvent(re)
		if err != nil {
			return out, err
		}
		out.E = append(out.E, e)
	}
	return out, nil
}

func parseEvent(raw json.RawMessage) (Event, error) {
	var e Event
	m, err := decodeObject(raw)
	if err != nil {
		return e, errMalformed
	}
	var ok1, ok2, ok3 bool
	e.ID, ok1 = str(m, "id")
	e.K, ok2 = str(m, "k")
	e.U, ok3 = str(m, "u")
	if !ok1 || !ok2 || !ok3 || !reEventID.MatchString(e.ID) || len(e.U) < 1 || len(e.U) > 500 || e.U[0] != '/' {
		return e, errMalformed
	}
	opt := func(k string, valid func(string) bool) (string, error) {
		if _, present := m[k]; !present {
			return "", nil
		}
		v, ok := str(m, k)
		if !ok || !valid(v) {
			return "", errMalformed
		}
		return v, nil
	}
	in := func(s map[string]bool) func(string) bool { return func(v string) bool { return s[v] } }
	switch e.K {
	case "pv":
		if !onlyKeys(m, "id", "k", "u", "r", "w", "l", "wk") {
			return e, errMalformed
		}
		if e.R, err = opt("r", func(v string) bool { return len(v) <= 253 && reRefHost.MatchString(v) }); err != nil {
			return e, err
		}
		if e.W, err = opt("w", in(set("s", "m", "l", "x"))); err != nil {
			return e, err
		}
		if e.L, err = opt("l", reLang.MatchString); err != nil {
			return e, err
		}
		if raw, ok := m["wk"]; ok {
			if string(raw) != "true" {
				return e, errMalformed
			}
			e.WK = true
		}
	case "ev":
		if !onlyKeys(m, "id", "k", "u", "n", "d") {
			return e, errMalformed
		}
		n, ok := str(m, "n")
		if !ok || len(n) < 1 || len(n) > 50 || !reEventName.MatchString(n) {
			return e, errMalformed
		}
		e.N = n
		if raw, ok := m["d"]; ok {
			d, err := decodeObject(raw)
			if err != nil || len(d) > 10 {
				return e, errMalformed
			}
			e.D = map[string]any{}
			for k, v := range d {
				if !rePropName.MatchString(k) {
					return e, errMalformed
				}
				var s string
				if json.Unmarshal(v, &s) == nil {
					if len([]rune(s)) > 100 {
						return e, errMalformed
					}
					e.D[k] = s
					continue
				}
				switch string(v) {
				case "true":
					e.D[k] = true
					continue
				case "false":
					e.D[k] = false
					continue
				}
				var num json.Number
				if json.Unmarshal(v, &num) != nil {
					return e, errMalformed
				}
				f, err := num.Float64()
				if err != nil || f < -1e15 || f > 1e15 {
					return e, errMalformed
				}
				e.D[k] = num
			}
		}
	case "wl":
		if _, v1 := m["sv"]; v1 {
			return parseStellarV1(m, e, opt)
		}
		if !onlyKeys(m, "id", "k", "u", "n", "wid", "sk", "net", "out", "dur", "err") {
			return e, errMalformed
		}
		n, ok := str(m, "n")
		if !ok || !walletNames[n] {
			return e, errMalformed
		}
		e.N = n
		for _, f := range []struct {
			k   string
			dst *string
			s   map[string]bool
		}{{"wid", &e.WID, walletIDs}, {"sk", &e.SK, signKinds}, {"net", &e.Net, networks}, {"out", &e.Out, outcomes}, {"dur", &e.Dur, durations}, {"err", &e.Err, errClasses}} {
			if *f.dst, err = opt(f.k, in(f.s)); err != nil {
				return e, err
			}
		}
	default:
		return e, errMalformed
	}
	return e, nil
}

// parseStellarV1 validates a `wl` event with `sv` against `$defs/stellar` (§a.3, §a.3.1): `sv` = 1 and closed lists
// for every field; anything else is a schema violation (400).
func parseStellarV1(m map[string]json.RawMessage, e Event, opt func(string, func(string) bool) (string, error)) (Event, error) {
	if !onlyKeys(m, "id", "k", "u", "n", "sv", "wt", "net", "ck", "sk", "ec", "rc", "dur", "out", "po", "fr", "wc", "ws", "wm", "c") {
		return e, errMalformed
	}
	if raw := m["sv"]; len(raw) == 0 || raw[0] == '"' {
		return e, errMalformed // a number, not a string (json.Number would accept "1")
	}
	if sv, ok := intVal(m["sv"]); !ok || sv != 1 {
		return e, errMalformed
	}
	e.SV = 1
	n, ok := str(m, "n")
	if ok && n == AggregateRPC {
		return parseRPCAggregate(m, e)
	}
	if _, has := m["c"]; has || !ok || !stellarNames[n] {
		return e, errMalformed
	}
	e.N = n
	in := func(s map[string]bool) func(string) bool { return func(v string) bool { return s[v] } }
	var err error
	for _, f := range []struct {
		k   string
		dst *string
		s   map[string]bool
	}{{"wt", &e.WT, stellarWallets}, {"net", &e.Net, stellarNetworks}, {"ck", &e.CK, stellarConnect}, {"sk", &e.SK, signKinds},
		{"ec", &e.EC, stellarErrClasses}, {"rc", &e.RC, stellarResults}, {"dur", &e.Dur, durations}, {"out", &e.Out, outcomes},
		{"po", &e.PO, stellarPasskeyOps}, {"fr", &e.FR, stellarFailReasons}, {"wc", &e.WC, stellarContexts},
		{"ws", &e.WS, stellarWCStates}, {"wm", &e.WM, stellarWCMethods}} {
		if *f.dst, err = opt(f.k, in(f.s)); err != nil {
			return e, err
		}
	}
	return e, nil
}
