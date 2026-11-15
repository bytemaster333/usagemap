// SPDX-License-Identifier: Apache-2.0

package transport

import (
	"encoding/binary"
	"testing"
)

func frame(typ, flags byte, stream uint32, p []byte) []byte {
	b := make([]byte, 9, 9+len(p))
	b[0], b[1], b[2] = byte(len(p)>>16), byte(len(p)>>8), byte(len(p))
	b[3], b[4] = typ, flags
	binary.BigEndian.PutUint32(b[5:], stream)
	return append(b, p...)
}

func settings(kv ...uint32) []byte {
	var p []byte
	for i := 0; i+1 < len(kv); i += 2 {
		p = binary.BigEndian.AppendUint16(p, uint16(kv[i]))
		p = binary.BigEndian.AppendUint32(p, kv[i+1])
	}
	return frame(0x4, 0, 0, p)
}

// Chrome-like preface: SETTINGS, WINDOW_UPDATE, HEADERS with priority flag; :method POST (static 3),
// :authority literal-with-indexing (name index 1), :scheme https (7), :path literal (name index 4).
func chromePreface() []byte {
	b := []byte(Preface)
	b = append(b, settings(1, 65536, 2, 0, 4, 6291456, 6, 262144)...)
	b = append(b, frame(0x8, 0, 0, []byte{0x00, 0xef, 0x00, 0x01})...)
	hb := []byte{0x83, 0x41, 0x03, 'a', '.', 'b', 0x87, 0x44, 0x05, '/', 'v', '1', '/', 'e', 0x7f, 0x00}
	hdr := append([]byte{0x80, 0, 0, 0, 0xff}, hb...) // exclusive dependency on 0, weight 256
	return append(b, frame(0x1, 0x4|0x1|0x20, 1, hdr)...)
}

func TestParseH2Chrome(t *testing.T) {
	b := chromePreface()
	h, done, ok := ParseH2(b)
	if !done || !ok {
		t.Fatalf("done=%v ok=%v", done, ok)
	}
	if got, want := h.String(), "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p"; got != want {
		t.Fatalf("fingerprint %s, want %s", got, want)
	}
	// Byte by byte: never done early, the same result at the end.
	st := &State{}
	for i := range b {
		st.record(b[i : i+1])
	}
	if s := st.Snapshot(); s.H2 == nil || s.H2.String() != h.String() {
		t.Fatalf("incremental parse differs: %+v", s.H2)
	}
}

func TestParseH2Variants(t *testing.T) {
	// Firefox-like: PRIORITY frames, literal never-indexed :path with literal name (non-Huffman), padded HEADERS.
	b := []byte(Preface)
	b = append(b, settings(1, 65536, 2, 0, 4, 131072, 5, 16384)...)
	b = append(b, frame(0x8, 0, 0, []byte{0x00, 0xbe, 0x00, 0x01})...)
	b = append(b, frame(0x2, 0, 3, []byte{0, 0, 0, 0, 200})...)
	hb := []byte{0x83, 0x10, 0x05, ':', 'p', 'a', 't', 'h', 0x01, '/', 0x41, 0x01, 'x', 0x87, 0x7f, 0x00}
	p := append([]byte{2}, hb...)
	p = append(p, 0, 0)
	b = append(b, frame(0x1, 0x8|0x4, 1, p)...)
	h, done, ok := ParseH2(b)
	if !done || !ok || h.Pseudo != "mpas" || h.Priority != 1 || h.WindowUpdate != 12451841 {
		t.Fatalf("got %+v done=%v ok=%v", h, done, ok)
	}

	if _, done, ok := ParseH2([]byte("GET / HTTP/1.1\r\n")); !done || ok {
		t.Fatal("HTTP/1.1 must be done and not ok")
	}
	if _, done, ok := ParseH2([]byte("PRI * HT")); done || !ok {
		t.Fatal("partial preface must wait")
	}
	// Huffman-coded literal pseudo name → order unknown, but parsing completes.
	hb = []byte{0x83, 0x00, 0x85, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, '/'}
	h, done, ok = ParseH2(append([]byte(Preface), frame(0x1, 0x4, 1, hb)...))
	if !done || !ok || h.Pseudo != "" {
		t.Fatalf("huffman name: %+v", h)
	}
	// Truncated header block → "".
	h, _, _ = ParseH2(append([]byte(Preface), frame(0x1, 0x4, 1, []byte{0x83, 0x41, 0x7f})...))
	if h.Pseudo != "" {
		t.Fatalf("truncated block: %q", h.Pseudo)
	}
}

func TestCaptureBounded(t *testing.T) {
	st := &State{}
	b := []byte(Preface)
	for len(b) < MaxCapture+100 {
		b = append(b, frame(0x0, 0, 1, make([]byte, 1000))...) // DATA frames only, no HEADERS
	}
	st.record(b)
	s := st.Snapshot()
	if s.H2 != nil || !st.h2Done || st.capture != nil {
		t.Fatalf("capture not bounded: done=%v len=%d", st.h2Done, len(st.capture))
	}
}
