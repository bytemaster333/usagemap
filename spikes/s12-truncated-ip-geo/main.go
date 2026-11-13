// SPDX-License-Identifier: Apache-2.0
// S-12: how often does truncating an address (IPv4 /24, IPv6 /48) change its country, per database, and how
// often do DB-IP Lite and sapics user-country disagree?  Addresses are synthetic: drawn at random inside routed
// ranges from iptoasn (PDDL); no address of a real visitor is involved.
//
// usage: go run . -iptoasn ip2asn-combined.tsv.gz -dbip dbip-country-lite.mmdb -uc user-country.mmdb -n 1000000
package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"math/rand/v2"
	"net/netip"
	"os"
	"strings"

	"github.com/oschwald/maxminddb-golang/v2"
)

type rng struct{ lo, hi netip.Addr }

type rec struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
}

func loadRanges(path string) (v4, v6 []rng) {
	f, err := os.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		log.Fatal(err)
	}
	sc := bufio.NewScanner(gz)
	for sc.Scan() {
		c := strings.Split(sc.Text(), "\t")
		if len(c) < 3 || c[2] == "0" { // AS 0 = "Not routed"
			continue
		}
		lo, e1 := netip.ParseAddr(c[0])
		hi, e2 := netip.ParseAddr(c[1])
		if e1 != nil || e2 != nil {
			continue
		}
		if lo.Is4() {
			v4 = append(v4, rng{lo, hi})
		} else {
			v6 = append(v6, rng{lo, hi})
		}
	}
	return
}

func toInt(a netip.Addr) *big.Int { b := a.As16(); return new(big.Int).SetBytes(b[:]) }

func fromInt(x *big.Int, v4 bool) netip.Addr {
	var b [16]byte
	x.FillBytes(b[:])
	a := netip.AddrFrom16(b)
	if v4 {
		return a.Unmap()
	}
	return a
}

// randomIn draws an address uniformly in [lo, hi].
func randomIn(r *rand.Rand, g rng) netip.Addr {
	lo, hi := toInt(g.lo), toInt(g.hi)
	span := new(big.Int).Sub(hi, lo)
	span.Add(span, big.NewInt(1))
	// uniform big int below span from 128 random bits (bias negligible for this purpose)
	x := new(big.Int).Lsh(new(big.Int).SetUint64(r.Uint64()), 64)
	x.Or(x, new(big.Int).SetUint64(r.Uint64()))
	x.Mod(x, span)
	return fromInt(x.Add(x, lo), g.lo.Is4())
}

func truncate(a netip.Addr) netip.Addr {
	bits := 48
	if a.Is4() {
		bits = 24
	}
	p, _ := a.Prefix(bits)
	return p.Addr()
}

type db struct {
	name string
	r    *maxminddb.Reader
}

func (d db) cc(a netip.Addr) string {
	var v rec
	if err := d.r.Lookup(a).Decode(&v); err != nil {
		log.Fatal(err)
	}
	return v.Country.ISOCode
}

type perDB struct {
	UnknownFull   int `json:"unknown_full"`
	UnknownTrunc  int `json:"unknown_trunc"`
	Changed       int `json:"changed_any"`        // country(trunc) != country(full), unknown counted as a value
	ChangedKnown  int `json:"changed_both_known"` // both known and different
	BecameUnknown int `json:"full_known_trunc_unknown"`
}

type cross struct {
	DisagreeFullKnown  int `json:"disagree_full_both_known"`
	DisagreeTruncKnown int `json:"disagree_trunc_both_known"`
	BothKnownFull      int `json:"both_known_full"`
	BothKnownTrunc     int `json:"both_known_trunc"`
	DisagreeFullAny    int `json:"disagree_full_any"`
	DisagreeTruncAny   int `json:"disagree_trunc_any"`
}

type result struct {
	Sample string            `json:"sample"`
	N      int               `json:"n"`
	PerDB  map[string]*perDB `json:"per_db"`
	Cross  cross             `json:"dbip_vs_usercountry"`
	// country pairs most often involved in a truncation change (DB-IP)
	TopChangesDBIP map[string]int `json:"top_changes_dbip,omitempty"`
}

