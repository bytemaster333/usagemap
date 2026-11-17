// SPDX-License-Identifier: Apache-2.0

// Package fetch fills the local mirror of public Stellar ledger data files that the reader counts from (wire-formats
// §p.1, plan A1, C-136). A store is a Galexie ledger-data lake in the SEP-54 layout, read over anonymous HTTPS: its
// `.config.json` declares the passphrase, compression and the batch layout, and every object key is derived from it
// (the AWS and Lightsail mainnet stores differ: one ledger per object against eight). Keys are by ledger sequence, so
// a UTC day's ledger range is found by searching the close times — from the AWS object metadata where present
// (`x-amz-meta-*-close-time`, one HEAD per probe), otherwise by downloading and decoding the batch.
//
// The fetcher never sees tenant data: it is given days and a network, never contract ids. Requests carry no
// credentials and a generic User-Agent.
package fetch

import (
	"bytes"
	"cmp"
	"context"
	"crypto/md5" //nolint:gosec // S3 ETag of a single-part upload is the object's MD5: an integrity check, not security
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

// Verified store roots (references/stellar-facts-check-2026-11-16.md, F4).
const (
	// AWSPubnet is the AWS Open Data copy of mainnet (one ledger per object, from genesis; not requester-pays).
	AWSPubnet = "https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/pubnet"
	// AWSTestnetParent holds one testnet store per network reset (`<reset-date>/`).
	AWSTestnetParent = "https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/testnet"
	// Lightsail is the Lightsail Network (Quasar) copy of mainnet (eight ledgers per object; rate-limited).
	Lightsail = "https://galexie.lightsail.network/v1"
)

// testnetParentURL is where aws-testnet discovers the stores (a variable for tests).
var testnetParentURL = AWSTestnetParent

// UserAgent is sent with every request: the program, never an operator or tenant identity.
const UserAgent = "scf-onchain-reader-fetch/1"

// ConfigName is the store's layout file (SEP-54).
const ConfigName = ".config.json"

// ErrNoConfig is returned when a store has no `.config.json` and no explicit layout was given.
var ErrNoConfig = errors.New("store has no .config.json (pre-v23 store?): give -ledgers-per-batch, -batches-per-partition and -file-ext explicitly")

// ErrNotFound is returned for an object the store does not have (HTTP 404).
var ErrNotFound = errors.New("not found")

// StoreConfig is the SEP-54 `.config.json`.
type StoreConfig struct {
	NetworkPassphrase   string `json:"networkPassphrase"`
	Version             string `json:"version,omitempty"`
	Compression         string `json:"compression"`
	LedgersPerBatch     uint32 `json:"ledgersPerBatch"`
	BatchesPerPartition uint32 `json:"batchesPerPartition"`
	// FileExt is not part of the file: `.xdr.zst` for a store with a config, explicit for one without.
	FileExt string `json:"fileExt,omitempty"`
}

// Layout returns the key scheme of the store.
func (c StoreConfig) Layout() lake.Layout {
	ext := c.FileExt
	if ext == "" {
		ext = ".xdr.zst"
	}
	return lake.Layout{LedgersPerBatch: c.LedgersPerBatch, BatchesPerPartition: c.BatchesPerPartition, Ext: ext}
}

// Validate checks the config can be used to fetch for the given network passphrase.
func (c StoreConfig) Validate(passphrase string) error {
	if c.Compression != "zstd" {
		return fmt.Errorf("store compression %q is not supported (zstd only)", c.Compression)
	}
	if err := c.Layout().Validate(); err != nil {
		return err
	}
	if c.NetworkPassphrase != passphrase {
		return fmt.Errorf("store network passphrase %q does not match -network %q", c.NetworkPassphrase, passphrase)
	}
	return nil
}

// HTTP is a small HTTPS client with bounded retries and exponential backoff with jitter. Transport errors, 429 and 5xx
// are retried (honouring Retry-After); other statuses are final.
type HTTP struct {
	Client    *http.Client
	Retries   int           // retries after the first attempt
	BaseDelay time.Duration // first backoff
	MaxDelay  time.Duration // cap of one backoff
	// MaxBody bounds a response body (zip-bomb and runaway guard on the compressed side).
	MaxBody int64
	// sleep waits (a variable for tests).
	sleep func(context.Context, time.Duration) error
	// allowHTTP accepts plain http:// URLs (development store only, newDevHTTP).
	allowHTTP bool
}

// DefaultMaxBody bounds one compressed object (a mainnet ledger is ~150 KiB compressed, an eight-ledger batch about
// 1.5 MiB): with -parallel workers at most parallel × DefaultMaxBody compressed bytes are held at once.
const DefaultMaxBody int64 = 64 << 20

// errBodyTooLarge is final (never retried).
var errBodyTooLarge = errors.New("body larger than the bound")

// NewHTTP returns a client that refuses plain HTTP and redirects off HTTPS.
func NewHTTP(c *http.Client, retries int) *HTTP {
	if c == nil {
		c = &http.Client{Timeout: 2 * time.Minute}
	}
	cc := *c
	cc.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" {
			return errors.New("redirect off HTTPS refused")
		}
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	}
	return &HTTP{Client: &cc, Retries: retries, BaseDelay: 500 * time.Millisecond, MaxDelay: 30 * time.Second,
		MaxBody: DefaultMaxBody, sleep: sleepCtx}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Response is a fully read answer.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

