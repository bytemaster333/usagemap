// SPDX-License-Identifier: Apache-2.0

package lake

import (
	"crypto/sha256"
	"errors"
	"fmt"

	"github.com/stellar/go-stellar-sdk/xdr"
)

// Integrity of the ledgers read. Every ledger is checked against its own header — the header hash
// is SHA-256 of the header's XDR, the transaction set hash (StellarValue.txSetHash) is SHA-256 of the generalized
// transaction set's XDR, and the result set hash (txSetResultHash) is SHA-256 of the TransactionResultSet of the
// results in apply order — and consecutive ledgers are chained: previousLedgerHash of ledger n+1 is the hash of
// ledger n. So what is counted (envelopes and results) is bound to a header chain: a store cannot change one ledger's
// content without breaking the chain of the day. A whole forged but self-consistent chain passes these checks; it is
// caught by comparing one hash per complete day — the day's anchor, the first ledger after it (count.Anchor) — with
// an independent copy (Horizon `/ledgers/{seq}`, compared by the jobs service before a day's counts are used; the
// store's own close-time metadata is not an independent copy). Ledgers in the pre-protocol-20 format (LedgerCloseMeta v0, legacy transaction sets) carry no Soroban
// invocation the reader counts and are refused.

// ErrIntegrity marks a ledger whose hashes do not match its content or its predecessor.
var ErrIntegrity = errors.New("lake: ledger integrity")

func hashOf(v interface{ MarshalBinary() ([]byte, error) }) ([32]byte, error) {
	b, err := v.MarshalBinary()
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(b), nil
}

func txSetAndResults(lcm xdr.LedgerCloseMeta) (xdr.GeneralizedTransactionSet, xdr.TransactionResultSet, error) {
	var res xdr.TransactionResultSet
	switch lcm.V {
	case 1:
		if lcm.V1 == nil {
			return xdr.GeneralizedTransactionSet{}, res, errors.New("empty v1 ledger")
		}
		for _, p := range lcm.V1.TxProcessing {
			res.Results = append(res.Results, p.Result)
		}
		return lcm.V1.TxSet, res, nil
	case 2:
		if lcm.V2 == nil {
			return xdr.GeneralizedTransactionSet{}, res, errors.New("empty v2 ledger")
		}
		for _, p := range lcm.V2.TxProcessing {
			res.Results = append(res.Results, p.Result)
		}
		return lcm.V2.TxSet, res, nil
	}
	return xdr.GeneralizedTransactionSet{}, res, fmt.Errorf("ledger close meta v%d is not supported (protocol 20 or later only)", lcm.V)
}

// CheckLedger verifies one ledger's header hash, transaction set hash and result set hash; it returns the ledger's
// hash and its predecessor's hash as the header names it.
func CheckLedger(lcm xdr.LedgerCloseMeta) (hash, prev [32]byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: unsupported structure: %v", ErrIntegrity, r)
		}
	}()
	set, results, err := txSetAndResults(lcm)
	if err != nil {
		return hash, prev, fmt.Errorf("%w: %v", ErrIntegrity, err)
	}
	entry := lcm.LedgerHeaderHistoryEntry()
	seq := uint32(entry.Header.LedgerSeq)
	h, err := hashOf(entry.Header)
	if err != nil {
		return hash, prev, err
	}
	if h != [32]byte(entry.Hash) {
		return hash, prev, fmt.Errorf("%w: ledger %d: header hash does not match the header", ErrIntegrity, seq)
	}
	ts, err := hashOf(set)
	if err != nil {
		return hash, prev, err
	}
	if ts != [32]byte(entry.Header.ScpValue.TxSetHash) {
		return hash, prev, fmt.Errorf("%w: ledger %d: transaction set does not match the header", ErrIntegrity, seq)
	}
	rs, err := hashOf(results)
	if err != nil {
		return hash, prev, err
	}
	if rs != [32]byte(entry.Header.TxSetResultHash) {
		return hash, prev, fmt.Errorf("%w: ledger %d: results do not match the header", ErrIntegrity, seq)
	}
	return h, [32]byte(entry.Header.PreviousLedgerHash), nil
}

// Chain checks a set of ledgers read in any order (file names sort by a descending hex prefix): each one with
// CheckLedger when it is added, and, in Verify, every ledger whose predecessor was also read against that
// predecessor's hash. A gap (a ledger not read) separates two chains; the reader's completeness rules decide whether a
// gap is acceptable. A ledger read twice must be identical.
type Chain struct {
	links map[uint32][2][32]byte // seq → {hash, previous hash}
}

// Add checks one ledger and records its hashes.
func (c *Chain) Add(lcm xdr.LedgerCloseMeta) error {
	h, prev, err := CheckLedger(lcm)
	if err != nil {
		return err
	}
	if c.links == nil {
		c.links = map[uint32][2][32]byte{}
	}
	seq := lcm.LedgerSequence()
	if have, ok := c.links[seq]; ok {
		if have[0] != h {
			return fmt.Errorf("%w: ledger %d read twice with different content", ErrIntegrity, seq)
		}
		return nil
	}
	c.links[seq] = [2][32]byte{h, prev}
	return nil
}

// Hash returns the hash of a ledger that was added (checked against its header), or false when it was not read.
func (c *Chain) Hash(seq uint32) ([32]byte, bool) {
	l, ok := c.links[seq]
	return l[0], ok
}

// Verify checks every link between two ledgers that were both read.
func (c *Chain) Verify() error {
	for seq, l := range c.links {
		if p, ok := c.links[seq-1]; ok && seq > 0 && l[1] != p[0] {
			return fmt.Errorf("%w: ledger %d does not follow ledger %d (previous ledger hash)", ErrIntegrity, seq, seq-1)
		}
	}
	return nil
}

// Seal fills a ledger's hashes from its content (transaction set hash, result set hash, header hash) with prev as its
// predecessor's hash. For fixtures and tests: a real ledger is never re-sealed.
func Seal(lcm *xdr.LedgerCloseMeta, prev [32]byte) ([32]byte, error) {
	set, results, err := txSetAndResults(*lcm)
	if err != nil {
		return [32]byte{}, err
	}
	ts, err := hashOf(set)
	if err != nil {
		return [32]byte{}, err
	}
	rs, err := hashOf(results)
	if err != nil {
		return [32]byte{}, err
	}
	var entry *xdr.LedgerHeaderHistoryEntry
	switch lcm.V {
	case 1:
		entry = &lcm.V1.LedgerHeader
	case 2:
		entry = &lcm.V2.LedgerHeader
	}
	entry.Header.ScpValue.TxSetHash = xdr.Hash(ts)
	entry.Header.TxSetResultHash = xdr.Hash(rs)
	entry.Header.PreviousLedgerHash = xdr.Hash(prev)
	h, err := hashOf(entry.Header)
	if err != nil {
		return [32]byte{}, err
	}
	entry.Hash = xdr.Hash(h)
	return h, nil
}
