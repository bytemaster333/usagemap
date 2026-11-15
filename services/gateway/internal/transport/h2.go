// SPDX-License-Identifier: Apache-2.0

package transport

import (
	"encoding/binary"
	"strconv"
	"strings"
)

// Preface is the HTTP/2 client connection preface (RFC 9113 §3.4).
const Preface = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"

// MaxCapture bounds the bytes recorded per connection to find the first HEADERS frame.
const MaxCapture = 16 << 10

// Setting is one SETTINGS parameter as sent.
type Setting struct {
	ID    uint16
	Value uint32
}

// H2 is the reduced HTTP/2 connection preface of one connection (Akamai-style fingerprint parts).
type H2 struct {
	Settings     []Setting // first SETTINGS frame, in order
	WindowUpdate uint32    // connection-level WINDOW_UPDATE increment before the first HEADERS (0 = none)
	Priority     int       // PRIORITY frames before the first HEADERS
	Pseudo       string    // pseudo-header order of the first request, e.g. "masp" (m=:method a=:authority s=:scheme p=:path); "" when undecodable
}

// String renders the Akamai HTTP/2 fingerprint layout `S[;]|WU|P|PS`, e.g. `1:65536;2:0;4:6291456|15663105|0|m,a,s,p`
// (tests and evidence only; never logged by the service).
func (h *H2) String() string {
	s := make([]string, len(h.Settings))
	for i, x := range h.Settings {
		s[i] = strconv.Itoa(int(x.ID)) + ":" + strconv.FormatUint(uint64(x.Value), 10)
	}
	ps := strings.Join(strings.Split(h.Pseudo, ""), ",")
	return strings.Join(s, ";") + "|" + strconv.FormatUint(uint64(h.WindowUpdate), 10) + "|" + strconv.Itoa(h.Priority) + "|" + ps
}

// ParseH2 parses the start of a cleartext HTTP/2 client stream (preface + frames). done is true once the first
// HEADERS frame was seen (or the stream is not HTTP/2, or is malformed): nothing more is needed. ok is false when the
// stream is not an HTTP/2 client stream.
func ParseH2(b []byte) (h H2, done, ok bool) {
	if len(b) < len(Preface) {
		return h, !strings.HasPrefix(Preface, string(b)), strings.HasPrefix(Preface, string(b))
	}
	if string(b[:len(Preface)]) != Preface {
		return h, true, false
	}
	b = b[len(Preface):]
	seenSettings := false
	for len(b) >= 9 {
		n := int(b[0])<<16 | int(b[1])<<8 | int(b[2])
		typ, flags := b[3], b[4]
		stream := binary.BigEndian.Uint32(b[5:9]) & 0x7fffffff
		if len(b) < 9+n {
			return h, false, true
		}
		p := b[9 : 9+n]
		switch typ {
		case 0x4: // SETTINGS
			if flags&0x1 == 0 && !seenSettings && stream == 0 {
				seenSettings = true
				for i := 0; i+6 <= len(p); i += 6 {
					h.Settings = append(h.Settings, Setting{binary.BigEndian.Uint16(p[i:]), binary.BigEndian.Uint32(p[i+2:])})
				}
			}
		case 0x8: // WINDOW_UPDATE
			if stream == 0 && len(p) == 4 && h.WindowUpdate == 0 {
				h.WindowUpdate = binary.BigEndian.Uint32(p) & 0x7fffffff
			}
		case 0x2: // PRIORITY
			h.Priority++
		case 0x1: // HEADERS
			h.Pseudo = pseudoOrder(headerBlock(p, flags))
			return h, true, true
		}
		b = b[9+n:]
	}
	return h, false, true
}

// headerBlock strips padding and the priority fields of a HEADERS frame payload.
func headerBlock(p []byte, flags byte) []byte {
	if flags&0x8 != 0 { // PADDED
		if len(p) < 1 {
			return nil
		}
		pad := int(p[0])
		p = p[1:]
		if pad > len(p) {
			return nil
		}
		p = p[:len(p)-pad]
	}
	if flags&0x20 != 0 { // PRIORITY
		if len(p) < 5 {
			return nil
		}
		p = p[5:]
	}
	return p
}

// hpackInt decodes an HPACK integer with an n-bit prefix (RFC 7541 §5.1).
func hpackInt(b []byte, n uint) (v uint64, rest []byte, ok bool) {
	if len(b) == 0 {
		return 0, nil, false
	}
	mask := byte(1<<n - 1)
	v = uint64(b[0] & mask)
	b = b[1:]
	if v < uint64(mask) {
		return v, b, true
	}
	var m uint
	for i, c := range b {
		v += uint64(c&0x7f) << m
		m += 7
		if c&0x80 == 0 {
			return v, b[i+1:], true
		}
		if m > 28 {
			return 0, nil, false
		}
	}
	return 0, nil, false
}

// hpackString skips a string literal and returns it (raw; Huffman-coded strings are returned with huff = true).
func hpackString(b []byte) (s []byte, huff bool, rest []byte, ok bool) {
	if len(b) == 0 {
		return nil, false, nil, false
	}
	huff = b[0]&0x80 != 0
	n, b, ok := hpackInt(b, 7)
	if !ok || uint64(len(b)) < n {
		return nil, false, nil, false
	}
	return b[:n], huff, b[n:], true
}

// staticPseudo maps the HPACK static table entries 1–7 to their pseudo-header letter.
func staticPseudo(i uint64) byte {
	switch i {
	case 1:
		return 'a'
	case 2, 3:
		return 'm'
	case 4, 5:
		return 'p'
	case 6, 7:
		return 's'
	}
	return 0
}

var literalPseudo = map[string]byte{":authority": 'a', ":method": 'm', ":path": 'p', ":scheme": 's', ":protocol": 'r'}

// pseudoOrder reads the leading pseudo-header fields of the first header block. The first request on a connection
// starts with an empty dynamic table, so pseudo-header names are static-table references or literal names. Returns ""
// when a name cannot be read (e.g. a Huffman-coded literal name).
func pseudoOrder(b []byte) string {
	var out []byte
	for len(b) > 0 {
		c := b[0]
		var name uint64
		var ok bool
		switch {
		case c&0x80 != 0: // indexed field
			name, b, ok = hpackInt(b, 7)
			if !ok {
				return ""
			}
			l := staticPseudo(name)
			if l == 0 {
				return string(out)
			}
			out = append(out, l)
			if len(out) == 4 {
				return string(out)
			}
			continue
		case c&0xe0 == 0x20: // dynamic table size update
			if _, b, ok = hpackInt(b, 5); !ok {
				return ""
			}
			continue
		case c&0xc0 == 0x40: // literal with incremental indexing
			name, b, ok = hpackInt(b, 6)
		default: // literal without indexing / never indexed (4-bit prefix)
			name, b, ok = hpackInt(b, 4)
		}
		if !ok {
			return ""
		}
		var l byte
		if name == 0 {
			var s []byte
			var huff bool
			if s, huff, b, ok = hpackString(b); !ok || huff {
				return ""
			}
			l = literalPseudo[string(s)]
		} else {
			l = staticPseudo(name)
		}
		if l == 0 { // first regular header: the pseudo-header section is over
			return string(out)
		}
		if _, _, b, ok = hpackString(b); !ok { // value
			return ""
		}
		out = append(out, l)
		if len(out) == 4 { // :method, :scheme, :authority and :path all seen (a request has no other pseudo-headers)
			return string(out)
		}
	}
	return string(out)
}