type statusError struct {
	status int
	url    string
}

func (e statusError) Error() string { return fmt.Sprintf("%s: HTTP %d", e.url, e.status) }

// Do sends method to u and reads the body. A 404 is returned as ErrNotFound; 2xx as a Response; anything else as an
// error after the retries.
func (h *HTTP) Do(ctx context.Context, method, u string) (*Response, error) {
	if !strings.HasPrefix(u, "https://") && !(h.allowHTTP && strings.HasPrefix(u, "http://")) {
		return nil, fmt.Errorf("refusing non-HTTPS URL %s", u)
	}
	var last error
	for attempt := 0; ; attempt++ {
		resp, retryAfter, err := h.once(ctx, method, u)
		if err == nil {
			return resp, nil
		}
		if errors.Is(err, ErrNotFound) || errors.Is(err, errBodyTooLarge) || ctx.Err() != nil {
			return nil, err
		}
		var se statusError
		if errors.As(err, &se) && se.status != http.StatusTooManyRequests && se.status < 500 {
			return nil, err
		}
		last = err
		if attempt >= h.Retries {
			return nil, fmt.Errorf("%w (after %d attempts)", last, attempt+1)
		}
		d := h.BaseDelay << min(attempt, 16)
		d = min(d, h.MaxDelay)
		d = d/2 + time.Duration(rand.Int64N(int64(d/2)+1)) // jitter in [d/2, d]
		if retryAfter > d {
			d = min(retryAfter, 5*time.Minute)
		}
		if err := h.sleep(ctx, d); err != nil {
			return nil, err
		}
	}
}

func (h *HTTP) once(ctx context.Context, method, u string) (*Response, time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", UserAgent)
	resp, err := h.Client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	var retryAfter time.Duration
	if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s > 0 {
		retryAfter = time.Duration(s) * time.Second
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, 0, fmt.Errorf("%s: %w", u, ErrNotFound)
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, retryAfter, statusError{resp.StatusCode, u}
	}
	var body []byte
	if method != http.MethodHead {
		// A declared length above the bound is refused before anything is read.
		if resp.ContentLength > h.MaxBody {
			return nil, 0, fmt.Errorf("%s: %w (%d > %d bytes)", u, errBodyTooLarge, resp.ContentLength, h.MaxBody)
		}
		buf := bytes.NewBuffer(make([]byte, 0, max(min(resp.ContentLength, h.MaxBody), 0)))
		_, err = io.Copy(buf, io.LimitReader(resp.Body, h.MaxBody+1))
		body = buf.Bytes()
		if err != nil {
			return nil, 0, err // a cut connection is retried
		}
		if int64(len(body)) > h.MaxBody {
			return nil, 0, fmt.Errorf("%s: %w (%d bytes)", u, errBodyTooLarge, h.MaxBody)
		}
		if resp.ContentLength >= 0 && int64(len(body)) != resp.ContentLength {
			return nil, 0, fmt.Errorf("%s: short body (%d of %d bytes)", u, len(body), resp.ContentLength)
		}
	}
	return &Response{Status: resp.StatusCode, Header: resp.Header, Body: body}, 0, nil
}

