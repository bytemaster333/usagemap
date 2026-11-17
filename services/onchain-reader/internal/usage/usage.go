// SPDX-License-Identifier: Apache-2.0

// Package usage computes the Ecosystem Usage Map figures (`onchain-reader usage`) from LedgerCloseMeta values: per
// group of contracts (a registry project; the group is an opaque label chosen by the caller) and UTC day, and per
// contract, function and caller kind, plus the weekly active accounts of the SCF Growth Hack definition.
//
// Definitions (documented in the README, section "Usage map"):
//   - an invocation is a top-level InvokeHostFunction operation whose host function is InvokeContract on a requested
//     contract (as in package count); its caller kind is `account` (an operation's source is always an account);
//   - a contract call is a call of a requested contract's function made by another contract, as far as the ledger
//     files show it without diagnostic events: a node of the transaction's Soroban authorization trees that is a
//     sub-invocation, or a root that is not the top-level invocation itself. Only calls that need some address's
//     authorisation appear there, so contract calls are a LOWER BOUND. Equal nodes (same contract, function and
//     arguments) of one transaction count once (two signers authorise the same call);
//   - successful: the transaction succeeded (fee-bump: the inner result);
//   - invoker / active account: the operation's source account, else the transaction's source (fee-bump: the inner
//     transaction's source, never the fee sponsor); muxed accounts count as their underlying account;
//   - weekly active accounts (SCF Growth Hack, official rules: "an active account means the account that initiated
//     at least one operation"): distinct invokers of a group's contracts in one ISO week (Monday 00:00 UTC to Sunday
//     24:00 UTC), counted only for weeks whose seven days are all complete in this run. `active_accounts` counts every
//     operation included in a ledger (a failed transaction's operation was still initiated);
//     `active_accounts_successful` only those of successful transactions — the rules do not say which one SCF means.
//
// Function names are Soroban symbols (public contract interface). A name that is not a valid symbol is counted as
// "(invalid)"; per contract and day at most MaxFunctions names are kept (by calls, then name), the rest are counted as
// "(other)" — anyone can call any name, so the number of rows a run writes stays bounded.
//
// Privacy: invoker keys live only in memory during a run, to count distinct values; they are never returned, logged or
// written; only counts leave the package.
package usage

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

// MaxFunctions is the number of function names kept per contract and day (by calls); the rest are "(other)".
const MaxFunctions = 64

// MaxGroups bounds the groups of one run, MaxContracts the distinct contracts.
const (
	MaxGroups    = 20_000
	MaxContracts = 50_000
)

// Special function names (never valid Soroban symbols, so they cannot collide with a real name).
const (
	OtherFunction   = "(other)"
	InvalidFunction = "(invalid)"
)

var (
	groupRE  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	symbolRE = regexp.MustCompile(`^[A-Za-z0-9_]{1,32}$`)
)

// DayLine describes one UTC day seen by the run (kind "day"): its ledgers, completeness and anchor (as in package
// count: the first ledger after a complete day and its hash; null for an incomplete day).
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

// ContractLine is one requested contract on one day seen (kind "contract"), zero rows included.
type ContractLine struct {
	Kind                    string `json:"kind"`
	Contract                string `json:"contract"`
	Day                     string `json:"day"`
	Invocations             int64  `json:"invocations"`
	SuccessfulInvocations   int64  `json:"successful_invocations"`
	DistinctInvokers        int64  `json:"distinct_invokers"`
	ContractCalls           int64  `json:"contract_calls"`
	SuccessfulContractCalls int64  `json:"successful_contract_calls"`
}

// FunctionLine is one function of a contract by caller kind on one day (kind "function"); only non-zero lines.
type FunctionLine struct {
	Kind            string `json:"kind"`
	Contract        string `json:"contract"`
	Day             string `json:"day"`
	Function        string `json:"function"`
	CallerKind      string `json:"caller_kind"` // "account" | "contract"
	Calls           int64  `json:"calls"`
	SuccessfulCalls int64  `json:"successful_calls"`
}

