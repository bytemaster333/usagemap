// SPDX-License-Identifier: Apache-2.0

// Package uaclass reduces a raw User-Agent to (browser family, major version, OS family, device class) and maps it
// to a synthetic User-Agent from a fixed template table (wire-formats §c.3, ADR-0007). The raw string never leaves
// the request; only the reduced class and the template are kept.
package uaclass

import (
	"strconv"
	"strings"
)

// Class is the reduced form of a User-Agent.
type Class struct {
	Family string // chrome, edge, firefox, safari, opera, samsung, other
	Major  int    // 0 when unknown
	OS     string // windows, macos, ios, android, linux, chromeos, other
	Device string // desktop, mobile, tablet
}

// String is the `ua_class` of the challenge context (§b.1): ASCII `family/major/os`.
func (c Class) String() string {
	return c.Family + "/" + strconv.Itoa(c.Major) + "/" + c.OS
}

// majorAfter returns the integer that follows marker in ua (e.g. "Chrome/131.0" → 131).
func majorAfter(ua, marker string) (int, bool) {
	i := strings.Index(ua, marker)
	if i < 0 {
		return 0, false
	}
	s := ua[i+len(marker):]
	n := 0
	digits := 0
	for digits < len(s) && digits < 4 && s[digits] >= '0' && s[digits] <= '9' {
		n = n*10 + int(s[digits]-'0')
		digits++
	}
	if digits == 0 || digits == 4 {
		return 0, false
	}
	return n, true
}

// Parse reduces a raw User-Agent. Unknown or unparsable strings give Family "other".
func Parse(ua string) Class {
	c := Class{Family: "other", OS: "other", Device: "desktop"}
	switch {
	case strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPod"):
		c.OS, c.Device = "ios", "mobile"
	case strings.Contains(ua, "iPad"):
		c.OS, c.Device = "ios", "tablet"
	case strings.Contains(ua, "Android"):
		c.OS = "android"
		if strings.Contains(ua, "Mobile") {
			c.Device = "mobile"
		} else {
			c.Device = "tablet"
		}
	case strings.Contains(ua, "Windows NT"):
		c.OS = "windows"
	case strings.Contains(ua, "CrOS"):
		c.OS = "chromeos"
	case strings.Contains(ua, "Macintosh") || strings.Contains(ua, "Mac OS X"):
		c.OS = "macos"
	case strings.Contains(ua, "Linux") || strings.Contains(ua, "X11"):
		c.OS = "linux"
	}
	type rule struct{ marker, family string }
	for _, r := range []rule{
		{"Edg/", "edge"}, {"EdgA/", "edge"}, {"EdgiOS/", "edge"},
		{"OPR/", "opera"}, {"SamsungBrowser/", "samsung"},
		{"FxiOS/", "firefox"}, {"CriOS/", "chrome"},
		{"Firefox/", "firefox"},
		{"Chrome/", "chrome"}, {"Chromium/", "chrome"},
	} {
		if m, ok := majorAfter(ua, r.marker); ok {
			c.Family, c.Major = r.family, m
			return c
		}
	}
	if strings.Contains(ua, "Safari/") {
		if m, ok := majorAfter(ua, "Version/"); ok {
			c.Family, c.Major = "safari", m
		}
	}
	return c
}

// Unknown is the template for every class without its own entry (§c.3). Umami parses it as firefox / Linux.
const Unknown = "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/0.0"

// key of the template table.
type key struct{ family, os, device string }