func run(name string, n int, draw func() netip.Addr, dbs []db) *result {
	res := &result{Sample: name, N: n, PerDB: map[string]*perDB{}, TopChangesDBIP: map[string]int{}}
	for _, d := range dbs {
		res.PerDB[d.name] = &perDB{}
	}
	for i := 0; i < n; i++ {
		full := draw()
		tr := truncate(full)
		var f, t [2]string
		for k, d := range dbs {
			f[k], t[k] = d.cc(full), d.cc(tr)
			s := res.PerDB[d.name]
			if f[k] == "" {
				s.UnknownFull++
			}
			if t[k] == "" {
				s.UnknownTrunc++
			}
			if f[k] != t[k] {
				s.Changed++
				if f[k] != "" && t[k] != "" {
					s.ChangedKnown++
				}
				if f[k] != "" && t[k] == "" {
					s.BecameUnknown++
				}
				if k == 0 {
					res.TopChangesDBIP[f[k]+"->"+t[k]]++
				}
			}
		}
		c := &res.Cross
		if f[0] != f[1] {
			c.DisagreeFullAny++
		}
		if t[0] != t[1] {
			c.DisagreeTruncAny++
		}
		if f[0] != "" && f[1] != "" {
			c.BothKnownFull++
			if f[0] != f[1] {
				c.DisagreeFullKnown++
			}
		}
		if t[0] != "" && t[1] != "" {
			c.BothKnownTrunc++
			if t[0] != t[1] {
				c.DisagreeTruncKnown++
			}
		}
	}
	// keep only the 10 most frequent change pairs
	type kv struct {
		k string
		v int
	}
	var all []kv
	for k, v := range res.TopChangesDBIP {
		all = append(all, kv{k, v})
	}
	for i := range all { // tiny selection sort, fine for this size
		for j := i + 1; j < len(all); j++ {
			if all[j].v > all[i].v {
				all[i], all[j] = all[j], all[i]
			}
		}
	}
	res.TopChangesDBIP = map[string]int{}
	for i := 0; i < len(all) && i < 10; i++ {
		res.TopChangesDBIP[all[i].k] = all[i].v
	}
	return res
}

func main() {
	ipt := flag.String("iptoasn", "", "ip2asn-combined.tsv.gz")
	dbipPath := flag.String("dbip", "", "DB-IP Lite country mmdb")
	ucPath := flag.String("uc", "", "sapics user-country mmdb")
	n := flag.Int("n", 1000000, "samples per run")
	seed := flag.Uint64("seed", 20261112, "PRNG seed")
	flag.Parse()

	var dbs []db
	for _, p := range []struct{ n, p string }{{"dbip-lite", *dbipPath}, {"user-country", *ucPath}} {
		r, err := maxminddb.Open(p.p)
		if err != nil {
			log.Fatal(err)
		}
		defer r.Close()
		m := r.Metadata
		fmt.Fprintf(os.Stderr, "%s: type=%s build=%d ipv=%d nodes=%d desc=%v\n", p.n, m.DatabaseType, m.BuildEpoch, m.IPVersion, m.NodeCount, m.Description)
		dbs = append(dbs, db{p.n, r})
	}
	v4, v6 := loadRanges(*ipt)
	fmt.Fprintf(os.Stderr, "iptoasn routed ranges: v4=%d v6=%d\n", len(v4), len(v6))
	r := rand.New(rand.NewPCG(*seed, 1))

	// cumulative IPv4 sizes for address-weighted sampling
	cum := make([]uint64, len(v4))
	var tot uint64
	for i, g := range v4 {
		a, b := g.lo.As4(), g.hi.As4()
		lo := uint64(a[0])<<24 | uint64(a[1])<<16 | uint64(a[2])<<8 | uint64(a[3])
		hi := uint64(b[0])<<24 | uint64(b[1])<<16 | uint64(b[2])<<8 | uint64(b[3])
		tot += hi - lo + 1
		cum[i] = tot
	}
	addrWeighted4 := func() netip.Addr {
		x := r.Uint64N(tot)
		lo, hi := 0, len(cum)-1
		for lo < hi {
			m := (lo + hi) / 2
			if cum[m] > x {
				hi = m
			} else {
				lo = m + 1
			}
		}
		base := uint64(0)
		if lo > 0 {
			base = cum[lo-1]
		}
		a := v4[lo].lo.As4()
		v := uint64(a[0])<<24 | uint64(a[1])<<16 | uint64(a[2])<<8 | uint64(a[3]) + (x - base)
		return netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)})
	}
	out := []*result{
		run("ipv4_range_weighted", *n, func() netip.Addr { return randomIn(r, v4[r.IntN(len(v4))]) }, dbs),
		run("ipv4_address_weighted", *n, addrWeighted4, dbs),
		run("ipv6_range_weighted", *n, func() netip.Addr { return randomIn(r, v6[r.IntN(len(v6))]) }, dbs),
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	if err := enc.Encode(map[string]any{"routed_v4_addresses": tot, "routed_v4_ranges": len(v4), "routed_v6_ranges": len(v6), "seed": *seed, "results": out}); err != nil {
		log.Fatal(err)
	}
}
