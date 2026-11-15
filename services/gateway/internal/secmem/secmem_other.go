// SPDX-License-Identifier: Apache-2.0

//go:build !linux

package secmem

import "errors"

func alloc(size int) ([]byte, bool, error) { return make([]byte, size), false, nil }

// DisableCoreDumps is only implemented on Linux, the only supported production platform.
func DisableCoreDumps() error { return errors.New("secmem: core dumps can only be disabled on Linux") }

// CoreDumpsDisabled reports false off Linux.
func CoreDumpsDisabled() bool { return false }
