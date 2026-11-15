// SPDX-License-Identifier: Apache-2.0

// Package spool is the gateway's local, append-only, fsync'd queue (wire-formats §d, ADR-0020, C-76, C-77):
// segment files `spool/<node_id>/<segment:016d>.seg` of frames `uint32 LE length ‖ uint32 LE CRC-32C ‖ JSON`,
// sealed at 16 MiB or 60 s, with acknowledgements in `<segment>.ack` bitmaps. A record is appended with a group
// commit and the caller learns about it only after fsync, so `202` is never sent before a record is durable. Spool
// accounting (fsync'd = acknowledged + expired + queued) is kept per process and reported in counter records.
package spool

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// Errors returned by Append.
var (
	ErrUnavailable = errors.New("spool: not durable") // → 503
	ErrFull        = errors.New("spool: size cap reached")
	ErrSiteFull    = errors.New("spool: the site's share of the spool is used up") // → 503 for that site only
	ErrClosed      = errors.New("spool: closed")
)

// MaxRecord bounds one frame's payload.
const MaxRecord = 1 << 20

// Outcome of an acknowledgement.
type Outcome int

const (
	OutStored         Outcome = iota // 200 with any body other than {"beep":"boop"}
	OutEngineBot                     // 200 {"beep":"boop"} (Umami's bot drop)
	OutEngineRejected                // 400 from the engine proxy / Umami
	OutExpired                       // 72-hour rule
	OutCounter                       // counter record delivered (or discarded); not part of event accounting
)

// Position names a record: segment sequence number and frame index.
type Position struct {
	Seg uint64
	Idx int
}

// Less orders positions.
func (p Position) Less(q Position) bool { return p.Seg < q.Seg || p.Seg == q.Seg && p.Idx < q.Idx }

// Start is before every position.
var Start = Position{Seg: 0, Idx: -1}

type frame struct {
	off   int64
	n     uint32
	event bool
	bad   bool   // unreadable frame kept in place so the ack bitmap's indexes stay aligned (counted, never sent)
	site  uint32 // interned site id of an event record (0 = none)
	recv  int64
}

type segment struct {
	seq     uint64
	path    string
	ackPath string
	f       *os.File // write handle, active segment only
	ackF    *os.File
	size    int64
	frames  []frame
	acked   []byte
	nAcked  int
	sealed  bool
	created time.Time
	// first is a cursor: every frame before it is acknowledged (frames are appended in receipt order, so the first
	// unacknowledged frame of a segment carries its oldest pending receipt time).
	first int
}

func (g *segment) advance() {
	for g.first < len(g.frames) && g.isAcked(g.first) {
		g.first++
	}
}

func (g *segment) isAcked(i int) bool { return i/8 < len(g.acked) && g.acked[i/8]&(1<<(i%8)) != 0 }

// Options configure a spool.
type Options struct {
	Dir             string // the node's directory: <spool>/<node_id>
	Node            string
	SegmentMaxBytes int64         // 16 MiB
	SegmentMaxAge   time.Duration // 60 s
	Expiry          time.Duration // 72 h
	MaxBytes        int64         // cap on the spool's size on disk (0 = none) → ErrFull
	// SiteShare caps the bytes of unacknowledged event records of one site (0 = none) → ErrSiteFull, so one site
	// flooding a node while Umami is down cannot fill the spool for every other site.
	SiteShare int64
	Now       func() time.Time
	// Sync is the fsync used for segments and ack files (tests inject failures).
	Sync func(*os.File) error
}

// Counts is the event-record accounting (§d.4). Counter records are not counted.
type Counts struct {
	Fsynced, AckedStored, AckedEngineBot, AckedEngineRejected, Expired72h int64
}

