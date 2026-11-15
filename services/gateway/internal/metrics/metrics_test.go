// SPDX-License-Identifier: Apache-2.0

package metrics

import (
	"strings"
	"testing"
)

func TestWrite(t *testing.T) {
	r := New()
	r.Help("x_total", "counter", "X.")
	r.Add("x_total", 2, "a", "b")
	r.Observe("d_seconds", []float64{0.1, 1}, 0.5)
	r.GaugeFunc(func(emit func(string, string, float64)) { emit("g", Labels("k", "v"), 3) })
	var b strings.Builder
	r.Write(&b)
	out := b.String()
	for _, want := range []string{"# TYPE x_total counter", `x_total{a="b"} 2`, `d_seconds_bucket{le="0.1"} 0`, `d_seconds_bucket{le="1"} 1`, "d_seconds_count 1", `g{k="v"} 3`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if r.Get("x_total", "a", "b") != 2 {
		t.Fatal("Get")
	}
}
