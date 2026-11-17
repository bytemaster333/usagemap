// SPDX-License-Identifier: Apache-2.0

// Package count turns LedgerCloseMeta values into daily per-contract invocation counts in the shape of
// scf.onchain_daily (db/migrations/0021_onchain.sql): invocations, successful_invocations, distinct_invokers.
//
// Definitions (documented in the README):
//   - an invocation is a top-level InvokeHostFunction operation whose host function is InvokeContract and whose
//     target contract is one of the requested contracts; contract-to-contract sub-calls are not counted;
//   - it is successful when its transaction succeeded (Soroban transactions carry exactly one operation);
//   - the invoker is the operation's source account, or the transaction's source when the operation has none (for a
//     fee-bump transaction: the inner transaction's source); distinct invokers are counted per contract and UTC day.
//
// Privacy: invoker keys live only in memory for the duration of a run, are never returned, logged or written; only
// their count leaves the package.
package count

import (
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// DataSource is the scf.onchain_daily.data_source value of this reader.
const DataSource = "ledger_files"

// Row is one output line; the JSON names match the scf.onchain_daily columns, with the contract given as its strkey
// (the jobs map strkey → contract_ref). LedgersInDay is the number of distinct ledgers of that UTC day the run saw,
// LedgerFirst/LedgerLast are the lowest and highest sequence of that day the run saw. Complete is true only when the
// day's ledgers are contiguous and the run also saw the ledger just before LedgerFirst and just after LedgerLast
// (they belong to the neighbouring days, so nothing of this day can be missing); the caller stores complete days only.
// AnchorLedger/AnchorHash name, for a complete day, the first ledger after the day (LedgerLast+1) and its hash (hex);
// null for an incomplete day (see Anchor).
type Row struct {
	Contract              string  `json:"contract"`
	Day                   string  `json:"day"`
	Invocations           int64   `json:"invocations"`
	SuccessfulInvocations int64   `json:"successful_invocations"`
	DistinctInvokers      int64   `json:"distinct_invokers"`
	DataSource            string  `json:"data_source"`
	LedgersInDay          int64   `json:"ledgers_in_day"`
	LedgerFirst           uint32  `json:"ledger_first"`
	LedgerLast            uint32  `json:"ledger_last"`
	Complete              bool    `json:"complete"`
	AnchorLedger          *uint32 `json:"anchor_ledger"`
	AnchorHash            *string `json:"anchor_hash"`
}

// Stats summarises a run without any account data.
type Stats struct {
	Ledgers            int64
	DuplicateLedgers   int64
	OutOfRangeLedgers  int64
	Transactions       int64
	UnmatchedResults   int64
	MatchedInvocations int64
}

type key struct {
	contract [32]byte
	day      string
}

type cell struct {
	invocations, successful int64
	invokers                map[[32]byte]struct{}
}

// Counter accumulates counts. It is not safe for concurrent use.
type Counter struct {
	passphrase string
	contracts  map[[32]byte]string // contract id → strkey
	from, to   string              // inclusive UTC day bounds, "" = open
	cells      map[key]*cell
	days       map[string]map[uint32]struct{}
	seen       map[uint32]struct{} // every ledger sequence read, also outside the day bounds (day completeness)
	stats      Stats
}

// ParseContract validates a C… strkey and returns its 32-byte id.
func ParseContract(s string) ([32]byte, error) {
	var id [32]byte
	raw, err := strkey.Decode(strkey.VersionByteContract, s)
	if err != nil {
		return id, fmt.Errorf("invalid contract strkey: %w", err)
	}
	if len(raw) != 32 {
		return id, errors.New("invalid contract strkey: wrong length")
	}
	copy(id[:], raw)
	return id, nil
}

// New returns a Counter for the given contracts (C… strkeys). passphrase is the network passphrase used to hash
// transaction envelopes (results are matched to envelopes by hash). fromDay/toDay ("YYYY-MM-DD", inclusive) restrict
// the ledgers counted; empty means unbounded.
func New(passphrase string, contracts []string, fromDay, toDay string) (*Counter, error) {
	if passphrase == "" {
		return nil, errors.New("network passphrase is required")
	}
	if len(contracts) == 0 {
		return nil, errors.New("at least one contract is required")
	}
	for _, d := range []string{fromDay, toDay} {
		if d == "" {
			continue
		}
		if _, err := time.Parse(time.DateOnly, d); err != nil {
			return nil, fmt.Errorf("invalid day %q", d)
		}
	}
	if fromDay != "" && toDay != "" && toDay < fromDay {
		return nil, errors.New("to-day is before from-day")
	}
	c := &Counter{
		passphrase: passphrase,
		contracts:  map[[32]byte]string{},
		from:       fromDay,
		to:         toDay,
		cells:      map[key]*cell{},
		days:       map[string]map[uint32]struct{}{},
		seen:       map[uint32]struct{}{},
	}
	for _, s := range contracts {
		id, err := ParseContract(s)
		if err != nil {
			return nil, err
		}
		c.contracts[id] = s
	}
	return c, nil
}

// Stats returns the run counters.
func (c *Counter) Stats() Stats { return c.stats }

// AddLedger counts one ledger. A ledger already seen (overlapping files) is skipped.
func (c *Counter) AddLedger(lcm xdr.LedgerCloseMeta) (err error) {
	defer func() {
		// The SDK's accessors panic on union arms they do not know; a malformed ledger is an error, not a crash.
		if r := recover(); r != nil {
			err = fmt.Errorf("ledger: unsupported structure: %v", r)
		}
	}()
	seq := lcm.LedgerSequence()
	day := lcm.ClosedAt().UTC().Format(time.DateOnly)
	if (c.from != "" && day < c.from) || (c.to != "" && day > c.to) {
		c.seen[seq] = struct{}{}
		c.stats.OutOfRangeLedgers++
		return nil
	}
	seqs := c.days[day]
	if seqs == nil {
		seqs = map[uint32]struct{}{}
		c.days[day] = seqs
	}
	if _, dup := seqs[seq]; dup {
		c.stats.DuplicateLedgers++
		return nil
	}

	envs := lcm.TransactionEnvelopes()
	byHash := make(map[[32]byte]int, len(envs))
	for i, env := range envs {
		h, err := network.HashTransactionInEnvelope(env, c.passphrase)
		if err != nil {
			return fmt.Errorf("ledger %d: hash transaction: %w", seq, err)
		}
		byHash[h] = i
	}
	n := lcm.CountTransactions()
	type pending struct {
		k       key
		ok      bool
		invoker [32]byte
	}
	var found []pending
	for i := 0; i < n; i++ {
		res := lcm.TransactionResultPair(i)
		idx, ok := byHash[res.TransactionHash]
		if !ok {
			c.stats.UnmatchedResults++
			continue
		}
		env := envs[idx]
		txSource := env.SourceAccount()
		for _, op := range env.Operations() {
			if op.Body.Type != xdr.OperationTypeInvokeHostFunction || op.Body.InvokeHostFunctionOp == nil {
				continue
			}
			hf := op.Body.InvokeHostFunctionOp.HostFunction
			if hf.Type != xdr.HostFunctionTypeHostFunctionTypeInvokeContract || hf.InvokeContract == nil {
				continue
			}
			addr := hf.InvokeContract.ContractAddress
			if addr.Type != xdr.ScAddressTypeScAddressTypeContract || addr.ContractId == nil {
				continue
			}
			id := [32]byte(*addr.ContractId)
			if _, want := c.contracts[id]; !want {
				continue
			}
			src := txSource
			if op.SourceAccount != nil {
				src = *op.SourceAccount
			}
			acc := src.ToAccountId()
			found = append(found, pending{k: key{id, day}, ok: res.Successful(), invoker: [32]byte(*acc.Ed25519)})
		}
	}
	// Commit only after the whole ledger was read, so a failing ledger leaves no partial counts behind.
	seqs[seq] = struct{}{}
	c.seen[seq] = struct{}{}
	c.stats.Ledgers++
	c.stats.Transactions += int64(n)
	for _, p := range found {
		ce := c.cells[p.k]
		if ce == nil {
			ce = &cell{invokers: map[[32]byte]struct{}{}}
			c.cells[p.k] = ce
		}
		ce.invocations++
		if p.ok {
			ce.successful++
		}
		ce.invokers[p.invoker] = struct{}{}
		c.stats.MatchedInvocations++
	}
	return nil
}

// Rows returns one row per requested contract and per UTC day seen (zero rows included: "no invocation that day" is
// information for the trust score), sorted by day, then contract.
func (c *Counter) Rows() []Row {
	days := make([]string, 0, len(c.days))
	for d := range c.days {
		days = append(days, d)
	}
	sort.Strings(days)
	type named struct {
		id  [32]byte
		str string
	}
	cs := make([]named, 0, len(c.contracts))
	for id, s := range c.contracts {
		cs = append(cs, named{id, s})
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].str < cs[j].str })
	out := make([]Row, 0, len(days)*len(cs))
	for _, d := range days {
		first, last := ^uint32(0), uint32(0)
		for s := range c.days[d] {
			first, last = min(first, s), max(last, s)
		}
		n := int64(len(c.days[d]))
		_, before := c.seen[first-1]
		_, after := c.seen[last+1]
		complete := n == int64(last)-int64(first)+1 && first > 0 && before && after
		for _, ct := range cs {
			r := Row{Contract: ct.str, Day: d, DataSource: DataSource, LedgersInDay: n,
				LedgerFirst: first, LedgerLast: last, Complete: complete}
			if ce := c.cells[key{ct.id, d}]; ce != nil {
				r.Invocations = ce.invocations
				r.SuccessfulInvocations = ce.successful
				r.DistinctInvokers = int64(len(ce.invokers))
			}
			out = append(out, r)
		}
	}
	return out
}