// Store is one ledger-data store.
type Store struct {
	Root   string // https://…, no trailing slash
	Config StoreConfig
	http   *HTTP
	// decode bounds the decompressed batches in memory at once across all workers (nil: no shared bound).
	decode *budget
}

// ReadConfig fetches and parses the store's `.config.json`; ErrNoConfig when it has none.
func ReadConfig(ctx context.Context, h *HTTP, root string) (StoreConfig, error) {
	var c StoreConfig
	r, err := h.Do(ctx, http.MethodGet, root+"/"+ConfigName)
	if errors.Is(err, ErrNotFound) {
		return c, ErrNoConfig
	}
	if err != nil {
		return c, err
	}
	dec := json.NewDecoder(bytes.NewReader(r.Body))
	if err := dec.Decode(&c); err != nil {
		return c, fmt.Errorf("%s: %w", ConfigName, err)
	}
	c.FileExt = ".xdr.zst"
	return c, nil
}

// OpenStore reads the store's config (or takes override for a store without one) and checks it against passphrase.
func OpenStore(ctx context.Context, h *HTTP, root, passphrase string, override *StoreConfig) (*Store, error) {
	root = strings.TrimRight(root, "/")
	c, err := ReadConfig(ctx, h, root)
	switch {
	case err == nil && override != nil:
		return nil, errors.New("explicit layout flags are only for stores without .config.json; this store has one")
	case errors.Is(err, ErrNoConfig) && override != nil:
		c = *override
		c.NetworkPassphrase = passphrase
	case err != nil:
		return nil, err
	}
	if err := c.Validate(passphrase); err != nil {
		return nil, err
	}
	return &Store{Root: root, Config: c, http: h}, nil
}

// BatchURL is the URL of the batch that starts at start.
func (s *Store) BatchURL(start uint32) string { return s.Root + "/" + s.Config.Layout().Key(start) }

// BatchInfo describes a batch as far as a probe learned it.
type BatchInfo struct {
	Exists                bool
	First, Last           uint32 // ledger sequences
	FirstClose, LastClose int64  // close times, Unix seconds
	// Body is set when the probe had to download the batch (store without object metadata); it is verified like any
	// download before it is written to the mirror.
	Body   []byte
	Header http.Header
}

func metaInt(h http.Header, name string) (int64, bool) {
	v := h.Get("X-Amz-Meta-" + name)
	if v == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	return n, err == nil
}

// Probe learns the ledger range and close times of the batch that starts at start: a HEAD when the store returns
// the close times as object metadata (AWS), else a GET and a decode.
func (s *Store) Probe(ctx context.Context, start uint32, maxBytes int64) (BatchInfo, error) {
	u := s.BatchURL(start)
	r, err := s.http.Do(ctx, http.MethodHead, u)
	if errors.Is(err, ErrNotFound) {
		return BatchInfo{}, nil
	}
	if err != nil {
		return BatchInfo{}, err
	}
	fc, ok1 := metaInt(r.Header, "Start-Ledger-Close-Time")
	lc, ok2 := metaInt(r.Header, "End-Ledger-Close-Time")
	fs, ok3 := metaInt(r.Header, "Start-Ledger")
	ls, ok4 := metaInt(r.Header, "End-Ledger")
	if ok1 && ok2 && ok3 && ok4 && fs >= 0 && ls >= fs && ls <= int64(^uint32(0)) && lc >= fc {
		return BatchInfo{Exists: true, First: uint32(fs), Last: uint32(ls), FirstClose: fc, LastClose: lc}, nil
	}
	return s.Get(ctx, start, maxBytes)
}

// Get downloads and verifies the batch that starts at start.
func (s *Store) Get(ctx context.Context, start uint32, maxBytes int64) (BatchInfo, error) {
	u := s.BatchURL(start)
	r, err := s.http.Do(ctx, http.MethodGet, u)
	if errors.Is(err, ErrNotFound) {
		return BatchInfo{}, nil
	}
	if err != nil {
		return BatchInfo{}, err
	}
	info, err := s.Verify(ctx, start, r.Body, r.Header, maxBytes)
	if err != nil {
		return BatchInfo{}, fmt.Errorf("%s: %w", s.Config.Layout().Key(start), err)
	}
	return info, nil
}

