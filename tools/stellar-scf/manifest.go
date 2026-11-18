// SPDX-License-Identifier: Apache-2.0
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// embeddedReleases is a dated snapshot of the live deployment's released
// tracker versions (releases/usagemap.dev.json). `init` uses it when it may not
// use the network; `init --api` reads the live list.
//
//go:embed releases/usagemap.dev.json
var embeddedReleases []byte

// TrackerFile is one released tracker file.
type TrackerFile struct {
	Profile   string `json:"profile"`
	Path      string `json:"url"` // "/lib/<version>/<profile>.js"
	Integrity string `json:"integrity"`
}

// TrackerVersion is one released tracker version.
type TrackerVersion struct {
	Version string        `json:"version"`
	Status  string        `json:"status"` // active | withdrawn
	Files   []TrackerFile `json:"files"`
}

var (
	reSemver    = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	reIntegrity = regexp.MustCompile(`^sha384-[A-Za-z0-9+/]{64}$`)
)

// ParseVersions reads the three published shapes of the tracker release list:
// the control plane's GET /v1/tracker/versions (array, with status), the edge's
// GET /lib/manifest.json (scf-analytics/tracker-manifests/1) and a single
// release manifest (tracker/releases/<v>/manifest.json). The embedded snapshot
// wraps the first shape in {"versions": […]}.
func ParseVersions(b []byte) ([]TrackerVersion, error) {
	b = []byte(strings.TrimSpace(string(b)))
	if len(b) == 0 {
		return nil, errors.New("empty tracker release list")
	}
	type rawFile struct {
		Profile   string `json:"profile"`
		Path      string `json:"path"`
		URL       string `json:"url"`
		Integrity string `json:"integrity"`
	}
	type rawVersion struct {
		Version string    `json:"version"`
		Status  string    `json:"status"`
		Pattern string    `json:"url_pattern"`
		Files   []rawFile `json:"files"`
	}
	var raws []rawVersion
	if b[0] == '[' {
		if err := json.Unmarshal(b, &raws); err != nil {
			return nil, fmt.Errorf("tracker release list: %w", err)
		}
	} else {
		var obj struct {
			Versions json.RawMessage `json:"versions"`
			rawVersion
		}
		if err := json.Unmarshal(b, &obj); err != nil {
			return nil, fmt.Errorf("tracker release list: %w", err)
		}
		switch {
		case len(obj.Versions) > 0:
			if err := json.Unmarshal(obj.Versions, &raws); err != nil {
				return nil, fmt.Errorf("tracker release list: %w", err)
			}
		case obj.Version != "":
			raws = []rawVersion{obj.rawVersion}
		default:
			return nil, errors.New("not a tracker release list: no versions")
		}
	}
	out := make([]TrackerVersion, 0, len(raws))
	for _, r := range raws {
		if !reSemver.MatchString(r.Version) {
			return nil, fmt.Errorf("tracker release list: bad version %q", r.Version)
		}
		v := TrackerVersion{Version: r.Version, Status: r.Status}
		if v.Status == "" {
			v.Status = "active" // manifests list published versions only
		}
		if v.Status != "active" && v.Status != "withdrawn" {
			return nil, fmt.Errorf("tracker %s: unknown status %q", r.Version, r.Status)
		}
		for _, f := range r.Files {
			if f.Profile != "standard" && f.Profile != "strict" {
				continue // other files (types, maps) are not pinned by a <script>
			}
			if !reIntegrity.MatchString(f.Integrity) {
				return nil, fmt.Errorf("tracker %s/%s: bad integrity", r.Version, f.Profile)
			}
			p := f.URL
			if p == "" {
				p = "/lib/" + r.Version + "/" + f.Profile + ".js"
			}
			v.Files = append(v.Files, TrackerFile{Profile: f.Profile, Path: p, Integrity: f.Integrity})
		}
		out = append(out, v)
	}
	slices.SortFunc(out, func(a, b TrackerVersion) int { return compareSemver(b.Version, a.Version) })
	return out, nil
}

// Pick returns the requested version (or the newest active one when want is
// empty) and its file of the given profile. A withdrawn version is refused.
func Pick(vs []TrackerVersion, want, profile string) (TrackerVersion, TrackerFile, error) {
	for _, v := range vs {
		if want != "" && v.Version != want {
			continue
		}
		if v.Status != "active" {
			if want != "" {
				return v, TrackerFile{}, fmt.Errorf("tracker %s is withdrawn: pick another version", v.Version)
			}
			continue
		}
		for _, f := range v.Files {
			if f.Profile == profile {
				return v, f, nil
			}
		}
		if want != "" {
			return v, TrackerFile{}, fmt.Errorf("tracker %s has no %s profile", v.Version, profile)
		}
	}
	if want != "" {
		return TrackerVersion{}, TrackerFile{}, fmt.Errorf("tracker %s is not a released version", want)
	}
	return TrackerVersion{}, TrackerFile{}, fmt.Errorf("no active tracker version with the %s profile", profile)
}

func compareSemver(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := range 3 {
		x, _ := strconv.Atoi(at(pa, i))
		y, _ := strconv.Atoi(at(pb, i))
		if x != y {
			return x - y
		}
	}
	return 0
}

func at(s []string, i int) string {
	if i < len(s) {
		return s[i]
	}
	return "0"
}

// embeddedHosts are the ingest hosts the embedded snapshot belongs to.
func embeddedHosts() []string {
	var w struct {
		Hosts []string `json:"ingest_hosts"`
	}
	_ = json.Unmarshal(embeddedReleases, &w)
	return w.Hosts
}

// ScriptTag is the pinned tag, byte-for-byte the shape the portal's kit
// generates (control-plane src/onboarding/kit.ts scriptTag).
func ScriptTag(ingest string, f TrackerFile, siteKey string) string {
	src := strings.TrimRight(ingest, "/") + f.Path
	return strings.Join([]string{
		"<script",
		`  src="` + htmlAttr(src) + `"`,
		`  integrity="` + htmlAttr(f.Integrity) + `"`,
		`  crossorigin="anonymous"`,
		`  data-site="` + htmlAttr(siteKey) + `"`,
		"  defer",
		"></script>",
	}, "\n")
}

func htmlAttr(s string) string {
	return strings.NewReplacer("&", "&amp;", `"`, "&quot;", "<", "&lt;", ">", "&gt;").Replace(s)
}
