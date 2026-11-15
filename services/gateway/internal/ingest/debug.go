// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"net/http"
	"strings"
)

// DebugHeader explains a response (wire-formats §a.8, C-136, C-137). On a dev request outside debug mode it says only
// `class=dev; reasons=dev_origin[,dev_rate_limited]`; the class and reason codes of any request are shown only while
// the site's debug mode is on. It never carries an identifier, a count, a threshold or another site's data, and it
// never changes the status code (C-39).
const DebugHeader = "X-Scf-Debug"

// Debug classes (§a.8).
const (
	classVerified  = "verified"
	classSuspect   = "suspect"
	classRejected  = "rejected"
	classDropped   = "dropped"
	classDev       = "dev"
	classChallenge = "challenge"
)

func setDebug(w http.ResponseWriter, class string, reasons []string) {
	r := "none"
	if len(reasons) > 0 {
		r = strings.Join(dedupe(reasons), ",")
	}
	w.Header().Set(DebugHeader, "v=1; class="+class+"; reasons="+r)
}

// devHeader is the only header a dev request gets outside debug mode.
func devHeader(w http.ResponseWriter, rateLimited bool) {
	if rateLimited {
		setDebug(w, classDev, []string{"dev_origin", "dev_rate_limited"})
		return
	}
	setDebug(w, classDev, []string{"dev_origin"})
}

func dedupe(v []string) []string {
	seen := map[string]bool{}
	out := v[:0:0]
	for _, x := range v {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// worst tracks the batch's worst event for the debug header: rejected > dropped > suspect > verified.
type worst struct {
	rank    int
	class   string
	reasons []string
}

var classRank = map[string]int{classVerified: 1, classSuspect: 2, classDropped: 3, classRejected: 4}

func (w *worst) see(class string, reasons []string) {
	if r := classRank[class]; r > w.rank {
		w.rank, w.class, w.reasons = r, class, append([]string(nil), reasons...)
	}
}
