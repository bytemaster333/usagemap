// SPDX-License-Identifier: Apache-2.0

package config

import (
	"strings"
	"testing"
)

func base(t *testing.T) {
	t.Helper()
	for k, v := range map[string]string{"GW_NODE_ID": "edge-a1", "GW_ALLOW_PLAINTEXT": "1", "GW_NODE_CERT": "c", "GW_NODE_KEY": "k",
		"GW_CA": "ca", "GW_CORES": "core-1=https://core-1:8443", "GW_SNAPSHOT_KEYS": "k=/x", "GW_OTLP_ENABLED": "0"} {
		t.Setenv(k, v)
	}
}

// The per-site spool share and the OTLP concurrency bounds default to safe
// values and are validated.
func TestSpoolShareAndOTLPBounds(t *testing.T) {
	base(t)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.SpoolSiteShare != c.SpoolMaxBytes/4 || c.OTLPMaxInflight != 16 || c.OTLPTenantFlight != 4 {
		t.Fatalf("defaults %d %d %d", c.SpoolSiteShare, c.OTLPMaxInflight, c.OTLPTenantFlight)
	}
	for k, v := range map[string]string{"GW_SPOOL_SITE_SHARE_BYTES": "1", "GW_OTLP_MAX_INFLIGHT": "0", "GW_OTLP_MAX_INFLIGHT_TENANT": "999"} {
		base(t)
		t.Setenv(k, v)
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), k) {
			t.Errorf("%s=%s accepted: %v", k, v, err)
		}
	}
}
