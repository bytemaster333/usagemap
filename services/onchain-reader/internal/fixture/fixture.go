// SPDX-License-Identifier: Apache-2.0

// Package fixture builds synthetic LedgerCloseMeta values for tests: ledgers with InvokeContract transactions
// (plain or fee-bumped, successful or failed) and unrelated payments. Keys are derived from fixed seeds, so fixtures
// are deterministic and contain no real account.
package fixture

import (
	"crypto/sha256"
	"time"

	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

// Passphrase is the network passphrase the fixtures are hashed with.
const Passphrase = network.TestNetworkPassphrase

// ID derives a deterministic 32-byte value from a label.
func ID(label string) [32]byte { return sha256.Sum256([]byte("scf-onchain-fixture/" + label)) }

// ContractStrkey returns the C… strkey of a contract id.
func ContractStrkey(id [32]byte) string {
	s, err := strkey.Encode(strkey.VersionByteContract, id[:])
	if err != nil {
		panic(err)
	}
	return s
}

// AccountStrkey returns the G… strkey of an account key.
func AccountStrkey(id [32]byte) string {
	s, err := strkey.Encode(strkey.VersionByteAccountID, id[:])
	if err != nil {
		panic(err)
	}
	return s
}

// Account returns a plain (non-muxed) account for a key.
func Account(id [32]byte) xdr.MuxedAccount {
	k := xdr.Uint256(id)
	return xdr.MuxedAccount{Type: xdr.CryptoKeyTypeKeyTypeEd25519, Ed25519: &k}
}

// MuxedAccount returns a muxed (M…) account for a key and sub-id.
func MuxedAccount(id [32]byte, sub uint64) xdr.MuxedAccount {
	return xdr.MuxedAccount{
		Type:     xdr.CryptoKeyTypeKeyTypeMuxedEd25519,
		Med25519: &xdr.MuxedAccountMed25519{Id: xdr.Uint64(sub), Ed25519: xdr.Uint256(id)},
	}
}

// Call is one node of a Soroban authorization tree (Tx.Auth): function Function of contract Contract, with the calls
// it makes that need the same authorisation (sub-invocations, made by Contract).
type Call struct {
	Contract [32]byte
	Function string
	Args     []uint32 // distinguishes otherwise equal calls (encoded as ScVal U32)
	Sub      []Call
}

func (c Call) invocation() xdr.SorobanAuthorizedInvocation {
	cid := xdr.ContractId(c.Contract)
	args := make([]xdr.ScVal, 0, len(c.Args))
	for _, a := range c.Args {
		u := xdr.Uint32(a)
		args = append(args, xdr.ScVal{Type: xdr.ScValTypeScvU32, U32: &u})
	}
	inv := xdr.SorobanAuthorizedInvocation{Function: xdr.SorobanAuthorizedFunction{
		Type: xdr.SorobanAuthorizedFunctionTypeSorobanAuthorizedFunctionTypeContractFn,
		ContractFn: &xdr.InvokeContractArgs{
			ContractAddress: xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &cid},
			FunctionName:    xdr.ScSymbol(c.Function),
			Args:            args,
		},
	}}
	for _, s := range c.Sub {
		inv.SubInvocations = append(inv.SubInvocations, s.invocation())
	}
	return inv
}

// Tx describes one transaction of a fixture ledger.
type Tx struct {
	Source   xdr.MuxedAccount
	OpSource *xdr.MuxedAccount // optional operation source
	Contract *[32]byte         // nil → a payment (not an invocation)
	Function string
	Success  bool
	FeeBump  bool
	Seq      int64
	// Auth: the roots of the invocation's authorization entries (source-account credentials); nil → none. Only for
	// an invocation (Contract set).
	Auth []Call
	// Footprint: contracts whose instance entry the transaction's Soroban footprint lists (read-only), as for every
	// contract a transaction runs; nil → no Soroban data. Only for an invocation (Contract set).
	Footprint [][32]byte
}

// sorobanData returns the transaction extension carrying the footprint (instance keys of t.Footprint), or the empty
// extension when there is none.
func (t Tx) sorobanData() xdr.TransactionExt {
	if t.Contract == nil || len(t.Footprint) == 0 {
		return xdr.TransactionExt{V: 0}
	}
	var keys []xdr.LedgerKey
	for _, c := range t.Footprint {
		id := xdr.ContractId(c)
		keys = append(keys, xdr.LedgerKey{Type: xdr.LedgerEntryTypeContractData, ContractData: &xdr.LedgerKeyContractData{
			Contract:   xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &id},
			Key:        xdr.ScVal{Type: xdr.ScValTypeScvLedgerKeyContractInstance},
			Durability: xdr.ContractDataDurabilityPersistent,
		}})
	}
	return xdr.TransactionExt{V: 1, SorobanData: &xdr.SorobanTransactionData{
		Resources: xdr.SorobanResources{Footprint: xdr.LedgerFootprint{ReadOnly: keys}},
	}}
}