// GroupLine is one group on one day seen (kind "group"), zero rows included. DistinctInvokers is distinct over all
// the group's contracts (not a sum of the contract lines).
type GroupLine struct {
	Kind                  string `json:"kind"`
	Group                 string `json:"group"`
	Day                   string `json:"day"`
	Invocations           int64  `json:"invocations"`
	SuccessfulInvocations int64  `json:"successful_invocations"`
	DistinctInvokers      int64  `json:"distinct_invokers"`
	ContractCalls         int64  `json:"contract_calls"`
	ContractsInvoked      int64  `json:"contracts_invoked"`
}

// WeekLine is one group in one ISO week whose seven days are all complete in the run (kind "week").
type WeekLine struct {
	Kind                     string `json:"kind"`
	Group                    string `json:"group"`
	WeekStart                string `json:"week_start"` // the Monday
	ActiveAccounts           int64  `json:"active_accounts"`
	ActiveAccountsSuccessful int64  `json:"active_accounts_successful"`
	Invocations              int64  `json:"invocations"`
	SuccessfulInvocations    int64  `json:"successful_invocations"`
	ContractCalls            int64  `json:"contract_calls"`
}

// Result is everything a run outputs, each slice sorted deterministically.
type Result struct {
	Days      []DayLine
	Contracts []ContractLine
	Functions []FunctionLine
	Groups    []GroupLine
	Weeks     []WeekLine
}

// Stats summarises a run without any account data.
type Stats struct {
	Ledgers, DuplicateLedgers, OutOfRangeLedgers, Transactions, UnmatchedResults int64
	Invocations, ContractCalls                                                   int64
}

type cid = [32]byte
type acct = [32]byte

type cdKey struct {
	c   cid
	day string
}

type cdCell struct {
	inv, ok, calls, okCalls int64
	invokers                map[acct]struct{}
}

type fnKey struct {
	fn       string
	contract bool // caller kind contract
}

type fnCell struct{ calls, ok int64 }

type gdKey struct{ group, day string }

type gdCell struct {
	inv, ok, calls int64
	invokers       map[acct]struct{}
	contracts      map[cid]struct{}
}

type gwKey struct{ group, week string }

type gwCell struct {
	inv, ok, calls int64
	all, okOnly    map[acct]struct{}
}

// Counter accumulates the figures. It is not safe for concurrent use.
type Counter struct {
	passphrase string
	strkeys    map[cid]string
	groupsOf   map[cid][]string
	groups     []string
	from, to   string
	days       map[string]map[uint32]struct{}
	seen       map[uint32]struct{}
	cd         map[cdKey]*cdCell
	fn         map[cdKey]map[fnKey]*fnCell
	gd         map[gdKey]*gdCell
	gw         map[gwKey]*gwCell
	stats      Stats
}

// Member is one (group, contract) pair of the run's input.
type Member struct {
	Group    string
	Contract string // C… strkey
}

// New returns a Counter for the given members. passphrase hashes the envelopes (results are matched by hash);
// fromDay/toDay ("YYYY-MM-DD", inclusive) are required: weeks are judged complete within them.
func New(passphrase string, members []Member, fromDay, toDay string) (*Counter, error) {
	if passphrase == "" {
		return nil, errors.New("network passphrase is required")
	}
	if len(members) == 0 {
		return nil, errors.New("at least one group member is required")
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
		return nil, errors.New("at most 32 days per run (distinct sets are held in memory)")
	}
	c := &Counter{
		passphrase: passphrase,
		strkeys:    map[cid]string{},
		groupsOf:   map[cid][]string{},
		from:       fromDay,
		to:         toDay,
		days:       map[string]map[uint32]struct{}{},
		seen:       map[uint32]struct{}{},
		cd:         map[cdKey]*cdCell{},
		fn:         map[cdKey]map[fnKey]*fnCell{},
		gd:         map[gdKey]*gdCell{},
		gw:         map[gwKey]*gwCell{},
	}
	groupSet := map[string]struct{}{}
	pair := map[string]struct{}{}
	for _, m := range members {
		if !groupRE.MatchString(m.Group) {
			return nil, fmt.Errorf("invalid group label %q", m.Group)
		}
		id, err := count.ParseContract(m.Contract)
		if err != nil {
			return nil, err
		}
		if _, dup := pair[m.Group+"/"+m.Contract]; dup {
			continue
		}
		pair[m.Group+"/"+m.Contract] = struct{}{}
		c.strkeys[id] = m.Contract
		c.groupsOf[id] = append(c.groupsOf[id], m.Group)
		groupSet[m.Group] = struct{}{}
	}
	if len(groupSet) > MaxGroups || len(c.strkeys) > MaxContracts {
		return nil, fmt.Errorf("too many groups or contracts (at most %d and %d)", MaxGroups, MaxContracts)
	}
	for g := range groupSet {
		c.groups = append(c.groups, g)
	}
	sort.Strings(c.groups)
	return c, nil
}

