// SPDX-License-Identifier: Apache-2.0

package lake

import (
	"path/filepath"
	"testing"

	"github.com/stellar/go-stellar-sdk/xdr"
)

// Real mainnet ledgers (internal/fetch/testdata, SOURCE.md): every ledger's header, transaction set and result set
// hashes match, the eight ledgers of the Lightsail batch chain, the AWS one-ledger files of the same range chain with
// each other and with the Lightsail copy.
func TestChainOnRealMainnetLedgers(t *testing.T) {
	ls, err := ReadBatchFile(filepath.Join("..", "fetch", "testdata", "lightsail", "FCEAEFFF--51712000-52223999",
		"FCE7C167--51920536-51920543.xdr.zst"), 0)
	if err != nil {
		t.Fatal(err)
	}
	var c Chain
	for _, l := range ls.LedgerCloseMetas {
		if err := c.Add(l); err != nil {
			t.Fatalf("lightsail %d: %v", l.LedgerSequence(), err)
		}
	}
	if err := c.Verify(); err != nil {
		t.Fatal(err)
	}
	files, err := ListFiles([]string{filepath.Join("..", "fetch", "testdata", "aws-pubnet")})
	if err != nil || len(files) < 4 {
		t.Fatalf("aws files %v %v", files, err)
	}
	var aws Chain
	byHash := map[uint32]xdr.Hash{}
	for _, l := range ls.LedgerCloseMetas {
		byHash[l.LedgerSequence()] = l.LedgerHash()
	}
	for _, f := range files {
		b, err := ReadBatchFile(f, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range b.LedgerCloseMetas {
			if err := aws.Add(l); err != nil {
				t.Fatalf("aws %d: %v", l.LedgerSequence(), err)
			}
			if h, ok := byHash[l.LedgerSequence()]; ok && h != l.LedgerHash() {
				t.Fatalf("ledger %d differs between the stores", l.LedgerSequence())
			}
		}
	}
	if err := aws.Verify(); err != nil {
		t.Fatal(err)
	}
	// a ledger replaced by one with another predecessor breaks the chain
	var broken Chain
	for i, l := range ls.LedgerCloseMetas {
		if i == 3 {
			raw, _ := l.MarshalBinary()
			var x xdr.LedgerCloseMeta
			if err := x.UnmarshalBinary(raw); err != nil {
				t.Fatal(err)
			}
			if _, err := Seal(&x, [32]byte{1}); err != nil {
				t.Fatal(err)
			}
			l = x
		}
		if err := broken.Add(l); err != nil {
			t.Fatal(err)
		}
	}
	if err := broken.Verify(); err == nil {
		t.Fatal("a ledger with a foreign predecessor passed")
	}
	// a changed result is detected (the result set no longer matches the header)
	l := ls.LedgerCloseMetas[len(ls.LedgerCloseMetas)-1]
	raw, _ := l.MarshalBinary()
	var forged xdr.LedgerCloseMeta
	if err := forged.UnmarshalBinary(raw); err != nil {
		t.Fatal(err)
	}
	if n := forged.CountTransactions(); n > 0 {
		switch forged.V {
		case 1:
			forged.V1.TxProcessing[0].Result.Result.FeeCharged++
		case 2:
			forged.V2.TxProcessing[0].Result.Result.FeeCharged++
		}
		if _, _, err := CheckLedger(forged); err == nil {
			t.Fatal("a changed result passed")
		}
	}
}
