// SPDX-License-Identifier: Apache-2.0

package config

import (
	"testing"
	"time"
)

func base(t *testing.T) {
	t.Helper()
	t.Setenv("SCF_WRITER_TLS_CERT_FILE", "/x/cert")
	t.Setenv("SCF_WRITER_TLS_KEY_FILE", "/x/key")
	t.Setenv("SCF_WRITER_TLS_CLIENT_CA_FILE", "/x/ca")
	t.Setenv("SCF_WRITER_DATABASE_URL", "postgres://scf_writer@bouncer:6432/scf")
}

// The request budget must stay below the Collector's 15 s exporter timeout,
// and a tenant transaction must fit into it.
func TestWorkTimeoutBounds(t *testing.T) {
	base(t)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.WorkTimeout != 12*time.Second || c.TxTimeout != 10*time.Second {
		t.Fatalf("defaults work %s tx %s", c.WorkTimeout, c.TxTimeout)
	}
	for _, v := range []string{"15s", "60s", "0s", "-1s", "soon"} {
		t.Setenv("SCF_WRITER_WORK_TIMEOUT", v)
		if _, err := Load(); err == nil {
			t.Errorf("SCF_WRITER_WORK_TIMEOUT=%s accepted", v)
		}
	}
	t.Setenv("SCF_WRITER_WORK_TIMEOUT", "8s")
	if _, err := Load(); err == nil {
		t.Error("a 10 s tenant transaction inside an 8 s request budget accepted")
	}
	t.Setenv("SCF_WRITER_TX_TIMEOUT", "5s")
	if c, err := Load(); err != nil || c.WorkTimeout != 8*time.Second {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestWriterRoleOnly(t *testing.T) {
	base(t)
	t.Setenv("SCF_WRITER_DATABASE_URL", "postgres://postgres@pg:5432/scf")
	if _, err := Load(); err == nil {
		t.Fatal("a superuser connection string accepted")
	}
}