func (t Tx) envelope() xdr.TransactionEnvelope {
	var op xdr.Operation
	op.SourceAccount = t.OpSource
	if t.Contract != nil {
		cid := xdr.ContractId(*t.Contract)
		op.Body = xdr.OperationBody{
			Type: xdr.OperationTypeInvokeHostFunction,
			InvokeHostFunctionOp: &xdr.InvokeHostFunctionOp{HostFunction: xdr.HostFunction{
				Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
				InvokeContract: &xdr.InvokeContractArgs{
					ContractAddress: xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &cid},
					FunctionName:    xdr.ScSymbol(t.Function),
				},
			}},
		}
		for _, c := range t.Auth {
			op.Body.InvokeHostFunctionOp.Auth = append(op.Body.InvokeHostFunctionOp.Auth, xdr.SorobanAuthorizationEntry{
				Credentials:    xdr.SorobanCredentials{Type: xdr.SorobanCredentialsTypeSorobanCredentialsSourceAccount},
				RootInvocation: c.invocation(),
			})
		}
	} else {
		op.Body = xdr.OperationBody{
			Type: xdr.OperationTypePayment,
			PaymentOp: &xdr.PaymentOp{
				Destination: Account(ID("payee")),
				Asset:       xdr.Asset{Type: xdr.AssetTypeAssetTypeNative},
				Amount:      1,
			},
		}
	}
	inner := xdr.TransactionV1Envelope{Tx: xdr.Transaction{
		SourceAccount: t.Source,
		Fee:           100,
		SeqNum:        xdr.SequenceNumber(t.Seq),
		Operations:    []xdr.Operation{op},
		Ext:           t.sorobanData(),
	}}
	if !t.FeeBump {
		return xdr.TransactionEnvelope{Type: xdr.EnvelopeTypeEnvelopeTypeTx, V1: &inner}
	}
	return xdr.TransactionEnvelope{
		Type: xdr.EnvelopeTypeEnvelopeTypeTxFeeBump,
		FeeBump: &xdr.FeeBumpTransactionEnvelope{Tx: xdr.FeeBumpTransaction{
			FeeSource: Account(ID("fee-sponsor")),
			Fee:       1000,
			InnerTx:   xdr.FeeBumpTransactionInnerTx{Type: xdr.EnvelopeTypeEnvelopeTypeTx, V1: &inner},
		}},
	}
}

func (t Tx) result(hash [32]byte, innerHash [32]byte) xdr.TransactionResultPair {
	var opRes xdr.OperationResult
	if t.Contract != nil {
		ihf := xdr.InvokeHostFunctionResult{Code: xdr.InvokeHostFunctionResultCodeInvokeHostFunctionTrapped}
		if t.Success {
			h := xdr.Hash{}
			ihf = xdr.InvokeHostFunctionResult{Code: xdr.InvokeHostFunctionResultCodeInvokeHostFunctionSuccess, Success: &h}
		}
		opRes = xdr.OperationResult{Code: xdr.OperationResultCodeOpInner, Tr: &xdr.OperationResultTr{
			Type: xdr.OperationTypeInvokeHostFunction, InvokeHostFunctionResult: &ihf,
		}}
	} else {
		pr := xdr.PaymentResult{Code: xdr.PaymentResultCodePaymentSuccess}
		if !t.Success {
			pr.Code = xdr.PaymentResultCodePaymentUnderfunded
		}
		opRes = xdr.OperationResult{Code: xdr.OperationResultCodeOpInner, Tr: &xdr.OperationResultTr{
			Type: xdr.OperationTypePayment, PaymentResult: &pr,
		}}
	}
	ops := []xdr.OperationResult{opRes}
	if !t.FeeBump {
		code := xdr.TransactionResultCodeTxFailed
		if t.Success {
			code = xdr.TransactionResultCodeTxSuccess
		}
		return xdr.TransactionResultPair{TransactionHash: hash, Result: xdr.TransactionResult{
			FeeCharged: 100, Result: xdr.TransactionResultResult{Code: code, Results: &ops},
		}}
	}
	innerCode, outerCode := xdr.TransactionResultCodeTxFailed, xdr.TransactionResultCodeTxFeeBumpInnerFailed
	if t.Success {
		innerCode, outerCode = xdr.TransactionResultCodeTxSuccess, xdr.TransactionResultCodeTxFeeBumpInnerSuccess
	}
	return xdr.TransactionResultPair{TransactionHash: hash, Result: xdr.TransactionResult{
		FeeCharged: 1000,
		Result: xdr.TransactionResultResult{Code: outerCode, InnerResultPair: &xdr.InnerTransactionResultPair{
			TransactionHash: innerHash,
			Result: xdr.InnerTransactionResult{FeeCharged: 100, Result: xdr.InnerTransactionResultResult{
				Code: innerCode, Results: &ops,
			}},
		}},
	}}
}

