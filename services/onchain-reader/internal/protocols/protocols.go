// SPDX-License-Identifier: Apache-2.0

// Package protocols computes `onchain-reader protocols`: per group of contracts (a registry project or a tenant; the
// group is an opaque label chosen by the caller), UTC day and DeFi protocol, how many transactions that touch the
// group's contracts also touch the protocol's contracts — "the protocols your users interact with".
//
// Definitions (README, section "Protocol interactions"):
//   - a transaction is considered when it has at least one InvokeHostFunction operation (any host function);
//     footprint-only operations (ExtendFootprintTTL, RestoreFootprint) and classic operations are not;
//   - the contracts a transaction touches are the union of: the contract of a top-level InvokeContract, every
//     contract node of its Soroban authorization trees, and every contract whose ContractData entry (the instance
//     included) the transaction's Soroban footprint lists (read-only or read-write). Soroban loads a contract's
//     instance entry for every contract it runs, so the footprint names every contract the transaction executed or
//     whose storage it read; a fee-bump is judged by its inner transaction;
//   - a transaction touches a group when it touches at least one of the group's contracts, and counts for protocol P
//     of that group when it also touches a contract of P that is NOT one of the group's own contracts (a registry
//     project that is itself the protocol does not interact with itself);
//   - successful: the transaction succeeded (fee-bump: the inner result).
//
// The protocol contract list is the caller's (a curated registry of public contract ids); contracts that a protocol
// creates at run time (pools, pairs, vaults) and that the list does not name are not seen, so every figure is a lower
// bound of the interactions.
//
// Privacy: no account is read at all; contract ids of the transaction are held only while one transaction is
// examined; only counts per group, day and protocol label leave the package.
package protocols

import (
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"time"

	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/count"
)

// Bounds of one run.
const (
	MaxGroups            = 50_000
	MaxContracts         = 100_000
	MaxProtocols         = 64
	MaxProtocolContracts = 10_000
)

var (
	groupRE    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	protocolRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
)

// DayLine is one UTC day seen (kind "day"), with the same completeness and anchor semantics as package count.
type DayLine struct {
	Kind         string  `json:"kind"`
	Day          string  `json:"day"`
	LedgersInDay int64   `json:"ledgers_in_day"`
	LedgerFirst  uint32  `json:"ledger_first"`
	LedgerLast   uint32  `json:"ledger_last"`
	Complete     bool    `json:"complete"`
	AnchorLedger *uint32 `json:"anchor_ledger"`
	AnchorHash   *string `json:"anchor_hash"`
}

// GroupLine is one group on one day seen (kind "group", zeros included): the transactions that touch the group.
type GroupLine struct {
	Kind                   string `json:"kind"`
	Group                  string `json:"group"`
	Day                    string `json:"day"`
	Transactions           int64  `json:"transactions"`
	SuccessfulTransactions int64  `json:"successful_transactions"`
}

// ProtocolLine is one group, day and protocol (kind "protocol"), only non-zero: the group's transactions that also
// touch the protocol.
type ProtocolLine struct {
	Kind                   string `json:"kind"`
	Group                  string `json:"group"`
	Day                    string `json:"day"`
	Protocol               string `json:"protocol"`
	Transactions           int64  `json:"transactions"`
	SuccessfulTransactions int64  `json:"successful_transactions"`
}

// NetworkLine is one protocol on one day seen (kind "network", zeros included): every transaction of the network
// that touches the protocol, whatever the groups (context for the per-group figures).
type NetworkLine struct {
	Kind                   string `json:"kind"`
	Day                    string `json:"day"`
	Protocol               string `json:"protocol"`
	Transactions           int64  `json:"transactions"`
	SuccessfulTransactions int64  `json:"successful_transactions"`
}

// Result is everything a run outputs, each slice sorted deterministically.
type Result struct {
	Days      []DayLine
	Groups    []GroupLine
	Protocols []ProtocolLine
	Network   []NetworkLine
}

// Stats summarises a run (counts only).
type Stats struct {
	Ledgers, DuplicateLedgers, OutOfRangeLedgers, Transactions, UnmatchedResults int64
	SorobanTransactions, GroupTransactions, ProtocolTransactions                 int64
}