// templates: synthetic User-Agents with `{M}` replaced by the observed major version. The contract test
// (integration/templates.mjs) asserts Umami 3.5.0 parses each to the intended browser/OS/device, and the bot
// corpus asserts that neither Umami's isbot nor ours matches any of them.
var templates = map[key]string{
	{"chrome", "windows", "desktop"}:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36",
	{"chrome", "macos", "desktop"}:    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36",
	{"chrome", "linux", "desktop"}:    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36",
	{"chrome", "chromeos", "desktop"}: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36",
	{"chrome", "android", "mobile"}:   "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Mobile Safari/537.36",
	{"chrome", "android", "tablet"}:   "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36",
	{"chrome", "ios", "mobile"}:       "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/{M}.0.0.0 Mobile/15E148 Safari/604.1",
	{"chrome", "ios", "tablet"}:       "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/{M}.0.0.0 Mobile/15E148 Safari/604.1",
	{"edge", "windows", "desktop"}:    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36 Edg/{M}.0.0.0",
	{"edge", "macos", "desktop"}:      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36 Edg/{M}.0.0.0",
	{"edge", "android", "mobile"}:     "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Mobile Safari/537.36 EdgA/{M}.0.0.0",
	{"firefox", "windows", "desktop"}: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:{M}.0) Gecko/20100101 Firefox/{M}.0",
	{"firefox", "macos", "desktop"}:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:{M}.0) Gecko/20100101 Firefox/{M}.0",
	{"firefox", "linux", "desktop"}:   "Mozilla/5.0 (X11; Linux x86_64; rv:{M}.0) Gecko/20100101 Firefox/{M}.0",
	{"firefox", "android", "mobile"}:  "Mozilla/5.0 (Android 14; Mobile; rv:{M}.0) Gecko/{M}.0 Firefox/{M}.0",
	{"firefox", "ios", "mobile"}:      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/{M}.0 Mobile/15E148 Safari/605.1.15",
	{"safari", "macos", "desktop"}:    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{M}.0 Safari/605.1.15",
	{"safari", "ios", "mobile"}:       "Mozilla/5.0 (iPhone; CPU iPhone OS {M}_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{M}.0 Mobile/15E148 Safari/604.1",
	{"safari", "ios", "tablet"}:       "Mozilla/5.0 (iPad; CPU OS {M}_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{M}.0 Mobile/15E148 Safari/604.1",
	{"opera", "windows", "desktop"}:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/{M}.0.0.0",
	{"opera", "macos", "desktop"}:     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/{M}.0.0.0",
	{"samsung", "android", "mobile"}:  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/{M}.0 Chrome/131.0.0.0 Mobile Safari/537.36",
	{"samsung", "android", "tablet"}:  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/{M}.0 Chrome/131.0.0.0 Safari/537.36",
}

// Synthetic returns the template User-Agent for a class (§c.3). Classes without a template, or without a plausible
// major version, get Unknown.
func Synthetic(c Class) string {
	t, ok := templates[key{c.Family, c.OS, c.Device}]
	if !ok || c.Major < 1 || c.Major > 999 {
		return Unknown
	}
	return strings.ReplaceAll(t, "{M}", strconv.Itoa(c.Major))
}

// Template is one entry of the table, for the contract test.
type Template struct {
	Family, OS, Device string
	UA                 string // with the given major substituted
}

// Templates lists every template with major substituted (sorted by key), plus the Unknown template last.
func Templates(major int) []Template {
	var out []Template
	for k, t := range templates {
		m := major
		if k.family == "safari" && m > 30 {
			m = 18 // Safari versions are small numbers; keep the contract test realistic
		}
		out = append(out, Template{k.family, k.os, k.device, strings.ReplaceAll(t, "{M}", strconv.Itoa(m))})
	}
	sortTemplates(out)
	return append(out, Template{"other", "other", "desktop", Unknown})
}

func sortTemplates(t []Template) {
	for i := 1; i < len(t); i++ {
		for j := i; j > 0 && less(t[j], t[j-1]); j-- {
			t[j], t[j-1] = t[j-1], t[j]
		}
	}
}

func less(a, b Template) bool {
	if a.Family != b.Family {
		return a.Family < b.Family
	}
	if a.OS != b.OS {
		return a.OS < b.OS
	}
	return a.Device < b.Device
}
