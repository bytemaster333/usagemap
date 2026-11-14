// SPDX-License-Identifier: Apache-2.0
package collectortests

import (
	"bytes"
	"flag"
	"os"
	"os/exec"
	"testing"
)

var updateGolden = flag.Bool("update", false, "rewrite testdata/components.golden.yaml")

const componentsGolden = "testdata/components.golden.yaml"

// TestBinaryComponents: the built distribution contains exactly the declared
// components (C-107: the Collector binary contains only the declared
// components).
func TestBinaryComponents(t *testing.T) {
	out, err := exec.Command(otelcolBin(t), "components").Output()
	if err != nil {
		t.Fatal(err)
	}
	compareGolden(t, out)
}

func compareGolden(t *testing.T, out []byte) {
	t.Helper()
	if *updateGolden {
		if err := os.WriteFile(componentsGolden, out, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(componentsGolden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, out) {
		t.Fatalf("components differ from %s:\n%s", componentsGolden, out)
	}
}

// TestBinaryValidatesConfig: the shipped configuration is valid for the binary.
func TestBinaryValidatesConfig(t *testing.T) {
	cmd := exec.Command(otelcolBin(t), "validate", "--config", configPath)
	cmd.Env = []string{"SCF_WRITER_ENDPOINT=https://writers.mesh.internal:4319", "SCF_QUEUE_DIR=" + t.TempDir()}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("validate: %v\n%s", err, out)
	}
}
