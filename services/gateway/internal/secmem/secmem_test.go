// SPDX-License-Identifier: Apache-2.0

package secmem

import (
	"os"
	"os/exec"
	"testing"
)

func TestSlab(t *testing.T) {
	s, err := New(4)
	if err != nil {
		t.Fatal(err)
	}
	var slots []*Slot
	for i := 0; i < 4; i++ {
		k, err := s.Alloc()
		if err != nil {
			t.Fatal(err)
		}
		for j := range k.Bytes() {
			k.Bytes()[j] = 0xAB
		}
		slots = append(slots, k)
	}
	if _, err := s.Alloc(); err != ErrFull {
		t.Fatalf("expected ErrFull, got %v", err)
	}
	slots[1].Free()
	k, err := s.Alloc()
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range k.Bytes() {
		if b != 0 {
			t.Fatal("freed slot was not zeroed")
		}
	}
	if s.InUse() != 4 {
		t.Fatalf("in use %d", s.InUse())
	}
	if len(k.Bytes()) != KeySize || cap(k.Bytes()) != KeySize {
		t.Fatal("slot slice must be exactly one key")
	}
}

// TestDisableCoreDumps runs in a child process so the test binary itself stays dumpable.
func TestDisableCoreDumps(t *testing.T) {
	if os.Getenv("SECMEM_CHILD") == "1" {
		if err := DisableCoreDumps(); err != nil {
			t.Fatal(err)
		}
		if !CoreDumpsDisabled() {
			t.Fatal("core dumps still enabled")
		}
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestDisableCoreDumps$", "-test.count=1")
	cmd.Env = append(os.Environ(), "SECMEM_CHILD=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
}