// Stats returns the run counters.
func (c *Counter) Stats() Stats { return c.stats }

// isoWeek returns the Monday (YYYY-MM-DD) of the ISO week of day.
func isoWeek(day string) string {
	d, _ := time.Parse(time.DateOnly, day)
	off := (int(d.Weekday()) + 6) % 7 // Monday = 0
	return d.AddDate(0, 0, -off).Format(time.DateOnly)
}

func contractOf(a xdr.ScAddress) (cid, bool) {
	if a.Type != xdr.ScAddressTypeScAddressTypeContract || a.ContractId == nil {
		return cid{}, false
	}
	return cid(*a.ContractId), true
}

func functionName(s xdr.ScSymbol) string {
	if symbolRE.MatchString(string(s)) {
		return string(s)
	}
	return InvalidFunction
}

type subCall struct {
	c  cid
	fn string
}

// contractCalls walks the authorization trees of one invocation and returns the requested contracts' calls made by
// another contract (see the package comment), equal nodes once.
func (c *Counter) contractCalls(op *xdr.InvokeHostFunctionOp, top cid, topFn xdr.ScSymbol) ([]subCall, error) {
	var out []subCall
	seen := map[string]struct{}{}
	var walk func(inv xdr.SorobanAuthorizedInvocation, root bool) error
	walk = func(inv xdr.SorobanAuthorizedInvocation, root bool) error {
		f := inv.Function
		if f.Type == xdr.SorobanAuthorizedFunctionTypeSorobanAuthorizedFunctionTypeContractFn && f.ContractFn != nil {
			if id, ok := contractOf(f.ContractFn.ContractAddress); ok {
				isTop := root && id == top && f.ContractFn.FunctionName == topFn
				if _, want := c.strkeys[id]; want && !isTop {
					b, err := f.ContractFn.MarshalBinary()
					if err != nil {
						return err
					}
					k := string(b)
					if _, dup := seen[k]; !dup {
						seen[k] = struct{}{}
						out = append(out, subCall{id, functionName(f.ContractFn.FunctionName)})
					}
				}
			}
		}
		for _, s := range inv.SubInvocations {
			if err := walk(s, false); err != nil {
				return err
			}
		}
		return nil
	}
	for _, e := range op.Auth {
		if err := walk(e.RootInvocation, true); err != nil {
			return nil, err
		}
	}
	return out, nil
}

type found struct {
	top     bool
	c       cid
	fn      string
	ok      bool
	invoker acct
}

