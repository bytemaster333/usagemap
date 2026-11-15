// SPDX-License-Identifier: Apache-2.0

// Package trackerfiles serves the pinned tracker builds (wire-formats §a.1, ADR-0004, C-37, C-100): the gateway image
// builds `tracker/` from source and ships `dist/<semver>/`; at start every file is read into memory and its SHA-384
// checked against the version's manifest, so the bytes served always match the SRI hash tenants pin. URLs are
// immutable; an unknown version or file is 404, a withdrawn version 410; there is no `latest` alias and no source map.
package trackerfiles

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	reVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	reFile    = regexp.MustCompile(`^(standard|strict)\.js$`)
)

type file struct {
	body []byte
	etag string
	sri  string
}

// Files is the loaded set.
type Files struct {
	files    map[string]map[string]*file // version → name → file
	manifest []byte                      // combined manifest
	sig      []byte                      // manifest.json.sig when the release pipeline provided one
}

type manifestFile struct {
	Path      string `json:"path"`
	Profile   string `json:"profile"`
	Bytes     int    `json:"bytes"`
	GzipBytes int    `json:"gzip_bytes"`
	SHA256    string `json:"sha256"`
	SHA384    string `json:"sha384"`
	Integrity string `json:"integrity"`
}

// Load reads dir/<semver>/manifest.json and the files it lists, verifying sizes and hashes.
func Load(dir string) (*Files, error) {
	f := &Files{files: map[string]map[string]*file{}}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var all []json.RawMessage
	for _, e := range ents {
		if !e.IsDir() || !reVersion.MatchString(e.Name()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name(), "manifest.json"))
		if err != nil {
			return nil, err
		}
		var m struct {
			Version string         `json:"version"`
			Files   []manifestFile `json:"files"`
		}
		if err := json.Unmarshal(raw, &m); err != nil || m.Version != e.Name() {
			return nil, fmt.Errorf("tracker %s: bad manifest", e.Name())
		}
		vf := map[string]*file{}
		for _, mf := range m.Files {
			if !reFile.MatchString(mf.Path) {
				return nil, fmt.Errorf("tracker %s: unexpected file %q", e.Name(), mf.Path)
			}
			body, err := os.ReadFile(filepath.Join(dir, e.Name(), mf.Path))
			if err != nil {
				return nil, err
			}
			s384 := sha512.Sum384(body)
			s256 := sha256.Sum256(body)
			sri := "sha384-" + base64.StdEncoding.EncodeToString(s384[:])
			if len(body) != mf.Bytes || hex.EncodeToString(s256[:]) != mf.SHA256 || sri != mf.Integrity {
				return nil, fmt.Errorf("tracker %s/%s: bytes do not match the manifest", e.Name(), mf.Path)
			}
			vf[mf.Path] = &file{body: body, etag: `"` + hex.EncodeToString(s256[:]) + `"`, sri: sri}
		}
		f.files[e.Name()] = vf
		all = append(all, raw)
	}
	if len(f.files) == 0 {
		return nil, fmt.Errorf("no tracker versions in %s", dir)
	}
	f.manifest, _ = json.MarshalIndent(map[string]any{"schema": "scf-analytics/tracker-manifests/1", "versions": all}, "", " ")
	if sig, err := os.ReadFile(filepath.Join(dir, "manifest.json.sig")); err == nil {
		f.sig = sig
	}
	return f, nil
}

// Versions lists the loaded versions.
func (f *Files) Versions() []string {
	var v []string
	for k := range f.files {
		v = append(v, k)
	}
	sort.Strings(v)
	return v
}

// Integrity returns the SRI string of a file ("" if unknown).
func (f *Files) Integrity(version, name string) string {
	if x := f.files[version][name]; x != nil {
		return x.sri
	}
	return ""
}

// Handler serves GET/HEAD /lib/… . withdrawn reports a withdrawn version (from the snapshot).
func (f *Files) Handler(withdrawn func(version string) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, "/lib/")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		switch rest {
		case "manifest.json":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "public, max-age=300")
			_, _ = w.Write(f.manifest)
			return
		case "manifest.json.sig":
			if f.sig == nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(f.sig)
			return
		}
		version, name, ok := strings.Cut(rest, "/")
		x := f.files[version][name]
		if !ok || x == nil {
			http.NotFound(w, r)
			return
		}
		if withdrawn != nil && withdrawn(version) {
			http.Error(w, "withdrawn", http.StatusGone)
			return
		}
		h := w.Header()
		h.Set("Content-Type", "text/javascript; charset=utf-8")
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
		h.Set("Access-Control-Allow-Origin", "*") // SRI with crossorigin="anonymous" needs CORS
		h.Set("Cross-Origin-Resource-Policy", "cross-origin")
		h.Set("ETag", x.etag)
		if r.Header.Get("If-None-Match") == x.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		h.Set("Content-Length", fmt.Sprint(len(x.body)))
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(x.body)
	})
}