// Spool is one node's spool.
type Spool struct {
	o        Options
	mu       sync.Mutex
	segs     []*segment // ordered; the last one is active
	reqs     chan *appendReq
	acks     chan *ackReq
	notify   chan struct{}
	closed   chan struct{}
	wg       sync.WaitGroup
	totals   Counts // since start
	reported Counts // already taken into counter records
	queued   int64  // unacked, unexpired event records
	bytes    int64
	corrupt  int64 // unreadable frames (or unreadable regions) found by recovery
	lostB    int64 // bytes of those frames/regions
	pending  int64 // unacknowledged records of any type (maintained incrementally)
	siteIDs  map[string]uint32
	siteB    map[uint32]int64 // bytes of unacknowledged event records per site
	retryAt  atomic.Int64
	durable  atomic.Bool
	isClosed atomic.Bool
	closeMu  sync.RWMutex // Append/Ack enqueue under RLock; Close flips isClosed under Lock
	commitNs atomic.Int64 // moving average of a group commit's write+fsync time (commit barrier delay)
}

func (s *Spool) siteIndex(id string) uint32 {
	if id == "" {
		return 0
	}
	if i, ok := s.siteIDs[id]; ok {
		return i
	}
	i := uint32(len(s.siteIDs) + 1)
	s.siteIDs[id] = i
	return i
}

type appendReq struct {
	recs []Record
	done chan error
	err  error
}

type ackReq struct {
	pos  Position
	out  Outcome
	done chan error
	err  error
}

func (o *Options) defaults() {
	if o.SegmentMaxBytes <= 0 {
		o.SegmentMaxBytes = 16 << 20
	}
	if o.SegmentMaxAge <= 0 {
		o.SegmentMaxAge = 60 * time.Second
	}
	if o.Expiry <= 0 {
		o.Expiry = 72 * time.Hour
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Sync == nil {
		o.Sync = func(f *os.File) error { return f.Sync() }
	}
}

// Open recovers the spool directory and starts the writer and ack goroutines.
func Open(o Options) (*Spool, error) {
	o.defaults()
	if err := os.MkdirAll(o.Dir, 0o700); err != nil {
		return nil, err
	}
	s := &Spool{o: o, reqs: make(chan *appendReq, 1024), acks: make(chan *ackReq, 1024), notify: make(chan struct{}, 1), closed: make(chan struct{}),
		siteIDs: map[string]uint32{}, siteB: map[uint32]int64{}}
	if err := s.recover(); err != nil {
		return nil, err
	}
	if err := s.newActive(); err != nil {
		return nil, err
	}
	s.durable.Store(true)
	s.wg.Add(2)
	go s.writer()
	go s.acker()
	return s, nil
}

func segName(seq uint64) string { return fmt.Sprintf("%016d.seg", seq) }

func (s *Spool) recover() error {
	ents, err := os.ReadDir(s.o.Dir)
	if err != nil {
		return err
	}
	var seqs []uint64
	for _, e := range ents {
		name := e.Name()
		if strings.HasSuffix(name, ".seg") {
			n, err := strconv.ParseUint(strings.TrimSuffix(name, ".seg"), 10, 64)
			if err == nil {
				seqs = append(seqs, n)
			}
		}
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	for i, seq := range seqs {
		g, err := s.load(seq, i == len(seqs)-1)
		if err != nil {
			return err
		}
		if g.nAcked == len(g.frames) {
			s.removeFiles(g)
			continue
		}
		s.segs = append(s.segs, g)
	}
	// Remove ack files whose segment is gone.
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".seg.ack") {
			if _, err := os.Stat(filepath.Join(s.o.Dir, strings.TrimSuffix(e.Name(), ".ack"))); os.IsNotExist(err) {
				_ = os.Remove(filepath.Join(s.o.Dir, e.Name()))
			}
		}
	}
	return syncDir(s.o.Dir)
}