// AddLedger counts one ledger. A ledger already seen (overlapping files) is skipped; a failing ledger leaves no
// partial counts behind.
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
	n := lcm.CountTransactions()
	var fs []found
	var unmatched int64
	for i := 0; i < n; i++ {
		res := lcm.TransactionResultPair(i)
		idx, ok := byHash[res.TransactionHash]
		if !ok {
			unmatched++
			continue
		}
		env := envs[idx]
		txSource := env.SourceAccount()
		success := res.Successful()
		for _, op := range env.Operations() {
			if op.Body.Type != xdr.OperationTypeInvokeHostFunction || op.Body.InvokeHostFunctionOp == nil {
				continue
			}
			ihf := op.Body.InvokeHostFunctionOp
			hf := ihf.HostFunction
			if hf.Type != xdr.HostFunctionTypeHostFunctionTypeInvokeContract || hf.InvokeContract == nil {
				continue
			}
			top, isContract := contractOf(hf.InvokeContract.ContractAddress)
			if !isContract {
				continue
			}
			if _, want := c.strkeys[top]; want {
				src := txSource
				if op.SourceAccount != nil {
					src = *op.SourceAccount
				}
				a := src.ToAccountId()
				fs = append(fs, found{top: true, c: top, fn: functionName(hf.InvokeContract.FunctionName), ok: success,
					invoker: acct(*a.Ed25519)})
			}
			subs, err := c.contractCalls(ihf, top, hf.InvokeContract.FunctionName)
			if err != nil {
				return fmt.Errorf("ledger %d: authorization tree: %w", seq, err)
			}
			for _, s := range subs {
				fs = append(fs, found{c: s.c, fn: s.fn, ok: success})
			}
		}
	}
	seqs[seq] = struct{}{}
	c.seen[seq] = struct{}{}
	c.stats.Ledgers++
	c.stats.Transactions += int64(n)
	c.stats.UnmatchedResults += unmatched
	week := isoWeek(day)
	for _, f := range fs {
		ce := c.cd[cdKey{f.c, day}]
		if ce == nil {
			ce = &cdCell{invokers: map[acct]struct{}{}}
			c.cd[cdKey{f.c, day}] = ce
		}
		fm := c.fn[cdKey{f.c, day}]
		if fm == nil {
			fm = map[fnKey]*fnCell{}
			c.fn[cdKey{f.c, day}] = fm
		}
		fk := fnKey{fn: f.fn, contract: !f.top}
		fc := fm[fk]
		if fc == nil {
			fc = &fnCell{}
			fm[fk] = fc
		}
		fc.calls++
		if f.ok {
			fc.ok++
		}
		if f.top {
			c.stats.Invocations++
			ce.inv++
			if f.ok {
				ce.ok++
			}
			ce.invokers[f.invoker] = struct{}{}
		} else {
			c.stats.ContractCalls++
			ce.calls++
			if f.ok {
				ce.okCalls++
			}
		}
		for _, g := range c.groupsOf[f.c] {
			gc := c.gd[gdKey{g, day}]
			if gc == nil {
				gc = &gdCell{invokers: map[acct]struct{}{}, contracts: map[cid]struct{}{}}
				c.gd[gdKey{g, day}] = gc
			}
			wc := c.gw[gwKey{g, week}]
			if wc == nil {
				wc = &gwCell{all: map[acct]struct{}{}, okOnly: map[acct]struct{}{}}
				c.gw[gwKey{g, week}] = wc
			}
			gc.contracts[f.c] = struct{}{}
			if !f.top {
				gc.calls++
				wc.calls++
				continue
			}
			gc.inv++
			wc.inv++
			gc.invokers[f.invoker] = struct{}{}
			wc.all[f.invoker] = struct{}{}
			if f.ok {
				gc.ok++
				wc.ok++
				wc.okOnly[f.invoker] = struct{}{}
			}
		}
	}
	return nil
}

func dayComplete(seqs map[uint32]struct{}, seen map[uint32]struct{}) (n int64, first, last uint32, complete bool) {
	first, last = ^uint32(0), 0
	for s := range seqs {
		first, last = min(first, s), max(last, s)
	}
	n = int64(len(seqs))
	_, before := seen[first-1]
	_, after := seen[last+1]
	return n, first, last, n == int64(last)-int64(first)+1 && first > 0 && before && after
}

