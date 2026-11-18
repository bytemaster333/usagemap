// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
)

func TestParseOwner(t *testing.T) {
	for _, tc := range []struct {
		in       string
		uid, gid int
		ok       bool
	}{
		{"65534:65534", 65534, 65534, true},
		{"0:0", 0, 0, true},
		{"1000:2000", 1000, 2000, true},
		{"", 0, 0, false},
		{"65534", 0, 0, false},
		{"nobody:nogroup", 0, 0, false},
		{"-1:5", 0, 0, false},
		{"5:-1", 0, 0, false},
		{"1:2:3", 0, 0, false},
		{"4294967296:1", 0, 0, false},
	} {
		uid, gid, err := parseOwner(tc.in)
		if tc.ok != (err == nil) || (tc.ok && (uid != tc.uid || gid != tc.gid)) {
			t.Errorf("parseOwner(%q) = %d, %d, %v; want %d, %d, ok=%v", tc.in, uid, gid, err, tc.uid, tc.gid, tc.ok)
		}
	}
}

func TestChownCmd(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "vol")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	inner := filepath.Join(target, "inner")
	if err := os.WriteFile(inner, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	me := strconv.Itoa(os.Getuid()) + ":" + strconv.Itoa(os.Getgid())

	// To the caller's own ids: always permitted, so it must succeed without privileges.
	if err := chownCmd([]string{"-owner", me, target}); err != nil {
		t.Fatalf("chown to own ids: %v", err)
	}
	st, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if s := st.Sys().(*syscall.Stat_t); int(s.Uid) != os.Getuid() || int(s.Gid) != os.Getgid() {
		t.Fatalf("owner %d:%d", s.Uid, s.Gid)
	}

	for name, args := range map[string][]string{
		"no owner":      {target},
		"no path":       {"-owner", me},
		"bad owner":     {"-owner", "nobody", target},
		"missing path":  {"-owner", me, filepath.Join(dir, "absent")},
		"relative path": {"-owner", me, "vol"},
	} {
		if err := chownCmd(args); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}

	// A symbolic link is refused, never followed (the init container must not be steered to another path).
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := chownCmd([]string{"-owner", me, link}); err == nil {
		t.Error("symlink: want an error")
	}

	if os.Getuid() != 0 {
		// Without CAP_CHOWN a change to other ids must fail loudly, not silently.
		if err := chownCmd([]string{"-owner", "65534:65534", target}); err == nil {
			t.Error("unprivileged chown to 65534: want an error")
		}
	}
}