// Anchor names the anchor of every complete row: the first ledger after the day (LedgerLast+1) and its hash, looked
// up in hash (lake.Chain.Hash: ledgers read and checked against their headers). The caller has verified the chain
// (lake.Chain.Verify), and a complete day's ledgers LedgerFirst−1…LedgerLast+1 were all read, so each one is linked
// to the next by its previous-ledger hash: the anchor's hash commits to every header of the day — its transaction
// set, results and close time — and to the close time that ends the day. One comparison of that hash with an
// independent copy (Horizon `/ledgers/{seq}`) therefore authenticates the day's counts against a store serving a whole
// forged but self-consistent chain (register C-144). A complete row whose anchor was not read (cannot happen when the
// chain was built from the same ledgers) is marked incomplete rather than left without an anchor.
func Anchor(rows []Row, hash func(seq uint32) ([32]byte, bool)) {
	for i := range rows {
		r := &rows[i]
		r.AnchorLedger, r.AnchorHash = nil, nil
		if !r.Complete {
			continue
		}
		seq := r.LedgerLast + 1
		h, ok := hash(seq)
		if !ok {
			r.Complete = false
			continue
		}
		hx := hex.EncodeToString(h[:])
		r.AnchorLedger, r.AnchorHash = &seq, &hx
	}
}