// Member is one (group, contract) pair; ProtocolContract one (protocol, contract) pair of the curated registry.
type Member struct {
	Group    string
	Contract string
}

type ProtocolContract struct {
	Protocol string
	Contract string
}

type cid = [32]byte

type cell struct{ tx, ok int64 }

type gdKey struct{ group, day string }

type gdpKey struct{ group, day, protocol string }

type dpKey struct{ day, protocol string }

// Counter accumulates the figures. It is not safe for concurrent use.
type Counter struct {
	passphrase string
	groupsOf   map[cid][]string
	protoOf    map[cid]string
	groupSet   map[string]map[cid]struct{}
	groups     []string
	protocols  []string
	from, to   string
	days       map[string]map[uint32]struct{}
	seen       map[uint32]struct{}
	gd         map[gdKey]*cell
	gdp        map[gdpKey]*cell
	dp         map[dpKey]*cell
	stats      Stats
}

// New returns a Counter. A contract may be in several groups but in one protocol only; fromDay/toDay ("YYYY-MM-DD",
// inclusive, at most 32 days) are required.
func New(passphrase string, members []Member, protos []ProtocolContract, fromDay, toDay string) (*Counter, error) {
	if passphrase == "" {
		return nil, errors.New("network passphrase is required")
	}
	if len(members) == 0 || len(protos) == 0 {
		return nil, errors.New("at least one group member and one protocol contract are required")
	}
	f, err1 := time.Parse(time.DateOnly, fromDay)
	t, err2 := time.Parse(time.DateOnly, toDay)
	if err1 != nil || err2 != nil {
		return nil, errors.New("from-day and to-day are required (YYYY-MM-DD)")
	}
	if t.Before(f) {
		return nil, errors.New("to-day is before from-day")
	}
	if t.Sub(f) > 31*24*time.Hour {
		return nil, errors.New("at most 32 days per run")
	}
	c := &Counter{
		passphrase: passphrase,
		groupsOf:   map[cid][]string{},
		protoOf:    map[cid]string{},
		groupSet:   map[string]map[cid]struct{}{},
		from:       fromDay,
		to:         toDay,
		days:       map[string]map[uint32]struct{}{},
		seen:       map[uint32]struct{}{},
		gd:         map[gdKey]*cell{},
		gdp:        map[gdpKey]*cell{},
		dp:         map[dpKey]*cell{},
	}
	for _, m := range members {
		if !groupRE.MatchString(m.Group) {
			return nil, fmt.Errorf("invalid group label %q", m.Group)
		}
		id, err := count.ParseContract(m.Contract)
		if err != nil {
			return nil, err
		}
		set := c.groupSet[m.Group]
		if set == nil {
			set = map[cid]struct{}{}
			c.groupSet[m.Group] = set
		}
		if _, dup := set[id]; dup {
			continue
		}
		set[id] = struct{}{}
		c.groupsOf[id] = append(c.groupsOf[id], m.Group)
	}
	protoSet := map[string]struct{}{}
	for _, p := range protos {
		if !protocolRE.MatchString(p.Protocol) {
			return nil, fmt.Errorf("invalid protocol label %q", p.Protocol)
		}
		id, err := count.ParseContract(p.Contract)
		if err != nil {
			return nil, err
		}
		if prev, ok := c.protoOf[id]; ok && prev != p.Protocol {
			return nil, fmt.Errorf("contract %s is listed for protocols %q and %q", p.Contract, prev, p.Protocol)
		}
		c.protoOf[id] = p.Protocol
		protoSet[p.Protocol] = struct{}{}
	}
	if len(c.groupSet) > MaxGroups || len(c.groupsOf) > MaxContracts || len(protoSet) > MaxProtocols ||
		len(c.protoOf) > MaxProtocolContracts {
		return nil, fmt.Errorf("too many groups, contracts or protocols (at most %d, %d, %d, %d)",
			MaxGroups, MaxContracts, MaxProtocols, MaxProtocolContracts)
	}
	for g := range c.groupSet {
		c.groups = append(c.groups, g)
	}
	sort.Strings(c.groups)
	for p := range protoSet {
		c.protocols = append(c.protocols, p)
	}
	sort.Strings(c.protocols)
	return c, nil
}

