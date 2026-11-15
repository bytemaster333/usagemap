// SPDX-License-Identifier: Apache-2.0

// Package bootstrap replaces Umami's seeded default administrator before anything else may use the engine
// (wire-formats §j.2 B1–B5, hardening.md §5.4; C-99, C-104, C-112(7)).
//
//	B1 POST /api/auth/login   admin/umami                 -> token T
//	B2 POST /api/me/password  umami -> <seed password>    -> token T2
//	B3 POST /api/users        <provisioning admin>, role admin
//	P1 POST /api/auth/login   <provisioning admin>        -> token T3
//	B4 DELETE /api/users/41e2b680-648e-4b09-bcd7-3e2b10c06264 (with T3; an admin cannot delete itself)
//	B5 POST /api/auth/login   admin/umami                 -> must be 401 (opens the engine proxy's gate)
//
// It is restartable: both new passwords come from the secret store (SOPS in production, infra/compose/.secrets in
// Compose), never generated here, so a crash between steps never strands an unknown password. On every start it tries
// P1 first and resumes from the first incomplete step. It runs through the engine proxy with the provisioning
// identity's certificate, so its B5 call is what opens the proxy's bootstrap gate.
package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"
)

// SeedAdminID is the id of Umami's seeded admin (prisma/migrations/01_init/migration.sql, identical on every install).
const SeedAdminID = "41e2b680-648e-4b09-bcd7-3e2b10c06264"

const (
	seedUser    = "admin"
	seedDefault = "umami"
	minPassword = 8 // Umami's newPassword minimum (S-02); our secrets are much longer
)

// Config holds the two passwords from the secret store and the provisioning admin's user name.
type Config struct {
	SeedPassword        string // B2: the seed admin's interim password
	ProvisionerUser     string // B3: user name of the provisioning admin
	ProvisionerPassword string // B3: its password
}

// Validate checks the configuration without revealing values.
func (c Config) Validate() error {
	switch {
	case len(c.SeedPassword) < minPassword || c.SeedPassword == seedDefault:
		return errors.New("seed admin password must be at least 8 characters and not the default")
	case len(c.ProvisionerPassword) < minPassword:
		return errors.New("provisioning admin password must be at least 8 characters")
	case c.ProvisionerPassword == c.SeedPassword:
		return errors.New("the two passwords must differ")
	case c.ProvisionerUser == "" || c.ProvisionerUser == seedUser:
		return errors.New("provisioning admin user name must be set and must not be 'admin'")
	}
	return nil
}

// RetryPolicy bounds retries of transient failures (transport errors, 5xx — the proxy answers 502/503 while Umami
// starts).
type RetryPolicy struct {
	Initial  time.Duration
	Max      time.Duration
	Deadline time.Duration // total time budget of the run
}

// Bootstrapper runs B1–B5 against Base (the engine proxy, or Umami directly in tests).
type Bootstrapper struct {
	Base   *url.URL
	HTTP   *http.Client
	Logger *slog.Logger
	Config Config
	Retry  RetryPolicy
}

// Result lists the steps that changed or checked something, in order.
type Result struct {
	Steps []string
}

type apiError struct {
	step   string
	status int
}

func (e *apiError) Error() string {
	return fmt.Sprintf("%s: unexpected HTTP status %d", e.step, e.status)
}

// call performs one request, retrying transient failures. It returns the status and the decoded JSON body.
func (b *Bootstrapper) call(ctx context.Context, step, method, path, token string, body any) (int, map[string]any, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return 0, nil, err
		}
	}
	delay := b.Retry.Initial
	for attempt := 1; ; attempt++ {
		u := *b.Base
		u.Path = path
		req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(payload))
		if err != nil {
			return 0, nil, err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := b.HTTP.Do(req)
		status := 0
		var out map[string]any
		if err == nil {
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			_ = resp.Body.Close()
			status = resp.StatusCode
			_ = json.Unmarshal(raw, &out)
			if status < 500 {
				return status, out, nil
			}
		}
		// transient: transport error or 5xx
		b.Logger.Warn("bootstrap_retry", "step", step, "attempt", attempt, "status", status)
		select {
		case <-ctx.Done():
			return 0, nil, fmt.Errorf("%s: gave up: %w", step, ctx.Err())
		case <-time.After(delay):
		}
		delay *= 2
		if delay > b.Retry.Max {
			delay = b.Retry.Max
		}
	}
}

func (b *Bootstrapper) login(ctx context.Context, step, user, pw string) (string, int, error) {
	st, out, err := b.call(ctx, step, http.MethodPost, "/api/auth/login", "", map[string]string{"username": user, "password": pw})
	if err != nil {
		return "", 0, err
	}
	if st == http.StatusOK {
		tok, _ := out["token"].(string)
		if tok == "" {
			return "", st, &apiError{step, st}
		}
		return tok, st, nil
	}
	return "", st, nil
}

func expect(step string, st int, want ...int) error {
	for _, w := range want {
		if st == w {
			return nil
		}
	}
	return &apiError{step, st}
}