// load reads one segment, validating every frame.
//
//   - A bad frame whose length field is plausible and is followed by a valid frame (or ends exactly at the end of a
//     sealed segment) is kept as an unreadable placeholder: its index stays, so the ack bitmap stays aligned; it counts
//     as acknowledged (never sent) and as one corrupt frame.
//   - A bad frame with an unusable length is skipped to the next frame that validates (length, CRC, JSON); the frames
//     after it may be re-indexed, so their acknowledgements are unknown: they are marked unacknowledged and the ack
//     file is rewritten (they are delivered again; the engine proxy drops repeats by event key, §c.5). Counted as one
//     corrupt region with its byte size.
//   - Only the newest segment can hold a torn write (the only one written to when the process stopped): bytes after
//     its last valid frame that no valid frame follows are truncated, as before. A sealed segment is never truncated.
func (s *Spool) load(seq uint64, newest bool) (*segment, error) {
	path := filepath.Join(s.o.Dir, segName(seq))
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	g := &segment{seq: seq, path: path, ackPath: path + ".ack", sealed: true}
	size := int64(len(data))
	var off int64
	resyncAt := -1 // index of the first frame whose ack bit is unknown
	tail := false
	for off < size {
		if fr, next, ok := s.parseFrame(data, off); ok {
			g.frames = append(g.frames, fr)
			off = next
			continue
		}
		if off+8 <= size {
			n := int64(binary.LittleEndian.Uint32(data[off : off+4]))
			next := off + 8 + n
			if n > 0 && n <= MaxRecord && next <= size {
				_, _, nextOK := s.parseFrame(data, next)
				if nextOK || (next == size && !newest) {
					g.frames = append(g.frames, frame{off: off, n: uint32(n), bad: true})
					s.corrupt++
					s.lostB += next - off
					off = next
					continue
				}
			}
		}
		nv := s.findNext(data, off+1)
		if nv < 0 {
			tail = true
			break
		}
		s.corrupt++
		s.lostB += nv - off
		if resyncAt < 0 {
			resyncAt = len(g.frames)
		}
		off = nv
	}
	g.size = size
	if tail {
		s.corrupt++
		if newest {
			// A torn write: never fsync'd, so no caller was told it is durable. Cut it off.
			f, err := os.OpenFile(path, os.O_RDWR, 0)
			if err != nil {
				return nil, err
			}
			err = f.Truncate(off)
			if err == nil {
				err = s.o.Sync(f)
			}
			f.Close()
			if err != nil {
				return nil, err
			}
			g.size = off
		} else {
			s.lostB += size - off
		}
	}
	s.bytes += g.size
	if b, err := os.ReadFile(g.ackPath); err == nil {
		g.acked = b
	}
	need := (len(g.frames) + 7) / 8
	if len(g.acked) < need {
		g.acked = append(g.acked, make([]byte, need-len(g.acked))...)
	}
	g.acked = g.acked[:need]
	if resyncAt >= 0 {
		for i := resyncAt; i < len(g.frames); i++ {
			g.acked[i/8] &^= 1 << (i % 8)
		}
	}
	for i, fr := range g.frames {
		if fr.bad {
			g.acked[i/8] |= 1 << (i % 8)
		}
	}
	if resyncAt >= 0 {
		if err := writeFileSync(g.ackPath, g.acked, s.o.Sync); err != nil {
			return nil, err
		}
	}
	for i, fr := range g.frames {
		if g.isAcked(i) {
			g.nAcked++
			continue
		}
		s.pending++
		if fr.event {
			s.queued++
			s.siteB[fr.site] += 8 + int64(fr.n)
		}
	}
	g.advance()
	if fi, err := os.Stat(path); err == nil {
		g.created = fi.ModTime()
	}
	return g, nil
}

// parseFrame validates the frame at off: length, CRC-32C and a JSON payload of a known type.
func (s *Spool) parseFrame(data []byte, off int64) (frame, int64, bool) {
	size := int64(len(data))
	if off+8 > size {
		return frame{}, 0, false
	}
	n := int64(binary.LittleEndian.Uint32(data[off : off+4]))
	if n == 0 || n > MaxRecord || off+8+n > size {
		return frame{}, 0, false
	}
	payload := data[off+8 : off+8+n]
	if payload[0] != '{' || crc32.Checksum(payload, castagnoli) != binary.LittleEndian.Uint32(data[off+4:off+8]) {
		return frame{}, 0, false
	}
	var h header
	if err := json.Unmarshal(payload, &h); err != nil || (h.Type != "event" && h.Type != "counter") {
		return frame{}, 0, false
	}
	fr := frame{off: off, n: uint32(n), event: h.Type == "event", recv: h.ReceivedAtMs}
	if fr.event {
		fr.site = s.siteIndex(h.SiteID)
	} else {
		fr.recv = h.PeriodEndMs
	}
	return fr, off + 8 + n, true
}

