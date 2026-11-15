// SPDX-License-Identifier: Apache-2.0

package appevents

import (
	"os"
	"path/filepath"
	"testing"
)

// The bodies the React Native and Flutter helpers produce (their own tests assert they equal these fixtures) are
// accepted by this parser and judged clean.
func TestSDKFixturesParse(t *testing.T) {
	for _, f := range []string{"mobile-rn", "mobile-flutter"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", f, "test", "fixtures", "batch.json"))
		if err != nil {
			t.Fatal(err)
		}
		batch, err := Parse(b)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if len(batch.Events) != 2 || batch.Events[0].Props["tier"] != "pro" {
			t.Fatalf("%s: %+v", f, batch)
		}
		for _, e := range batch.Events {
			if r := judgeEvent(e); r != "" {
				t.Fatalf("%s: %s dropped: %s", f, e.Name, r)
			}
		}
	}
}