// Ledger builds a LedgerCloseMeta (version 1, or 2 when v2 is true) with the given transactions. The transaction set
// lists envelopes in the given order; the processing (result) order is reversed, as apply order differs from set order
// on the network, so the reader must match results to envelopes by hash.
func Ledger(seq uint32, closedAt time.Time, v2 bool, txs []Tx) xdr.LedgerCloseMeta {
	return LedgerFor(Passphrase, seq, closedAt, v2, txs)
}

// LedgerFor is Ledger with the transactions hashed under another network passphrase.
func LedgerFor(passphrase string, seq uint32, closedAt time.Time, v2 bool, txs []Tx) xdr.LedgerCloseMeta {
	envs := make([]xdr.TransactionEnvelope, len(txs))
	results := make([]xdr.TransactionResultPair, len(txs))
	for i, t := range txs {
		envs[i] = t.envelope()
		h, err := network.HashTransactionInEnvelope(envs[i], passphrase)
		if err != nil {
			panic(err)
		}
		var inner [32]byte
		if t.FeeBump {
			inner, err = network.HashTransaction(envs[i].FeeBump.Tx.InnerTx.V1.Tx, passphrase)
			if err != nil {
				panic(err)
			}
		}
		results[len(txs)-1-i] = t.result(h, inner)
	}
	comps := []xdr.TxSetComponent{{
		Type:                  xdr.TxSetComponentTypeTxsetCompTxsMaybeDiscountedFee,
		TxsMaybeDiscountedFee: &xdr.TxSetComponentTxsMaybeDiscountedFee{Txs: envs},
	}}
	txSet := xdr.GeneralizedTransactionSet{V: 1, V1TxSet: &xdr.TransactionSetV1{
		Phases: []xdr.TransactionPhase{{V: 0, V0Components: &comps}},
	}}
	header := xdr.LedgerHeaderHistoryEntry{Header: xdr.LedgerHeader{
		LedgerVersion: 23,
		LedgerSeq:     xdr.Uint32(seq),
		ScpValue:      xdr.StellarValue{CloseTime: xdr.TimePoint(closedAt.Unix())},
	}}
	emptyMeta := func() xdr.TransactionMeta { return xdr.TransactionMeta{V: 0, Operations: &[]xdr.OperationMeta{}} }
	var lcm xdr.LedgerCloseMeta
	if v2 {
		proc := make([]xdr.TransactionResultMetaV1, len(results))
		for i, r := range results {
			proc[i] = xdr.TransactionResultMetaV1{Result: r, TxApplyProcessing: emptyMeta()}
		}
		lcm = xdr.LedgerCloseMeta{V: 2, V2: &xdr.LedgerCloseMetaV2{LedgerHeader: header, TxSet: txSet, TxProcessing: proc}}
	} else {
		proc := make([]xdr.TransactionResultMeta, len(results))
		for i, r := range results {
			proc[i] = xdr.TransactionResultMeta{Result: r, TxApplyProcessing: emptyMeta()}
		}
		lcm = xdr.LedgerCloseMeta{V: 1, V1: &xdr.LedgerCloseMetaV1{LedgerHeader: header, TxSet: txSet, TxProcessing: proc}}
	}
	// Real hashes (header, transaction set, results), as the reader verifies them; Chain links consecutive ledgers.
	if _, err := lake.Seal(&lcm, [32]byte{}); err != nil {
		panic(err)
	}
	return lcm
}

// Chain links consecutive ledgers of ls (ascending by sequence, as built): each ledger that directly follows the
// previous one names that ledger's hash as its predecessor, and its own hash is recomputed (lake.Chain checks this).
func Chain(ls []xdr.LedgerCloseMeta) []xdr.LedgerCloseMeta {
	for i := 1; i < len(ls); i++ {
		if ls[i].LedgerSequence() != ls[i-1].LedgerSequence()+1 {
			continue
		}
		if _, err := lake.Seal(&ls[i], [32]byte(ls[i-1].LedgerHash())); err != nil {
			panic(err)
		}
	}
	return ls
}

// Batch wraps ledgers in a LedgerCloseMetaBatch.
func Batch(ledgers ...xdr.LedgerCloseMeta) xdr.LedgerCloseMetaBatch {
	b := xdr.LedgerCloseMetaBatch{LedgerCloseMetas: ledgers}
	if len(ledgers) > 0 {
		b.StartSequence = xdr.Uint32(ledgers[0].LedgerSequence())
		b.EndSequence = xdr.Uint32(ledgers[len(ledgers)-1].LedgerSequence())
	}
	return b
}