var plainETag = regexp.MustCompile(`^"([0-9a-f]{32})"$`)

// Verify checks a downloaded batch: the object's MD5 against a single-part S3 ETag when there is one, the store's
// metadata (network passphrase, ledger range, close times) when present, and that it decodes as a
// LedgerCloseMetaBatch of exactly the expected, contiguous ledger range.
func (s *Store) Verify(ctx context.Context, start uint32, body []byte, h http.Header, maxBytes int64) (BatchInfo, error) {
	if m := plainETag.FindStringSubmatch(h.Get("ETag")); m != nil {
		sum := md5.Sum(body) //nolint:gosec // integrity against the store's own checksum
		if hex.EncodeToString(sum[:]) != m[1] {
			return BatchInfo{}, errors.New("checksum mismatch (MD5 against ETag)")
		}
	}
	if p := h.Get("X-Amz-Meta-Network-Passphrase"); p != "" && p != s.Config.NetworkPassphrase {
		return BatchInfo{}, fmt.Errorf("object metadata names network %q", p)
	}
	if maxBytes <= 0 {
		maxBytes = lake.DefaultMaxDecompressed
	}
	// Reserve the decompressed size (declared by the frame, else the bound) in the run's shared budget first.
	var hint int64
	if n, ok := lake.FrameContentSize(body); ok {
		if n > uint64(maxBytes) {
			return BatchInfo{}, lake.ErrTooLarge
		}
		hint = int64(n)
	}
	if s.decode != nil {
		release, err := s.decode.acquire(ctx, cmp.Or(hint, maxBytes))
		if err != nil {
			return BatchInfo{}, err
		}
		defer release()
	}
	batch, err := lake.DecodeBatchSized(bytes.NewReader(body), maxBytes, hint)
	if err != nil {
		return BatchInfo{}, err
	}
	l := s.Config.Layout()
	wantFirst, wantLast := max(start, 2), l.BatchEnd(start) // Galexie starts at ledger 2 (genesis is 1)
	first, last := uint32(batch.StartSequence), uint32(batch.EndSequence)
	if first != wantFirst || last != wantLast {
		return BatchInfo{}, fmt.Errorf("batch holds ledgers %d-%d, want %d-%d", first, last, wantFirst, wantLast)
	}
	if uint64(len(batch.LedgerCloseMetas)) != uint64(last-first)+1 {
		return BatchInfo{}, fmt.Errorf("batch %d-%d holds %d ledgers", first, last, len(batch.LedgerCloseMetas))
	}
	var fc, lc int64
	var chain lake.Chain
	for i, lcm := range batch.LedgerCloseMetas {
		seq, ct, err := seqAndClose(lcm)
		if err != nil {
			return BatchInfo{}, err
		}
		// header, transaction set and result hashes, and the chain inside the batch
		if err := chain.Add(lcm); err != nil {
			return BatchInfo{}, err
		}
		if seq != first+uint32(i) {
			return BatchInfo{}, fmt.Errorf("ledger %d at position %d of batch %d-%d", seq, i, first, last)
		}
		if i == 0 {
			fc = ct
		}
		if ct < lc {
			return BatchInfo{}, fmt.Errorf("ledger %d closes before its predecessor", seq)
		}
		lc = ct
	}
	if err := chain.Verify(); err != nil {
		return BatchInfo{}, err
	}
	for name, want := range map[string]int64{"Start-Ledger": int64(first), "End-Ledger": int64(last),
		"Start-Ledger-Close-Time": fc, "End-Ledger-Close-Time": lc} {
		if v, ok := metaInt(h, name); ok && v != want {
			return BatchInfo{}, fmt.Errorf("object metadata %s=%d, content %d", strings.ToLower(name), v, want)
		}
	}
	return BatchInfo{Exists: true, First: first, Last: last, FirstClose: fc, LastClose: lc, Body: body, Header: h}, nil
}