// Stats returns the run counters.
func (c *Counter) Stats() Stats { return c.stats }

func contractOf(a xdr.ScAddress) (cid, bool) {
	if a.Type != xdr.ScAddressTypeScAddressTypeContract || a.ContractId == nil {
		return cid{}, false
	}
	return cid(*a.ContractId), true
}

// sorobanData returns the transaction's Soroban data (fee-bump: the inner transaction's), if any.
func sorobanData(env xdr.TransactionEnvelope) *xdr.SorobanTransactionData {
	switch env.Type {
	case xdr.EnvelopeTypeEnvelopeTypeTx:
		if env.V1 != nil {
			return env.V1.Tx.Ext.SorobanData
		}
	case xdr.EnvelopeTypeEnvelopeTypeTxFeeBump:
		if env.FeeBump != nil && env.FeeBump.Tx.InnerTx.V1 != nil {
			return env.FeeBump.Tx.InnerTx.V1.Tx.Ext.SorobanData
		}
	}
	return nil
}

// touched returns the contracts one transaction touches (package comment), and whether it is a transaction this
// package considers at all (it has an InvokeHostFunction operation).
func touched(env xdr.TransactionEnvelope) (map[cid]struct{}, bool) {
	set := map[cid]struct{}{}
	invokes := false
	var walk func(inv xdr.SorobanAuthorizedInvocation)
	walk = func(inv xdr.SorobanAuthorizedInvocation) {
		if f := inv.Function; f.Type == xdr.SorobanAuthorizedFunctionTypeSorobanAuthorizedFunctionTypeContractFn && f.ContractFn != nil {
			if id, ok := contractOf(f.ContractFn.ContractAddress); ok {
				set[id] = struct{}{}
			}
		}
		for _, s := range inv.SubInvocations {
			walk(s)
		}
	}
	for _, op := range env.Operations() {
		if op.Body.Type != xdr.OperationTypeInvokeHostFunction || op.Body.InvokeHostFunctionOp == nil {
			continue
		}
		invokes = true
		ihf := op.Body.InvokeHostFunctionOp
		if hf := ihf.HostFunction; hf.Type == xdr.HostFunctionTypeHostFunctionTypeInvokeContract && hf.InvokeContract != nil {
			if id, ok := contractOf(hf.InvokeContract.ContractAddress); ok {
				set[id] = struct{}{}
			}
		}
		for _, e := range ihf.Auth {
			walk(e.RootInvocation)
		}
	}
	if !invokes {
		return nil, false
	}
	if sd := sorobanData(env); sd != nil {
		for _, keys := range [][]xdr.LedgerKey{sd.Resources.Footprint.ReadOnly, sd.Resources.Footprint.ReadWrite} {
			for _, k := range keys {
				if k.Type == xdr.LedgerEntryTypeContractData && k.ContractData != nil {
					if id, ok := contractOf(k.ContractData.Contract); ok {
						set[id] = struct{}{}
					}
				}
			}
		}
	}
	return set, true
}

func bump(m *cell, ok bool) {
	m.tx++
	if ok {
		m.ok++
	}
}