// Result returns the run's lines. hash names the hash of a ledger read (lake.Chain.Hash) for the anchors; a complete
// day whose anchor was not read is reported incomplete.
func (c *Counter) Result(hash func(seq uint32) ([32]byte, bool)) Result {
	var r Result
	days := make([]string, 0, len(c.days))
	for d := range c.days {
		days = append(days, d)
	}
	sort.Strings(days)
	complete := map[string]bool{}
	for _, d := range days {
		n, first, last, ok := dayComplete(c.days[d], c.seen)
		line := DayLine{Kind: "day", Day: d, LedgersInDay: n, LedgerFirst: first, LedgerLast: last}
		if ok {
			if h, have := hash(last + 1); have {
				seq, hx := last+1, hex.EncodeToString(h[:])
				line.Complete, line.AnchorLedger, line.AnchorHash = true, &seq, &hx
			}
		}
		complete[d] = line.Complete
		r.Days = append(r.Days, line)
	}
	type named struct {
		id  cid
		str string
	}
	cs := make([]named, 0, len(c.strkeys))
	for id, s := range c.strkeys {
		cs = append(cs, named{id, s})
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].str < cs[j].str })
	for _, d := range days {
		for _, ct := range cs {
			l := ContractLine{Kind: "contract", Contract: ct.str, Day: d}
			if ce := c.cd[cdKey{ct.id, d}]; ce != nil {
				l.Invocations, l.SuccessfulInvocations = ce.inv, ce.ok
				l.DistinctInvokers = int64(len(ce.invokers))
				l.ContractCalls, l.SuccessfulContractCalls = ce.calls, ce.okCalls
			}
			r.Contracts = append(r.Contracts, l)
			r.Functions = append(r.Functions, c.functions(ct.id, ct.str, d)...)
		}
		for _, g := range c.groups {
			l := GroupLine{Kind: "group", Group: g, Day: d}
			if gc := c.gd[gdKey{g, d}]; gc != nil {
				l.Invocations, l.SuccessfulInvocations, l.ContractCalls = gc.inv, gc.ok, gc.calls
				l.DistinctInvokers = int64(len(gc.invokers))
				l.ContractsInvoked = int64(len(gc.contracts))
			}
			r.Groups = append(r.Groups, l)
		}
	}
	// Weeks: every ISO week whose seven days are all complete in this run.
	from, _ := time.Parse(time.DateOnly, isoWeek(c.from))
	to, _ := time.Parse(time.DateOnly, c.to)
	for w := from; !w.After(to); w = w.AddDate(0, 0, 7) {
		whole := true
		for i := 0; i < 7; i++ {
			if !complete[w.AddDate(0, 0, i).Format(time.DateOnly)] {
				whole = false
				break
			}
		}
		if !whole {
			continue
		}
		ws := w.Format(time.DateOnly)
		for _, g := range c.groups {
			l := WeekLine{Kind: "week", Group: g, WeekStart: ws}
			if wc := c.gw[gwKey{g, ws}]; wc != nil {
				l.ActiveAccounts, l.ActiveAccountsSuccessful = int64(len(wc.all)), int64(len(wc.okOnly))
				l.Invocations, l.SuccessfulInvocations, l.ContractCalls = wc.inv, wc.ok, wc.calls
			}
			r.Weeks = append(r.Weeks, l)
		}
	}
	return r
}

// functions returns the function lines of one contract and day: at most MaxFunctions names (by calls over both caller
// kinds, then name), the rest merged into OtherFunction.
func (c *Counter) functions(id cid, str, day string) []FunctionLine {
	type agg struct {
		name  string
		total int64
	}
	fm := c.fn[cdKey{id, day}]
	totals := map[string]int64{}
	for k, v := range fm {
		totals[k.fn] += v.calls
	}
	if len(totals) == 0 {
		return nil
	}
	names := make([]agg, 0, len(totals))
	for n, t := range totals {
		names = append(names, agg{n, t})
	}
	sort.Slice(names, func(i, j int) bool {
		if names[i].total != names[j].total {
			return names[i].total > names[j].total
		}
		return names[i].name < names[j].name
	})
	keep := map[string]string{}
	for i, a := range names {
		if i < MaxFunctions-1 || len(names) <= MaxFunctions {
			keep[a.name] = a.name
		} else {
			keep[a.name] = OtherFunction
		}
	}
	merged := map[fnKey]*fnCell{}
	for k, v := range fm {
		key := fnKey{keep[k.fn], k.contract}
		m := merged[key]
		if m == nil {
			m = &fnCell{}
			merged[key] = m
		}
		m.calls += v.calls
		m.ok += v.ok
	}
	out := make([]FunctionLine, 0, len(merged))
	for k, v := range merged {
		kind := "account"
		if k.contract {
			kind = "contract"
		}
		out = append(out, FunctionLine{Kind: "function", Contract: str, Day: day, Function: k.fn, CallerKind: kind,
			Calls: v.calls, SuccessfulCalls: v.ok})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Function != out[j].Function {
			return out[i].Function < out[j].Function
		}
		return out[i].CallerKind < out[j].CallerKind
	})
	return out
}
