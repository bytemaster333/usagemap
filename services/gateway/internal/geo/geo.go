// SPDX-License-Identifier: Apache-2.0

// Package geo resolves the country of a visitor from the TRUNCATED address (IPv4 /24, IPv6 /48) with one DB-IP IP to
// Country Lite database (CC BY 4.0, read with maxminddb-golang/v2, ISC). One database serves every lookup; there is
// no per-lookup fallback to another source (S-12, C-106, ADR-0006). No country → "XX".
package geo

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/netip"
	"os"
	"regexp"

	"github.com/oschwald/maxminddb-golang/v2"
)

// DatabaseType is the only accepted database_type (§a.6).
const DatabaseType = "DBIP-Country-Lite"

// Unknown is the country sent when the database has none (§c.2: `cf-ipcountry` is never empty).
const Unknown = "XX"

var isoRe = regexp.MustCompile(`^[A-Z]{2}$`)

// Resolver looks up countries.
type Resolver interface {
	Country(addr netip.Addr) string
}

// DB is a DB-IP Lite country database.
type DB struct {
	r      *maxminddb.Reader
	SHA256 string
	Build  string
}

// Open opens the database, checks its SHA-256 against pin (when pin is not empty) and its database_type.
func Open(path, pin string) (*DB, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	_, err = io.Copy(h, f)
	f.Close()
	if err != nil {
		return nil, err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if pin != "" && sum != pin {
		return nil, fmt.Errorf("geo: database sha256 %s does not match the pin", sum)
	}
	r, err := maxminddb.Open(path)
	if err != nil {
		return nil, err
	}
	if r.Metadata.DatabaseType != DatabaseType {
		r.Close()
		return nil, fmt.Errorf("geo: database_type %q, want %q", r.Metadata.DatabaseType, DatabaseType)
	}
	return &DB{r: r, SHA256: sum, Build: r.Metadata.BuildTime().UTC().Format("2006-01-02")}, nil
}

// Truncate returns the address with host bits cleared: /24 for IPv4 (also IPv4-mapped), /48 for IPv6.
func Truncate(addr netip.Addr) netip.Addr {
	addr = addr.Unmap()
	bits := 48
	if addr.Is4() {
		bits = 24
	}
	p, err := addr.Prefix(bits)
	if err != nil {
		return netip.Addr{}
	}
	return p.Addr()
}

// Country resolves the truncated address. Lookup errors and missing codes give Unknown.
func (d *DB) Country(addr netip.Addr) string {
	t := Truncate(addr)
	if !t.IsValid() {
		return Unknown
	}
	var rec struct {
		Country struct {
			ISOCode string `maxminddb:"iso_code"`
		} `maxminddb:"country"`
	}
	if err := d.r.Lookup(t).Decode(&rec); err != nil || !isoRe.MatchString(rec.Country.ISOCode) {
		return Unknown
	}
	return rec.Country.ISOCode
}

// Close releases the database.
func (d *DB) Close() error { return d.r.Close() }

// None is the resolver used when no database is configured (development only): every lookup is Unknown.
type None struct{}

// Country always returns Unknown.
func (None) Country(netip.Addr) string { return Unknown }
