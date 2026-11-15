// SPDX-License-Identifier: Apache-2.0

package trackerfiles

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Fixture writes a dist directory like the tracker build does.
func Fixture(t *testing.T, dir, version string, files map[string]string) {
	t.Helper()
	_ = os.MkdirAll(filepath.Join(dir, version), 0o755)
	var mf []map[string]any
	for name, body := range files {
		_ = os.WriteFile(filepath.Join(dir, version, name), []byte(body), 0o644)
		s256 := sha256.Sum256([]byte(body))
		s384 := sha512.Sum384([]byte(body))
		mf = append(mf, map[string]any{"path": name, "profile": name[:len(name)-3], "bytes": len(body), "gzip_bytes": 1,
			"sha256": hex.EncodeToString(s256[:]), "sha384": base64.StdEncoding.EncodeToString(s384[:]),
			"integrity": "sha384-" + base64.StdEncoding.EncodeToString(s384[:])})
	}
	b, _ := json.Marshal(map[string]any{"version": version, "files": mf})
	_ = os.WriteFile(filepath.Join(dir, version, "manifest.json"), b, 0o644)
}

func TestServe(t *testing.T) {
	dir := t.TempDir()
	Fixture(t, dir, "1.0.0", map[string]string{"standard.js": "/*std*/", "strict.js": "/*strict*/"})
	Fixture(t, dir, "0.9.0", map[string]string{"standard.js": "/*old*/"})
	f, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	h := f.Handler(func(v string) bool { return v == "0.9.0" })
	get := func(path string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
		return rr
	}
	rr := get("/lib/1.0.0/standard.js")
	if rr.Code != 200 || rr.Body.String() != "/*std*/" || rr.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || rr.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("serve: %d %v", rr.Code, rr.Header())
	}
	for path, code := range map[string]int{"/lib/2.0.0/standard.js": 404, "/lib/latest/standard.js": 404, "/lib/1.0.0/standard.js.map": 404, "/lib/0.9.0/standard.js": 410, "/lib/1.0.0/../x": 404, "/lib/manifest.json": 200, "/lib/manifest.json.sig": 404} {
		if got := get(path).Code; got != code {
			t.Errorf("%s: %d, want %d", path, got, code)
		}
	}
	if f.Integrity("1.0.0", "strict.js") == "" {
		t.Fatal("integrity")
	}
	// A file that does not match its manifest is refused at start.
	_ = os.WriteFile(filepath.Join(dir, "1.0.0", "strict.js"), []byte("tampered"), 0o644)
	if _, err := Load(dir); err == nil {
		t.Fatal("tampered file accepted")
	}
}

// TestServeTwoVersionsConcurrently (tracker.intentional-upgrade, C-129): two active versions are served side by side — a tenant that has not
// upgraded keeps its pinned bytes while another site loads the new release — each with its own SRI-checked bytes, under
// concurrent requests (run with -race).
func TestServeTwoVersionsConcurrently(t *testing.T) {
	dir := t.TempDir()
	Fixture(t, dir, "1.0.0", map[string]string{"standard.js": "/*v1.0.0 std*/", "strict.js": "/*v1.0.0 strict*/"})
	Fixture(t, dir, "1.1.0", map[string]string{"standard.js": "/*v1.1.0 std*/", "strict.js": "/*v1.1.0 strict*/"})
	f, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if v := f.Versions(); len(v) != 2 {
		t.Fatalf("versions %v", v)
	}
	if f.Integrity("1.0.0", "standard.js") == f.Integrity("1.1.0", "standard.js") {
		t.Fatal("the two versions must carry different integrity values")
	}
	h := f.Handler(func(string) bool { return false })
	want := map[string]string{
		"/lib/1.0.0/standard.js": "/*v1.0.0 std*/", "/lib/1.0.0/strict.js": "/*v1.0.0 strict*/",
		"/lib/1.1.0/standard.js": "/*v1.1.0 std*/", "/lib/1.1.0/strict.js": "/*v1.1.0 strict*/",
	}
	var wg sync.WaitGroup
	errs := make(chan string, 400)
	for i := 0; i < 50; i++ {
		for path, body := range want {
			wg.Add(1)
			go func(path, body string) {
				defer wg.Done()
				rr := httptest.NewRecorder()
				h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
				if rr.Code != 200 || rr.Body.String() != body {
					errs <- path + ": " + rr.Body.String()
					return
				}
				sum := sha512.Sum384(rr.Body.Bytes())
				name := filepath.Base(path)
				version := filepath.Base(filepath.Dir(path))
				if "sha384-"+base64.StdEncoding.EncodeToString(sum[:]) != f.Integrity(version, name) {
					errs <- path + ": bytes do not match the version's integrity"
				}
			}(path, body)
		}
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
}