// findNext returns the offset of the next valid frame at or after from, or -1.
func (s *Spool) findNext(data []byte, from int64) int64 {
	for i := from; i+9 <= int64(len(data)); i++ {
		if data[i+8] != '{' {
			continue
		}
		if _, _, ok := s.parseFrame(data, i); ok {
			return i
		}
	}
	return -1
}

func writeFileSync(path string, b []byte, sync func(*os.File) error) error {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(b); err != nil {
		return err
	}
	return sync(f)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s *Spool) lastSeq() uint64 {
	if len(s.segs) == 0 {
		return 0
	}
	return s.segs[len(s.segs)-1].seq
}

// newActive seals the current active segment (if any) and creates the next one. Caller holds s.mu or is Open.
func (s *Spool) newActive() error {
	seq := s.lastSeq() + 1
	if n := len(s.segs); n > 0 {
		a := s.segs[n-1]
		if !a.sealed {
			a.sealed = true
			if a.f != nil {
				a.f.Close()
				a.f = nil
			}
			if len(a.frames) == 0 {
				// An empty segment carries nothing: remove it instead of keeping it around.
				s.segs = s.segs[:n-1]
				s.removeFiles(a)
				seq = a.seq
			}
		}
	}
	path := filepath.Join(s.o.Dir, segName(seq))
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := syncDir(s.o.Dir); err != nil {
		f.Close()
		return err
	}
	s.segs = append(s.segs, &segment{seq: seq, path: path, ackPath: path + ".ack", f: f, created: s.o.Now()})
	return nil
}

func (s *Spool) removeFiles(g *segment) {
	if g.f != nil {
		g.f.Close()
		g.f = nil
	}
	if g.ackF != nil {
		g.ackF.Close()
		g.ackF = nil
	}
	_ = os.Remove(g.ackPath)
	_ = os.Remove(g.path)
	s.bytes -= g.size
}

// Append writes the records with one group commit and returns after fsync. Event records get node_id, segment and
// offset. On error nothing of this call is durable or acknowledged (the caller answers 503).
//
// With no records it is a commit barrier: it joins the next group commit (and fails like it when the spool is not
// durable), and when that commit carried no data it waits about as long as a data commit takes, so a request whose
// events were all rejected or dropped is answered like an accepted one.
func (s *Spool) Append(ctx context.Context, recs []Record) error {
	start := time.Now()
	req := &appendReq{recs: recs, done: make(chan error, 1)}
	s.closeMu.RLock()
	if s.isClosed.Load() {
		s.closeMu.RUnlock()
		return ErrClosed
	}
	select {
	case s.reqs <- req:
	case <-ctx.Done():
		s.closeMu.RUnlock()
		return ctx.Err()
	}
	s.closeMu.RUnlock()
	// Once enqueued, the writer (or Close's drain) always answers, so wait only for that answer: a batch the writer
	// fsync'd is never reported as failed.
	err := <-req.done
	if len(recs) == 0 && err == nil {
		if pad := time.Duration(s.commitNs.Load()) - time.Since(start); pad > 0 {
			t := time.NewTimer(min(pad, 250*time.Millisecond))
			select {
			case <-t.C:
			case <-ctx.Done():
				t.Stop()
			}
		}
	}
	return err
}

