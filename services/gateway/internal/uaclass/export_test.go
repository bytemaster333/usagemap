// SPDX-License-Identifier: Apache-2.0

package uaclass

import (
	"encoding/json"
	"os"
	"testing"
)

// TestExportTemplates writes the template list as JSON when SCF_EXPORT_TEMPLATES names a file (used to refresh the
// bot-parity corpus and by the integration contract test).
func TestExportTemplates(t *testing.T) {
	out := os.Getenv("SCF_EXPORT_TEMPLATES")
	if out == "" {
		t.Skip("SCF_EXPORT_TEMPLATES not set")
	}
	b, _ := json.MarshalIndent(Templates(131), "", " ")
	if err := os.WriteFile(out, b, 0o644); err != nil {
		t.Fatal(err)
	}
}