// Run executes the bootstrap, resuming from the first incomplete step.
func (b *Bootstrapper) Run(ctx context.Context) (Result, error) {
	var res Result
	if err := b.Config.Validate(); err != nil {
		return res, err
	}
	if b.Retry.Deadline > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, b.Retry.Deadline)
		defer cancel()
	}
	step := func(name string) {
		res.Steps = append(res.Steps, name)
		b.Logger.Info("bootstrap_step", "step", name)
	}
	c := b.Config

	// Readiness: the heartbeat is on the provisioning identity's allow-list even while the gate is closed.
	st, _, err := b.call(ctx, "heartbeat", http.MethodGet, "/api/heartbeat", "", nil)
	if err != nil {
		return res, err
	}
	if err := expect("heartbeat", st, http.StatusOK); err != nil {
		return res, err
	}

	// P1 first.
	t3, st, err := b.login(ctx, "P1", c.ProvisionerUser, c.ProvisionerPassword)
	if err != nil {
		return res, err
	}
	if st == http.StatusOK {
		step("P1")
		// Seed admin still present with the interim password (crash between B3 and B4)?
		_, sst, err := b.login(ctx, "B4-check", seedUser, c.SeedPassword)
		if err != nil {
			return res, err
		}
		if sst == http.StatusOK {
			if err := b.deleteSeed(ctx, t3, step); err != nil {
				return res, err
			}
		}
	} else {
		if err := expect("P1", st, http.StatusUnauthorized); err != nil {
			return res, err
		}
		// B1: with the default password, or with the interim password when B2 already ran.
		t2 := ""
		t1, st1, err := b.login(ctx, "B1", seedUser, seedDefault)
		if err != nil {
			return res, err
		}
		if st1 == http.StatusOK {
			step("B1")
			if t2, err = b.changeSeedPassword(ctx, t1, step); err != nil {
				return res, err
			}
		} else {
			t2b, st1b, err := b.login(ctx, "B1", seedUser, c.SeedPassword)
			if err != nil {
				return res, err
			}
			if st1b != http.StatusOK {
				return res, errors.New("neither the provisioning admin nor the seed admin can log in " +
					"(seed: default and interim password refused); Umami needs manual recovery, see infra/compose/README.md")
			}
			step("B1")
			t2 = t2b
		}
		// B3
		st3, _, err := b.call(ctx, "B3", http.MethodPost, "/api/users", t2,
			map[string]string{"username": c.ProvisionerUser, "password": c.ProvisionerPassword, "role": "admin"})
		if err != nil {
			return res, err
		}
		if err := expect("B3", st3, http.StatusOK); err != nil {
			return res, err
		}
		step("B3")
		if t3, st, err = b.login(ctx, "P1", c.ProvisionerUser, c.ProvisionerPassword); err != nil {
			return res, err
		}
		if err := expect("P1", st, http.StatusOK); err != nil {
			return res, err
		}
		step("P1")
		if err := b.deleteSeed(ctx, t3, step); err != nil {
			return res, err
		}
	}

	// B5 — and if the seed admin still answers to its default password, redo B2 and B4 first.
	for range 2 {
		tseed, st5, err := b.login(ctx, "B5", seedUser, seedDefault)
		if err != nil {
			return res, err
		}
		if st5 == http.StatusUnauthorized {
			step("B5")
			return res, nil
		}
		if err := expect("B5", st5, http.StatusOK); err != nil {
			return res, err
		}
		b.Logger.Warn("bootstrap_seed_admin_present", "step", "B5")
		if _, err := b.changeSeedPassword(ctx, tseed, step); err != nil {
			return res, err
		}
		if err := b.deleteSeed(ctx, t3, step); err != nil {
			return res, err
		}
	}
	return res, errors.New("B5: the seed admin still logs in with its default password")
}

func (b *Bootstrapper) changeSeedPassword(ctx context.Context, t1 string, step func(string)) (string, error) {
	st, out, err := b.call(ctx, "B2", http.MethodPost, "/api/me/password", t1,
		map[string]string{"currentPassword": seedDefault, "newPassword": b.Config.SeedPassword})
	if err != nil {
		return "", err
	}
	if err := expect("B2", st, http.StatusOK); err != nil {
		return "", err
	}
	step("B2")
	if t2, _ := out["token"].(string); t2 != "" {
		return t2, nil
	}
	t2, st, err := b.login(ctx, "B2", seedUser, b.Config.SeedPassword)
	if err != nil {
		return "", err
	}
	return t2, expect("B2", st, http.StatusOK)
}

func (b *Bootstrapper) deleteSeed(ctx context.Context, t3 string, step func(string)) error {
	st, _, err := b.call(ctx, "B4", http.MethodDelete, "/api/users/"+SeedAdminID, t3, nil)
	if err != nil {
		return err
	}
	if err := expect("B4", st, http.StatusOK); err != nil {
		return err
	}
	step("B4")
	return nil
}