func (s *Spool) writer() {
	defer s.wg.Done()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-s.closed:
			for {
				select {
				case r := <-s.reqs:
					r.done <- ErrClosed
				default:
					return
				}
			}
		case <-tick.C:
			s.mu.Lock()
			if a := s.segs[len(s.segs)-1]; len(a.frames) > 0 && s.o.Now().Sub(a.created) >= s.o.SegmentMaxAge {
				_ = s.newActive()
			}
			s.mu.Unlock()
		case r := <-s.reqs:
			batch := []*appendReq{r}
		drain:
			for len(batch) < 512 {
				select {
				case r2 := <-s.reqs:
					batch = append(batch, r2)
				default:
					break drain
				}
			}
			s.writeBatch(batch)
			for _, b := range batch {
				b.done <- b.err
			}
		}
	}
}

// writeBatch writes one group commit. Each request gets its own result in err: a request over the size cap or over
// its site's share is refused alone; a write or fsync failure fails every request of the commit.
func (s *Spool) writeBatch(batch []*appendReq) {
	now := s.o.Now()
	failAll := func(err error) {
		for _, b := range batch {
			if b.err == nil {
				b.err = err
			}
		}
	}
	if !s.durable.Load() && now.UnixMilli() < s.retryAt.Load() {
		failAll(ErrUnavailable)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.segs[len(s.segs)-1]
	if len(a.frames) > 0 && (a.size >= s.o.SegmentMaxBytes || now.Sub(a.created) >= s.o.SegmentMaxAge) {
		if err := s.newActive(); err != nil {
			s.fail(now)
			failAll(ErrUnavailable)
			return
		}
		a = s.segs[len(s.segs)-1]
	}
	var buf []byte
	var frames []frame
	var accepted []*appendReq
	batchSite := map[uint32]int64{}
	for _, b := range batch {
		var rbuf []byte
		var rframes []frame
		rsite := map[uint32]int64{}
		for _, rec := range b.recs {
			off := a.size + int64(len(buf)) + int64(len(rbuf))
			data, err := rec.marshal(s.o.Node, a.seq, off)
			if err != nil || len(data) > MaxRecord {
				b.err = fmt.Errorf("spool: record not encodable")
				break
			}
			var hdr [8]byte
			binary.LittleEndian.PutUint32(hdr[0:4], uint32(len(data)))
			binary.LittleEndian.PutUint32(hdr[4:8], crc32.Checksum(data, castagnoli))
			rbuf = append(rbuf, hdr[:]...)
			rbuf = append(rbuf, data...)
			fr := frame{off: off, n: uint32(len(data)), event: rec.isEvent(), recv: rec.receivedAtMs()}
			if fr.event {
				fr.site = s.siteIndex(rec.site())
				rsite[fr.site] += 8 + int64(len(data))
			}
			rframes = append(rframes, fr)
		}
		if b.err != nil {
			continue
		}
		if s.o.MaxBytes > 0 && s.bytes+int64(len(buf))+int64(len(rbuf)) > s.o.MaxBytes {
			b.err = ErrFull
			continue
		}
		if s.o.SiteShare > 0 {
			for site, n := range rsite {
				if site != 0 && s.siteB[site]+batchSite[site]+n > s.o.SiteShare {
					b.err = ErrSiteFull
				}
			}
			if b.err != nil {
				continue
			}
		}
		for site, n := range rsite {
			batchSite[site] += n
		}
		buf = append(buf, rbuf...)
		frames = append(frames, rframes...)
		accepted = append(accepted, b)
	}
	if len(accepted) == 0 {
		return
	}
	setAll := func(err error) {
		for _, b := range accepted {
			b.err = err
		}
	}
	if len(buf) == 0 {
		// Commit barriers only: confirm the spool is still writable.
		if err := s.o.Sync(a.f); err != nil {
			_ = s.newActive()
			s.fail(now)
			setAll(ErrUnavailable)
		}
		return
	}
	started := time.Now()
	if _, err := a.f.WriteAt(buf, a.size); err != nil {
		_ = a.f.Truncate(a.size)
		s.fail(now)
		setAll(ErrUnavailable)
		return
	}
	if err := s.o.Sync(a.f); err != nil {
		// The state of the written bytes is unknown after a failed fsync: cut them off, seal the segment and refuse
		// for a while (503); nothing of this batch was acknowledged to a client.
		_ = a.f.Truncate(a.size)
		_ = s.newActive()
		s.fail(now)
		setAll(ErrUnavailable)
		return
	}
	took := time.Since(started).Nanoseconds()
	if prev := s.commitNs.Load(); prev == 0 {
		s.commitNs.Store(took)
	} else {
		s.commitNs.Store(prev - prev/8 + took/8)
	}
	events := int64(0)
	for _, fr := range frames {
		if fr.event {
			events++
		}
	}
	a.size += int64(len(buf))
	s.bytes += int64(len(buf))
	a.frames = append(a.frames, frames...)
	need := (len(a.frames) + 7) / 8
	if len(a.acked) < need {
		a.acked = append(a.acked, make([]byte, need-len(a.acked))...)
	}
	for site, n := range batchSite {
		s.siteB[site] += n
	}
	s.pending += int64(len(frames))
	s.totals.Fsynced += events
	s.queued += events
	s.durable.Store(true)
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

func (s *Spool) fail(now time.Time) {
	s.durable.Store(false)
	s.retryAt.Store(now.Add(5 * time.Second).UnixMilli())
}

// Durable reports whether the last write succeeded (healthz, 503 decisions).
func (s *Spool) Durable() bool { return s.durable.Load() }

// Notify signals new records.
func (s *Spool) Notify() <-chan struct{} { return s.notify }

func (s *Spool) find(seq uint64) *segment {
	i := sort.Search(len(s.segs), func(i int) bool { return s.segs[i].seq >= seq })
	if i < len(s.segs) && s.segs[i].seq == seq {
		return s.segs[i]
	}
	return nil
}

// Pending is an unacknowledged record.
type Pending struct {
	Pos          Position
	Event        bool
	ReceivedAtMs int64
	// Site is a small per-process number for the record's site (0 = not an event record): the forwarder uses it to
	// keep one site's backlog from taking every worker. It is not the site id.
	Site uint32
}

// PendingAfter returns up to max unacknowledged records after position `after`, in order.
func (s *Spool) PendingAfter(after Position, max int) []Pending {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Pending
	for _, g := range s.segs {
		if g.seq < after.Seg {
			continue
		}
		start := g.first
		if g.seq == after.Seg && after.Idx+1 > start {
			start = after.Idx + 1
		}
		for i := start; i < len(g.frames); i++ {
			if g.isAcked(i) {
				continue
			}
			out = append(out, Pending{Pos: Position{g.seq, i}, Event: g.frames[i].event, ReceivedAtMs: g.frames[i].recv, Site: g.frames[i].site})
			if len(out) >= max {
				return out
			}
		}
	}
	return out
}

// ErrGone means the record was acknowledged (and its segment possibly deleted) meanwhile.
var ErrGone = errors.New("spool: record already acknowledged")

// Read returns a record's JSON payload, verifying its CRC.
func (s *Spool) Read(pos Position) ([]byte, error) {
	s.mu.Lock()
	g := s.find(pos.Seg)
	if g == nil || pos.Idx < 0 || pos.Idx >= len(g.frames) {
		s.mu.Unlock()
		return nil, ErrGone
	}
	if g.isAcked(pos.Idx) {
		s.mu.Unlock()
		return nil, ErrGone
	}
	fr, path := g.frames[pos.Idx], g.path
	s.mu.Unlock()
	f, err := os.Open(path)
	if err != nil {
		return nil, ErrGone
	}
	defer f.Close()
	buf := make([]byte, 8+fr.n)
	if _, err := f.ReadAt(buf, fr.off); err != nil {
		return nil, err
	}
	data := buf[8:]
	if crc32.Checksum(data, castagnoli) != binary.LittleEndian.Uint32(buf[4:8]) {
		return nil, errors.New("spool: crc mismatch")
	}
	return data, nil
}

// Ack durably marks a record acknowledged. It is idempotent: a second ack of the same record changes nothing.
func (s *Spool) Ack(pos Position, out Outcome) error {
	r := &ackReq{pos: pos, out: out, done: make(chan error, 1)}
	s.closeMu.RLock()
	if s.isClosed.Load() {
		s.closeMu.RUnlock()
		return ErrClosed
	}
	s.acks <- r
	s.closeMu.RUnlock()
	return <-r.done
}

func (s *Spool) acker() {
	defer s.wg.Done()
	for {
		select {
		case <-s.closed:
			for {
				select {
				case r := <-s.acks:
					r.done <- ErrClosed
				default:
					return
				}
			}
		case r := <-s.acks:
			batch := []*ackReq{r}
		drain:
			for len(batch) < 1024 {
				select {
				case r2 := <-s.acks:
					batch = append(batch, r2)
				default:
					break drain
				}
			}
			s.ackBatch(batch)
			for _, b := range batch {
				b.done <- b.err
			}
		}
	}
}

// ackBatch applies acknowledgements with one fsync per touched ack file. A request whose ack could not be made
// durable (open, write or fsync error) gets the error and its bit is rolled back in memory, so nothing is counted as
// delivered and no segment is deleted on the strength of an ack that is not on disk.
func (s *Spool) ackBatch(batch []*ackReq) {
	s.mu.Lock()
	defer s.mu.Unlock()
	type applied struct {
		r   *ackReq
		g   *segment
		idx int
	}
	var done []applied
	dirty := map[*segment]bool{}
	for _, r := range batch {
		g := s.find(r.pos.Seg)
		if g == nil || r.pos.Idx < 0 || r.pos.Idx >= len(g.frames) || g.isAcked(r.pos.Idx) {
			continue // idempotent
		}
		bit := byte(1 << (r.pos.Idx % 8))
		g.acked[r.pos.Idx/8] |= bit
		if g.ackF == nil {
			f, err := os.OpenFile(g.ackPath, os.O_RDWR|os.O_CREATE, 0o600)
			if err != nil {
				g.acked[r.pos.Idx/8] &^= bit
				r.err = err
				continue
			}
			g.ackF = f
		}
		if _, err := g.ackF.WriteAt(g.acked[r.pos.Idx/8:r.pos.Idx/8+1], int64(r.pos.Idx/8)); err != nil {
			g.acked[r.pos.Idx/8] &^= bit
			r.err = err
			continue
		}
		dirty[g] = true
		done = append(done, applied{r, g, r.pos.Idx})
	}
	failed := map[*segment]error{}
	for g := range dirty {
		if e := s.o.Sync(g.ackF); e != nil {
			failed[g] = e
		}
	}
	for _, a := range done {
		if e := failed[a.g]; e != nil {
			a.g.acked[a.idx/8] &^= 1 << (a.idx % 8)
			a.r.err = e
			continue
		}
		a.g.nAcked++
		s.pending--
		fr := a.g.frames[a.idx]
		if fr.event {
			s.queued--
			s.siteB[fr.site] -= 8 + int64(fr.n)
			if s.siteB[fr.site] <= 0 {
				delete(s.siteB, fr.site)
			}
			switch a.r.out {
			case OutStored:
				s.totals.AckedStored++
			case OutEngineBot:
				s.totals.AckedEngineBot++
			case OutEngineRejected:
				s.totals.AckedEngineRejected++
			case OutExpired:
				s.totals.Expired72h++
			default:
				s.totals.AckedStored++
			}
		}
	}
	// Delete sealed, fully acknowledged segments.
	kept := s.segs[:0]
	for i, g := range s.segs {
		if g.sealed && g.nAcked == len(g.frames) && i < len(s.segs)-1 {
			s.removeFiles(g)
			continue
		}
		g.advance()
		kept = append(kept, g)
	}
	s.segs = kept
	if len(dirty) > 0 {
		_ = syncDir(s.o.Dir)
	}
}

// ExpireOld acknowledges every unacknowledged record received more than Expiry ago as expired (72-hour rule,
// C-18): counted `expired_72h` for event records. Returns the number of event records expired. onEvent (may be nil)
// sees each expired event record first (for the per-site `drop/undeliverable_72h` counter).
func (s *Spool) ExpireOld(onEvent func(data []byte)) int {
	cut := s.o.Now().Add(-s.o.Expiry).UnixMilli()
	var todo []Position
	var events int
	s.mu.Lock()
	for _, g := range s.segs {
		g.advance()
		// Frames are appended in receipt order: stop at the first pending frame that is not old enough.
		for i := g.first; i < len(g.frames); i++ {
			fr := g.frames[i]
			if g.isAcked(i) {
				continue
			}
			if fr.recv >= cut {
				break
			}
			todo = append(todo, Position{g.seq, i})
			if fr.event {
				events++
			}
		}
	}
	s.mu.Unlock()
	for _, p := range todo {
		if onEvent != nil {
			if data, err := s.Read(p); err == nil {
				var h header
				if json.Unmarshal(data, &h) == nil && h.Type == "event" {
					onEvent(data)
				}
			}
		}
		_ = s.Ack(p, OutExpired)
	}
	return events
}

// Deltas is the accounting since the previous counter record.
type Deltas struct {
	Counts
	Queued int64
}

// TakeAccounting returns the event accounting since the last call (for one counter record) and the current queue
// gauge. If the counter record cannot be spooled, the caller gives the deltas back with Restore.
func (s *Spool) TakeAccounting() Deltas {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := Deltas{Counts: Counts{
		Fsynced:             s.totals.Fsynced - s.reported.Fsynced,
		AckedStored:         s.totals.AckedStored - s.reported.AckedStored,
		AckedEngineBot:      s.totals.AckedEngineBot - s.reported.AckedEngineBot,
		AckedEngineRejected: s.totals.AckedEngineRejected - s.reported.AckedEngineRejected,
		Expired72h:          s.totals.Expired72h - s.reported.Expired72h,
	}, Queued: s.queued}
	s.reported = s.totals
	return d
}

// Restore gives deltas back after a failed counter-record append.
func (s *Spool) Restore(d Deltas) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reported.Fsynced -= d.Fsynced
	s.reported.AckedStored -= d.AckedStored
	s.reported.AckedEngineBot -= d.AckedEngineBot
	s.reported.AckedEngineRejected -= d.AckedEngineRejected
	s.reported.Expired72h -= d.Expired72h
}

// Stats for metrics.
type Stats struct {
	Totals       Counts
	Queued       int64
	Pending      int // unacknowledged records of any type
	Segments     int
	Bytes        int64
	Corrupt      int64 // unreadable frames or regions found by recovery (alert when > 0)
	CorruptBytes int64
	OldestMs     int64 // receipt time of the oldest unacknowledged record (0 = none)
}

// Stats returns a snapshot. It costs O(segments), not O(records), so a metrics scrape never stalls the group commit
// during a long backlog.
func (s *Spool) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Stats{Totals: s.totals, Queued: s.queued, Pending: int(s.pending), Segments: len(s.segs), Bytes: s.bytes,
		Corrupt: s.corrupt, CorruptBytes: s.lostB}
	for _, g := range s.segs {
		g.advance()
		if g.first < len(g.frames) {
			if r := g.frames[g.first].recv; st.OldestMs == 0 || r < st.OldestMs {
				st.OldestMs = r
			}
		}
	}
	return st
}

// Close stops the goroutines and closes files. Records already acknowledged to callers are on disk.
func (s *Spool) Close() error {
	s.closeMu.Lock()
	if s.isClosed.Swap(true) {
		s.closeMu.Unlock()
		return nil
	}
	close(s.closed)
	s.closeMu.Unlock()
	s.wg.Wait()
	// Requests enqueued before Close but not taken by the goroutines' own drain get their answer here.
drain:
	for {
		select {
		case r := <-s.reqs:
			r.done <- ErrClosed
		case r := <-s.acks:
			r.done <- ErrClosed
		default:
			break drain
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, g := range s.segs {
		if g.f != nil {
			_ = s.o.Sync(g.f)
			g.f.Close()
			g.f = nil
		}
		if g.ackF != nil {
			g.ackF.Close()
			g.ackF = nil
		}
	}
	return nil
}
