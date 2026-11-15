// SPDX-License-Identifier: Apache-2.0

package config

import (
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func base() map[string]string {
	return map[string]string{"EP_TLS_CERT": "/c", "EP_TLS_KEY": "/k", "EP_CLIENT_CA": "/ca"}
}

func TestDefaults(t *testing.T) {
	c, err := Load(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != ":8443" || c.MetricsAddr != ":9464" || c.UmamiURL.String() != "http://umami:3000" ||
		c.ControlPlaneURL != nil || c.MaxEntries != 500_000 || c.UpstreamTimeout != 30*time.Second ||
		c.GateProbeClosed != 2*time.Second || c.GateProbeOpen != time.Minute ||
		c.ProvisionerUser != "scf-provisioner" || c.ProvisionerPasswordFile != "" {
		t.Fatalf("defaults = %+v", c)
	}
}

func TestOverrides(t *testing.T) {
	m := base()
	m["EP_CONTROL_PLANE_URL"] = "http://control-plane:8080"
	m["EP_MAX_ENTRIES"] = "1000"
	m["EP_LOG_LEVEL"] = "debug"
	m["EP_PROVISIONER_USER"] = "prov-a"
	m["EP_PROVISIONER_PASSWORD_FILE"] = "/run/secrets/p"
	c, err := Load(env(m))
	if err != nil {
		t.Fatal(err)
	}
	if c.ControlPlaneURL.String() != "http://control-plane:8080" || c.MaxEntries != 1000 || c.LogLevel.String() != "DEBUG" ||
		c.ProvisionerUser != "prov-a" || c.ProvisionerPasswordFile != "/run/secrets/p" {
		t.Fatalf("overrides = %+v", c)
	}
}

func TestInvalid(t *testing.T) {
	for k, v := range map[string]string{
		"EP_UMAMI_URL":         "umami:3000",
		"EP_CONTROL_PLANE_URL": "http://cp:8080/internal",
		"EP_MAX_ENTRIES":       "0",
		"EP_UPSTREAM_TIMEOUT":  "-1s",
		"EP_LOG_LEVEL":         "loud",
		"EP_TLS_CERT":          "",
	} {
		m := base()
		m[k] = v
		if _, err := Load(env(m)); err == nil {
			t.Errorf("%s=%q accepted", k, v)
		}
	}
}

func TestHTTPSControlPlaneNeedsClientCertificate(t *testing.T) {
	m := base()
	m["EP_CONTROL_PLANE_URL"] = "https://control-plane:8081"
	if _, err := Load(env(m)); err == nil {
		t.Fatal("https control plane without client certificate accepted")
	}
	m["EP_CONTROL_PLANE_TLS_CERT"], m["EP_CONTROL_PLANE_TLS_KEY"], m["EP_CONTROL_PLANE_TLS_CA"] = "/c", "/k", "/ca"
	if _, err := Load(env(m)); err != nil {
		t.Fatal(err)
	}
}

func TestDedupSettings(t *testing.T) {
	c, err := Load(env(base()))
	if err != nil || c.DedupWindow != time.Hour || c.DedupMaxEntries != 500_000 {
		t.Fatalf("defaults %v %d %v", c.DedupWindow, c.DedupMaxEntries, err)
	}
	m := base()
	m["EP_DEDUP_WINDOW"] = "30m"
	m["EP_DEDUP_MAX_ENTRIES"] = "1000"
	if c, err := Load(env(m)); err != nil || c.DedupWindow != 30*time.Minute || c.DedupMaxEntries != 1000 {
		t.Fatalf("overrides %v %d %v", c.DedupWindow, c.DedupMaxEntries, err)
	}
	for k, v := range map[string]string{"EP_DEDUP_WINDOW": "-1s", "EP_DEDUP_MAX_ENTRIES": "0"} {
		m := base()
		m[k] = v
		if _, err := Load(env(m)); err == nil {
			t.Errorf("%s=%s accepted", k, v)
		}
	}
}
