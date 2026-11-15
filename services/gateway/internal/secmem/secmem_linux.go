// SPDX-License-Identifier: Apache-2.0

//go:build linux

package secmem

import (
	"golang.org/x/sys/unix"
)

func alloc(size int) ([]byte, bool, error) {
	page := unix.Getpagesize()
	n := (size + page - 1) / page * page
	mem, err := unix.Mmap(-1, 0, n, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_PRIVATE|unix.MAP_ANONYMOUS)
	if err != nil {
		return nil, false, err
	}
	// Never in a core dump, never inherited by a child.
	_ = unix.Madvise(mem, unix.MADV_DONTDUMP)
	_ = unix.Madvise(mem, unix.MADV_DONTFORK)
	locked := unix.Mlock(mem) == nil
	return mem[:size], locked, nil
}

// DisableCoreDumps sets RLIMIT_CORE to 0 and marks the process non-dumpable (no core file, no ptrace attach by
// other processes of the same user, /proc/<pid>/mem unreadable). C-04, C-66.
func DisableCoreDumps() error {
	if err := unix.Setrlimit(unix.RLIMIT_CORE, &unix.Rlimit{Cur: 0, Max: 0}); err != nil {
		return err
	}
	return unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0)
}

// CoreDumpsDisabled reports the current state (for the start-up log and the metrics).
func CoreDumpsDisabled() bool {
	var rl unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_CORE, &rl); err != nil || rl.Cur != 0 {
		return false
	}
	d, err := unix.PrctlRetInt(unix.PR_GET_DUMPABLE, 0, 0, 0, 0)
	return err == nil && d == 0
}
