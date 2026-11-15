// SPDX-License-Identifier: Apache-2.0

package bootstrap

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	seedPW = "seed-interim-password-from-sops"
	provPW = "provisioning-password-from-sops"
	prov   = "scf-provisioner"
)

// fakeUmami emulates the Umami 3.5.0 behaviour measured in S-02 for B1–B5: the seed admin with id SeedAdminID and
// password "umami"; session tokens bound to the password at issue time; an admin cannot delete itself.
type fakeUmami struct {
	mu      sync.Mutex
	users   map[string]*user // by username
	tokens  map[string]string
	n       int
	calls   []string
	failNth map[int]int // call index -> status to answer instead (transient failures)
}

type user struct{ id, pw, role string }

func newFake() *fakeUmami {
	return &fakeUmami{
		users:   map[string]*user{"admin": {id: SeedAdminID, pw: "umami", role: "admin"}},
		tokens:  map[string]string{},
		failNth: map[int]int{},
	}
}

func (f *fakeUmami) issue(u *user) string {
	f.n++
	t := fmt.Sprintf("tok-secret-%d", f.n)
	f.tokens[t] = u.id + "|" + u.pw
	return t
}

func (f *fakeUmami) auth(r *http.Request) *user {
	t := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	v, ok := f.tokens[t]
	if !ok {
		return nil
	}
	for _, u := range f.users {
		if u.id+"|"+u.pw == v {
			return u
		}
	}
	return nil
}

func (f *fakeUmami) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if st, ok := f.failNth[len(f.calls)]; ok {
		w.WriteHeader(st)
		return
	}
	var body map[string]string
	_ = json.NewDecoder(r.Body).Decode(&body)
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == "GET" && r.URL.Path == "/api/heartbeat":
		fmt.Fprint(w, `{"ok":true}`)
	case r.Method == "POST" && r.URL.Path == "/api/auth/login":
		u := f.users[body["username"]]
		if u == nil || u.pw != body["password"] {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":{"message":"Incorrect username and/or password."}}`)
			return
		}
		fmt.Fprintf(w, `{"token":%q,"user":{"id":%q}}`, f.issue(u), u.id)
	case r.Method == "POST" && r.URL.Path == "/api/me/password":
		u := f.auth(r)
		if u == nil {
			w.WriteHeader(401)
			return
		}
		if body["currentPassword"] != u.pw || len(body["newPassword"]) < 8 {
			w.WriteHeader(400)
			return
		}
		u.pw = body["newPassword"]
		fmt.Fprintf(w, `{"token":%q}`, f.issue(u))
	case r.Method == "POST" && r.URL.Path == "/api/users":
		u := f.auth(r)
		if u == nil || u.role != "admin" {
			w.WriteHeader(401)
			return
		}
		if _, exists := f.users[body["username"]]; exists {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":{"message":"User already exists"}}`)
			return
		}
		id := fmt.Sprintf("00000000-0000-4000-8000-%012d", len(f.users))
		f.users[body["username"]] = &user{id: id, pw: body["password"], role: body["role"]}
		fmt.Fprintf(w, `{"id":%q}`, id)
	case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/api/users/"):
		u := f.auth(r)
		if u == nil || u.role != "admin" {
			w.WriteHeader(401)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/api/users/")
		if id == u.id {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":{"message":"You cannot delete yourself."}}`)
			return
		}
		for name, x := range f.users {
			if x.id == id {
				delete(f.users, name)
				fmt.Fprint(w, `{"ok":true}`)
				return
			}
		}
		w.WriteHeader(500) // Umami's prisma delete of a missing row
	default:
		w.WriteHeader(404)
	}
}

func (f *fakeUmami) callLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func run(t *testing.T, f *fakeUmami) (Result, error, string) {
	t.Helper()
	ts := httptest.NewServer(f)
	t.Cleanup(ts.Close)
	u, _ := url.Parse(ts.URL)
	var logs bytes.Buffer
	b := &Bootstrapper{
		Base:   u,
		HTTP:   ts.Client(),
		Logger: slog.New(slog.NewJSONHandler(&logs, nil)),
		Config: Config{SeedPassword: seedPW, ProvisionerUser: prov, ProvisionerPassword: provPW},
		Retry:  RetryPolicy{Initial: time.Millisecond, Max: 5 * time.Millisecond, Deadline: 2 * time.Second},
	}
	res, err := b.Run(t.Context())
	return res, err, logs.String()
}

func assertBootstrapped(t *testing.T, f *fakeUmami) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.users["admin"]; ok {
		t.Fatal("seed admin still exists")
	}
	p := f.users[prov]
	if p == nil || p.pw != provPW || p.role != "admin" {
		t.Fatalf("provisioning admin = %+v", p)
	}
}

