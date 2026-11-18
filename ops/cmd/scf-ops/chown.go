// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// chownCmd hands a freshly created, root-owned named volume to the unprivileged user of the service that writes it
// (vlogs-init in compose.monitoring.yaml: VictoriaLogs runs as 65534). It changes the owner of each given directory
// itself, never recursively and never through a symbolic link. Run as uid 0 with only CAP_CHOWN and no network.
//
//	scf-ops chown -owner UID:GID /abs/path...
func chownCmd(args []string) error {
	fs := flag.NewFlagSet("chown", flag.ContinueOnError)
	owner := fs.String("owner", "", "numeric UID:GID")
	if err := fs.Parse(args); err != nil {
		return err
	}
	uid, gid, err := parseOwner(*owner)
	if err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return errors.New("chown: at least one path is required")
	}
	for _, p := range fs.Args() {
		if !filepath.IsAbs(p) {
			return fmt.Errorf("chown: %q is not an absolute path", p)
		}
		st, err := os.Lstat(p)
		if err != nil {
			return fmt.Errorf("chown: %w", err)
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("chown: %q is a symbolic link", p)
		}
		if err := os.Lchown(p, uid, gid); err != nil {
			return fmt.Errorf("chown: %w", err)
		}
	}
	return nil
}

func parseOwner(s string) (int, int, error) {
	u, g, ok := strings.Cut(s, ":")
	if !ok {
		return 0, 0, fmt.Errorf("chown: -owner %q: want numeric UID:GID", s)
	}
	uid, err1 := strconv.ParseUint(u, 10, 32)
	gid, err2 := strconv.ParseUint(g, 10, 32)
	if err1 != nil || err2 != nil {
		return 0, 0, fmt.Errorf("chown: -owner %q: want numeric UID:GID", s)
	}
	return int(uid), int(gid), nil
}
