// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"bufio"
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// contextBypass matches the strings C-103 bans outside db/: a direct set_config( call and SET / SET LOCAL /
// SET SESSION / RESET of an app.* setting. Case-insensitive, like SQL.
var contextBypass = regexp.MustCompile(`(?i)\bset_config\s*\(|\b(?:set|reset)\s+(?:local\s+|session\s+)?app\.`)

// lintSkipRoots are top-level directories never scanned: db/ (migrations and gate tests are the one place allowed to
// set context), documentation and research (prose about the rule) and throwaway spikes. A directory named db/ deeper
// in the tree (e.g. a service's repository package) IS scanned.
var lintSkipRoots = map[string]bool{"db": true, "docs": true, "references": true, "spikes": true}

// lintSkipDirs are skipped at any depth: VCS metadata, third-party and generated trees.
var lintSkipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, ".next": true, "coverage": true, ".turbo": true,
	".venv": true, "__pycache__": true, // local Python virtualenvs and bytecode (git-ignored)
}

// lintExtensions are the source and configuration files the rule applies to.
var lintExtensions = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".mts": true, ".cts": true, ".js": true, ".mjs": true, ".cjs": true,
	".jsx": true, ".py": true, ".sql": true, ".sh": true, ".rs": true, ".java": true, ".kt": true, ".cs": true,
	".yaml": true, ".yml": true, ".json": true, ".toml": true, ".j2": true, ".tf": true, ".tofu": true,
}

// Finding is one banned string in a source file.
type Finding struct {
	Path string // relative to the scanned root, slash-separated
	Line int
	Text string
}

// ScanContextBypass walks root and reports every line outside the skipped directories that sets tenant context
// without scf.set_tenant_ctx() (docs/data-model.md §4.1, C-103). Files larger than 4 MiB or containing NUL bytes
// are treated as binary and skipped.
func ScanContextBypass(root string) ([]Finding, error) {
	var out []Finding
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == root {
				return nil
			}
			if lintSkipDirs[d.Name()] || (filepath.Dir(path) == filepath.Clean(root) && lintSkipRoots[d.Name()]) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || !lintExtensions[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > 4<<20 {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if bytes.IndexByte(data, 0) >= 0 {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		sc := bufio.NewScanner(bytes.NewReader(data))
		sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
		for n := 1; sc.Scan(); n++ {
			if line := sc.Text(); contextBypass.MatchString(line) && !commentOnly(line) {
				out = append(out, Finding{Path: filepath.ToSlash(rel), Line: n, Text: strings.TrimSpace(line)})
			}
		}
		return sc.Err()
	})
	return out, err
}

// commentOnly reports a line that is entirely a comment (//, /*, *, #, --): prose about the rule, not code that
// could run. A banned string after code on the same line is still reported.
func commentOnly(line string) bool {
	l := strings.TrimSpace(line)
	for _, p := range []string{"//", "/*", "*", "#", "--"} {
		if strings.HasPrefix(l, p) {
			return true
		}
	}
	return false
}