func TestFreshBootstrapRunsB1toB5(t *testing.T) {
	f := newFake()
	res, err, logs := run(t, f)
	if err != nil {
		t.Fatal(err)
	}
	assertBootstrapped(t, f)
	want := []string{"B1", "B2", "B3", "P1", "B4", "B5"}
	if strings.Join(res.Steps, ",") != strings.Join(want, ",") {
		t.Fatalf("steps = %v, want %v", res.Steps, want)
	}
	calls := f.callLog()
	if calls[len(calls)-1] != "POST /api/auth/login" {
		t.Fatalf("last call is not the B5 check: %v", calls)
	}
	for _, secret := range []string{seedPW, provPW, "tok-secret", `"umami"`} {
		if strings.Contains(logs, secret) {
			t.Errorf("logs contain %q:\n%s", secret, logs)
		}
	}
}

func TestRerunAfterSuccessIsANoOp(t *testing.T) {
	f := newFake()
	if _, err, _ := run(t, f); err != nil {
		t.Fatal(err)
	}
	res, err, _ := run(t, f)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.Steps, ",") != "P1,B5" {
		t.Fatalf("steps on re-run = %v, want P1,B5 (seed check included)", res.Steps)
	}
	assertBootstrapped(t, f)
}

func TestResumeAfterCrashBetweenB2AndB3(t *testing.T) {
	f := newFake()
	f.users["admin"].pw = seedPW // B2 ran, then the worker died
	res, err, _ := run(t, f)
	if err != nil {
		t.Fatal(err)
	}
	assertBootstrapped(t, f)
	if res.Steps[0] != "B1" || res.Steps[1] != "B3" {
		t.Fatalf("steps = %v, want B1 (with the SOPS password) then B3", res.Steps)
	}
}

func TestResumeAfterCrashBetweenB3AndB4(t *testing.T) {
	f := newFake()
	f.users["admin"].pw = seedPW
	f.users[prov] = &user{id: "00000000-0000-4000-8000-000000000009", pw: provPW, role: "admin"}
	res, err, _ := run(t, f)
	if err != nil {
		t.Fatal(err)
	}
	assertBootstrapped(t, f)
	if strings.Join(res.Steps, ",") != "P1,B4,B5" {
		t.Fatalf("steps = %v, want P1,B4,B5", res.Steps)
	}
}

func TestSeedAdminWithDefaultPasswordAndProvisionerPresent(t *testing.T) {
	// The provisioning admin exists but the seed admin has its default password again (e.g. re-created): B2 and B4
	// are redone before B5.
	f := newFake()
	f.users[prov] = &user{id: "00000000-0000-4000-8000-000000000009", pw: provPW, role: "admin"}
	if _, err, _ := run(t, f); err != nil {
		t.Fatal(err)
	}
	assertBootstrapped(t, f)
}

func TestUnknownStateFailsLoudly(t *testing.T) {
	f := newFake()
	f.users["admin"].pw = "someone-else-changed-it"
	_, err, logs := run(t, f)
	if err == nil {
		t.Fatal("bootstrap succeeded although neither identity could log in")
	}
	if strings.Contains(err.Error(), seedPW) || strings.Contains(logs, seedPW) {
		t.Fatal("error or logs contain a password")
	}
}

func TestTransientFailuresAreRetried(t *testing.T) {
	f := newFake()
	f.failNth[1] = 503 // heartbeat: proxy not ready
	f.failNth[3] = 502 // a login: Umami restarting behind the proxy
	if _, err, _ := run(t, f); err != nil {
		t.Fatal(err)
	}
	assertBootstrapped(t, f)
}

func TestConfigValidation(t *testing.T) {
	for _, c := range []Config{
		{SeedPassword: "short", ProvisionerUser: prov, ProvisionerPassword: provPW},
		{SeedPassword: seedPW, ProvisionerUser: prov, ProvisionerPassword: "short"},
		{SeedPassword: seedPW, ProvisionerUser: "admin", ProvisionerPassword: provPW},
		{SeedPassword: seedPW, ProvisionerUser: "", ProvisionerPassword: provPW},
		{SeedPassword: "umami", ProvisionerUser: prov, ProvisionerPassword: provPW},
		{SeedPassword: seedPW, ProvisionerUser: prov, ProvisionerPassword: seedPW},
	} {
		if err := c.Validate(); err == nil {
			t.Errorf("config %+v accepted", Config{ProvisionerUser: c.ProvisionerUser})
		}
	}
}
