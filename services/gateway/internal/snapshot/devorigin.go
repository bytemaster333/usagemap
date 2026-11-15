// SPDX-License-Identifier: Apache-2.0

package snapshot

import (
	"net/url"
	"strings"
	"time"
)

// Origin is the scheme, host and port of a request's Origin (or Referer) header, lower-case; Port is "" when the
// header carries none.
type Origin struct {
	Scheme, Host, Port string
}

// ParseOrigin parses an Origin header value ("https://host[:port]") or a Referer URL. "null" and values without a
// host are not origins.
func ParseOrigin(raw string) (Origin, bool) {
	if raw == "" || raw == "null" {
		return Origin{}, false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return Origin{}, false
	}
	return Origin{Scheme: strings.ToLower(u.Scheme), Host: strings.ToLower(strings.TrimSuffix(u.Hostname(), ".")), Port: u.Port()}, true
}

// httpsDefault reports an https origin on the default port.
func (o Origin) httpsDefault() bool { return o.Scheme == "https" && (o.Port == "" || o.Port == "443") }

type devKind int

const (
	devLoopback devKind = iota // localhost, 127.0.0.1: any port, http or https
	devExact                   // exact host: https on the default port
	devPattern                 // one `*` in the leftmost label: https on the default port
)

type devOrigin struct {
	kind           devKind
	host           string // loopback/exact host; for a pattern, the labels after the leftmost one (".rest")
	prefix, suffix string // pattern: literal characters around `*` in the leftmost label
}

// compileDevOrigins turns the snapshot's dev_origins entries (wire-formats §a.8, grammar checked by the database)
// into matchers. Entries outside the grammar are ignored (fail closed: such a host is simply not a dev origin).
func compileDevOrigins(entries []string) []devOrigin {
	var out []devOrigin
	for _, e := range entries {
		e = strings.ToLower(strings.TrimSpace(e))
		switch {
		case e == "":
			continue
		case e == "localhost" || e == "127.0.0.1":
			out = append(out, devOrigin{kind: devLoopback, host: e})
		case strings.Count(e, "*") == 1:
			first, rest, ok := strings.Cut(e, ".")
			if !ok || rest == "" || !strings.Contains(first, "*") || strings.Contains(rest, "*") {
				continue // `*` outside the leftmost label, or no label after it
			}
			pre, suf, _ := strings.Cut(first, "*")
			out = append(out, devOrigin{kind: devPattern, host: "." + rest, prefix: pre, suffix: suf})
		case !strings.ContainsAny(e, "*:/"):
			out = append(out, devOrigin{kind: devExact, host: e})
		}
	}
	return out
}

func (d devOrigin) match(o Origin) bool {
	switch d.kind {
	case devLoopback:
		return o.Host == d.host && (o.Scheme == "http" || o.Scheme == "https")
	case devExact:
		return o.Host == d.host && o.httpsDefault()
	default:
		if !o.httpsDefault() || !strings.HasSuffix(o.Host, d.host) {
			return false
		}
		label := strings.TrimSuffix(o.Host, d.host)
		// `*` matches one or more characters of the leftmost label only, never a dot.
		return !strings.Contains(label, ".") && len(label) >= len(d.prefix)+len(d.suffix)+1 &&
			strings.HasPrefix(label, d.prefix) && strings.HasSuffix(label, d.suffix)
	}
}

// DevMatch reports whether the origin matches one of the site's dev origins (§a.8). It does not apply the rule that
// a declared domain wins; IsDev does.
func (s *Site) DevMatch(o Origin) bool {
	for _, d := range s.devOrigins {
		if d.match(o) {
			return true
		}
	}
	return false
}

// IsDev reports whether a request from origin is a dev request of the site: it matches a dev origin and its host is
// not a declared domain of the site (a declared domain always wins, §a.8).
func (s *Site) IsDev(o Origin) bool {
	return s.DevMatch(o) && s.DomainMatch(o.Host) == nil
}

// DebugOn reports whether the site's debug mode is on at now (debug_until in the future, §a.8).
func (s *Site) DebugOn(now time.Time) bool {
	return !s.debugUntil.IsZero() && now.Before(s.debugUntil)
}