// AddLedger counts one ledger. A ledger already seen is skipped; a failing ledger leaves no partial counts behind.
func (c *Counter) AddLedger(lcm xdr.LedgerCloseMeta) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("ledger: unsupported structure: %v", r)
		}
	}()
	seq := lcm.LedgerSequence()
	day := lcm.ClosedAt().UTC().Format(time.DateOnly)
	if day < c.from || day > c.to {
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
	type hit struct {
		groups map[string]struct{}
		protos map[string]map[cid]struct{} // protocol → its contracts touched
		ok     bool
	}
	var hits []hit
	n := lcm.CountTransactions()
	var unmatched, soroban int64
	for i := 0; i < n; i++ {
		res := lcm.TransactionResultPair(i)
		idx, ok := byHash[res.TransactionHash]
		if !ok {
			unmatched++
			continue
		}
		set, considered := touched(envs[idx])
		if !considered {
			continue
		}
		soroban++
		h := hit{groups: map[string]struct{}{}, protos: map[string]map[cid]struct{}{}, ok: res.Successful()}
		for id := range set {
			for _, g := range c.groupsOf[id] {
				h.groups[g] = struct{}{}
			}
			if p, isP := c.protoOf[id]; isP {
				if h.protos[p] == nil {
					h.protos[p] = map[cid]struct{}{}
				}
				h.protos[p][id] = struct{}{}
			}
		}
		if len(h.groups) > 0 || len(h.protos) > 0 {
			hits = append(hits, h)
		}
	}
	seqs[seq] = struct{}{}
	c.seen[seq] = struct{}{}
	c.stats.Ledgers++
	c.stats.Transactions += int64(n)
	c.stats.UnmatchedResults += unmatched
	c.stats.SorobanTransactions += soroban
	for _, h := range hits {
		for p := range h.protos {
			k := dpKey{day, p}
			if c.dp[k] == nil {
				c.dp[k] = &cell{}
			}
			bump(c.dp[k], h.ok)
		}
		if len(h.protos) > 0 {
			c.stats.ProtocolTransactions++
		}
		if len(h.groups) > 0 {
			c.stats.GroupTransactions++
		}
		for g := range h.groups {
			k := gdKey{g, day}
			if c.gd[k] == nil {
				c.gd[k] = &cell{}
			}
			bump(c.gd[k], h.ok)
			own := c.groupSet[g]
			for p, ids := range h.protos {
				other := false
				for id := range ids {
					if _, mine := own[id]; !mine {
						other = true
						break
					}
				}
				if !other {
					continue
				}
				pk := gdpKey{g, day, p}
				if c.gdp[pk] == nil {
					c.gdp[pk] = &cell{}
				}
				bump(c.gdp[pk], h.ok)
			}
		}
	}
	return nil
}

// Result returns the run's lines; hash names the hash of a ledger read (lake.Chain.Hash) for the day anchors.
func (c *Counter) Result(hash func(seq uint32) ([32]byte, bool)) Result {
	var r Result
	days := make([]string, 0, len(c.days))
	for d := range c.days {
		days = append(days, d)
	}
	sort.Strings(days)
	for _, d := range days {
		seqs := c.days[d]
		first, last := ^uint32(0), uint32(0)
		for s := range seqs {
			first, last = min(first, s), max(last, s)
		}
		n := int64(len(seqs))
		_, before := c.seen[first-1]
		_, after := c.seen[last+1]
		line := DayLine{Kind: "day", Day: d, LedgersInDay: n, LedgerFirst: first, LedgerLast: last}
		if n == int64(last)-int64(first)+1 && first > 0 && before && after {
			if h, have := hash(last + 1); have {
				seq, hx := last+1, hex.EncodeToString(h[:])
				line.Complete, line.AnchorLedger, line.AnchorHash = true, &seq, &hx
			}
		}
		r.Days = append(r.Days, line)
	}
	for _, d := range days {
		for _, g := range c.groups {
			l := GroupLine{Kind: "group", Group: g, Day: d}
			if m := c.gd[gdKey{g, d}]; m != nil {
				l.Transactions, l.SuccessfulTransactions = m.tx, m.ok
			}
			r.Groups = append(r.Groups, l)
			for _, p := range c.protocols {
				if m := c.gdp[gdpKey{g, d, p}]; m != nil {
					r.Protocols = append(r.Protocols, ProtocolLine{Kind: "protocol", Group: g, Day: d, Protocol: p,
						Transactions: m.tx, SuccessfulTransactions: m.ok})
				}
			}
		}
		for _, p := range c.protocols {
			l := NetworkLine{Kind: "network", Day: d, Protocol: p}
			if m := c.dp[dpKey{d, p}]; m != nil {
				l.Transactions, l.SuccessfulTransactions = m.tx, m.ok
			}
			r.Network = append(r.Network, l)
		}
	}
	return r
}
