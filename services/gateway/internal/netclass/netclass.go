// SPDX-License-Identifier: Apache-2.0

// Package netclass classifies a client address into the network classes of data-model §8.9 (`asn_class`) from the
// range lists the range-list updater keeps in a local volume (C-38): `<dir>/<class>.txt`, one CIDR or address per
// line. The lists are not in any image; with no lists every address is `unknown` (the gateway starts anyway).
// Lookups use the full address in memory; nothing is stored.
package netclass

import (
	"bufio"
	"io/fs"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Classes in priority order (a range on two lists gets the first class here).
var Classes = []string{"tor", "relay", "vpn", "datacenter", "eyeball_mobile", "eyeball_fixed"}

// Unknown is the class of an address on no list.
const Unknown = "unknown"

// LowersThresholds reports whether a class lowers the multiplicity thresholds / raises the PoW difficulty (C-38).
func LowersThresholds(class string) bool {
	return class == "datacenter" || class == "tor" || class == "vpn"
}

type interval struct{ lo, hi netip.Addr }

type table struct {
	byClass map[string][]interval // sorted, merged, per family mixed (Addr.Compare orders v4 before v6)
	counts  map[string]int
}

func (t *table) lookup(a netip.Addr) string {
	for _, c := range Classes {
		iv := t.byClass[c]
		i := sort.Search(len(iv), func(i int) bool { return iv[i].hi.Compare(a) >= 0 })
		if i < len(iv) && iv[i].lo.Compare(a) <= 0 {
			return c
		}
	}
	return Unknown
}

// lastAddr is the last address of a prefix.
func lastAddr(p netip.Prefix) netip.Addr {
	a := p.Masked().Addr()
	b := a.AsSlice()
	bits := p.Bits()
	for i := range b {
		for j := 0; j < 8; j++ {
			if i*8+j >= bits {
				b[i] |= 0x80 >> j
			}
		}
	}
	r, _ := netip.AddrFromSlice(b)
	return r
}

func merge(iv []interval) []interval {
	sort.Slice(iv, func(i, j int) bool { return iv[i].lo.Compare(iv[j].lo) < 0 })
	var out []interval
	for _, x := range iv {
		if n := len(out); n > 0 && out[n-1].lo.Is4() == x.lo.Is4() && (x.lo.Compare(out[n-1].hi) <= 0 || out[n-1].hi.Next() == x.lo) {
			if x.hi.Compare(out[n-1].hi) > 0 {
				out[n-1].hi = x.hi
			}
			continue
		}
		out = append(out, x)
	}
	return out
}

// ParseLine parses one list line: CIDR, address, or comment/blank (ok=false).
func ParseLine(line string) (netip.Prefix, bool) {
	line = strings.TrimSpace(line)
	if i := strings.IndexAny(line, "#;"); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	if line == "" {
		return netip.Prefix{}, false
	}
	if p, err := netip.ParsePrefix(line); err == nil {
		return netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-unmapBits(p.Addr())).Masked(), true
	}
	if a, err := netip.ParseAddr(line); err == nil {
		a = a.Unmap()
		return netip.PrefixFrom(a, a.BitLen()), true
	}
	return netip.Prefix{}, false
}

func unmapBits(a netip.Addr) int {
	if a.Is4In6() {
		return 96
	}
	return 0
}

func load(dir string) (*table, error) {
	t := &table{byClass: map[string][]interval{}, counts: map[string]int{}}
	for _, c := range Classes {
		f, err := os.Open(filepath.Join(dir, c+".txt"))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		var iv []interval
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64<<10), 64<<10)
		for sc.Scan() {
			if p, ok := ParseLine(sc.Text()); ok {
				iv = append(iv, interval{p.Masked().Addr(), lastAddr(p)})
			}
		}
		err = sc.Err()
		f.Close()
		if err != nil {
			return nil, err
		}
		t.byClass[c] = merge(iv)
		t.counts[c] = len(iv)
	}
	return t, nil
}

// Classifier holds the current lists and reloads them when the files change.
type Classifier struct {
	dir    string
	cur    atomic.Pointer[table]
	mu     sync.Mutex
	modSig string
	Loaded atomic.Int64 // unix seconds of the last load
}

// New loads dir (missing dir or files → empty lists).
func New(dir string) *Classifier {
	c := &Classifier{dir: dir}
	c.cur.Store(&table{byClass: map[string][]interval{}, counts: map[string]int{}})
	_ = c.Reload()
	return c
}

func (c *Classifier) signature() string {
	var b strings.Builder
	for _, cl := range Classes {
		if fi, err := os.Stat(filepath.Join(c.dir, cl+".txt")); err == nil {
			b.WriteString(cl + fi.ModTime().String() + "|")
		}
	}
	return b.String()
}

// Reload re-reads the lists when their modification times changed. A failed read keeps the previous lists.
func (c *Classifier) Reload() error {
	if c.dir == "" {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	sig := c.signature()
	if sig == c.modSig {
		return nil
	}
	t, err := load(c.dir)
	if err != nil {
		if _, ok := err.(*fs.PathError); ok {
			return err
		}
		return err
	}
	c.cur.Store(t)
	c.modSig = sig
	c.Loaded.Store(time.Now().Unix())
	return nil
}

// Class of an address.
func (c *Classifier) Class(a netip.Addr) string { return c.cur.Load().lookup(a.Unmap()) }

// Counts returns the number of entries per class (metrics).
func (c *Classifier) Counts() map[string]int { return c.cur.Load().counts }

// Watch reloads every interval until stop is closed.
func (c *Classifier) Watch(stop <-chan struct{}, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			_ = c.Reload()
		}
	}
}