// ListPrefixes lists the "directories" directly below parent of an S3 bucket served at a virtual-hosted URL
// (ListObjectsV2 with delimiter `/`), e.g. the testnet stores below AWSTestnetParent.
func ListPrefixes(ctx context.Context, h *HTTP, parent string) ([]string, error) {
	pu, err := url.Parse(strings.TrimRight(parent, "/"))
	if err != nil {
		return nil, err
	}
	prefix := strings.TrimPrefix(pu.Path, "/") + "/"
	var out []string
	token := ""
	for page := 0; page < 100; page++ {
		q := url.Values{"list-type": {"2"}, "prefix": {prefix}, "delimiter": {"/"}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		r, err := h.Do(ctx, http.MethodGet, pu.Scheme+"://"+pu.Host+"/?"+q.Encode())
		if err != nil {
			return nil, err
		}
		var res struct {
			CommonPrefixes []struct {
				Prefix string `xml:"Prefix"`
			} `xml:"CommonPrefixes"`
			IsTruncated           bool   `xml:"IsTruncated"`
			NextContinuationToken string `xml:"NextContinuationToken"`
		}
		if err := xml.Unmarshal(r.Body, &res); err != nil {
			return nil, fmt.Errorf("bucket listing: %w", err)
		}
		for _, p := range res.CommonPrefixes {
			name := strings.TrimSuffix(strings.TrimPrefix(p.Prefix, prefix), "/")
			if name != "" && !strings.Contains(name, "/") {
				out = append(out, name)
			}
		}
		if !res.IsTruncated || res.NextContinuationToken == "" {
			sort.Strings(out)
			return out, nil
		}
		token = res.NextContinuationToken
	}
	return nil, errors.New("bucket listing: too many pages")
}

var resetDir = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// TestnetStores returns the testnet stores below parent (one per network reset, named by reset date) that have a
// `.config.json`, newest first.
func TestnetStores(ctx context.Context, h *HTTP, parent string) ([]string, error) {
	names, err := ListPrefixes(ctx, h, parent)
	if err != nil {
		return nil, err
	}
	var dates []string
	for _, n := range names {
		if resetDir.MatchString(n) {
			dates = append(dates, n)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(dates)))
	var out []string
	for _, d := range dates {
		root := strings.TrimRight(parent, "/") + "/" + d
		if _, err := ReadConfig(ctx, h, root); err == nil {
			out = append(out, root)
		} else if !errors.Is(err, ErrNoConfig) {
			return nil, err
		}
	}
	return out, nil
}

// ResolveSource maps an alias or URL to a store root: "" picks the default of the network (AWS pubnet, or the newest
// AWS testnet store); "aws"/"aws-pubnet", "lightsail" and "aws-testnet" are the verified stores; anything else must
// be an https:// URL of a store root, or of a parent of per-reset testnet stores (a path ending in /testnet), whose
// newest store with a .config.json is used.
func ResolveSource(ctx context.Context, h *HTTP, source string, testnet bool) (string, error) {
	switch source {
	case "":
		if testnet {
			return ResolveSource(ctx, h, "aws-testnet", true)
		}
		return AWSPubnet, nil
	case "aws", "aws-pubnet":
		return AWSPubnet, nil
	case "lightsail":
		return Lightsail, nil
	case "aws-testnet":
		return newestTestnetStore(ctx, h, testnetParentURL)
	}
	u, err := url.Parse(source)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("-source must be an https:// store root without credentials, query or fragment, or one of aws-pubnet, aws-testnet, lightsail")
	}
	root := strings.TrimRight(source, "/")
	if strings.HasSuffix(u.Path, "/testnet") || strings.HasSuffix(u.Path, "/testnet/") {
		// The parent of the per-reset testnet stores (e.g. AWSTestnetParent): discover the newest, so a configured
		// URL survives a reset (the mirror then refuses the new store loudly, see MovedError).
		return newestTestnetStore(ctx, h, root)
	}
	return root, nil
}

func newestTestnetStore(ctx context.Context, h *HTTP, parent string) (string, error) {
	stores, err := TestnetStores(ctx, h, parent)
	if err != nil {
		return "", fmt.Errorf("discover the testnet store: %w", err)
	}
	if len(stores) == 0 {
		return "", errors.New("discover the testnet store: no store with a .config.json below " + parent)
	}
	return stores[0], nil
}

// testnetParent returns the parent of a `…/<reset-date>` store root, or "" when root is not such a store.
func testnetParent(root string) string {
	i := strings.LastIndexByte(root, '/')
	if i < 0 || !resetDir.MatchString(root[i+1:]) {
		return ""
	}
	return root[:i]
}
