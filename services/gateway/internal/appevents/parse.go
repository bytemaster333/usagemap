// SPDX-License-Identifier: Apache-2.0

package appevents

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"

	"github.com/bytemaster333/usagemap/services/gateway/internal/guard"
)

// Limits of the app-event batch (wire-formats §a.9). The body cap equals the web ingest's (§a.1).
const (
	MaxBody     = 8 << 10
	MaxEvents   = 20
	MaxProps    = 8
	MaxNameLen  = 50
	MaxValueLen = 32
)

var (
	reSiteKey  = regexp.MustCompile(`^[0-9A-Za-z]{22}$`)
	reName     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`) // the tenant custom-event name rule (§a.4)
	rePropKey  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	rePropVal  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`) // closed-enum style: a lower-case token, never free text
	reDigits   = regexp.MustCompile(`[0-9]{6,}`)
	reHexish   = regexp.MustCompile(`^[0-9a-f_]{16,}$`)
	reSession  = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	reAppVer   = regexp.MustCompile(`^([0-9]{1,6}(?:\.[0-9]{1,6}){0,3})(?:[-+][0-9A-Za-z.+-]{1,24})?$`)
	reSDKVer   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}/[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$`)
	platforms  = map[string]bool{"ios": true, "android": true, "web": true}
	tmaClasses = map[string]bool{"android": true, "ios": true, "macos": true, "desktop": true, "web": true, "other": true}
)

var errMalformed = errors.New("malformed")

// Batch is a parsed app-event batch. Platform, versions and the Telegram Mini App class are per batch: they are
// constant for one app process.
type Batch struct {
	SiteKey     string
	Platform    string
	AppVersion  string // numeric core only (suffix such as `-beta.3+build` removed: bounded cardinality)
	SDKVersion  string
	TMAPlatform string // "" unless the batch comes from a Telegram Mini App
	Events      []Event
}

// Event is one app event. Session is the app's random in-memory session id: used only for the node-local distinct
// session count, never stored or forwarded.
type Event struct {
	TsMs    int64
	Session string
	Name    string
	Props   map[string]string
}

type wireBatch struct {
	V           int               `json:"v"`
	K           string            `json:"k"`
	Platform    string            `json:"platform"`
	AppVersion  string            `json:"app_version"`
	SDKVersion  string            `json:"sdk_version"`
	TMAPlatform *string           `json:"tma_platform"`
	Events      []json.RawMessage `json:"events"`
}

type wireEvent struct {
	Ts      *int64          `json:"ts"`
	Session string          `json:"session"`
	Name    string          `json:"name"`
	Props   json.RawMessage `json:"props"`
}

func strict(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.More() {
		return errMalformed
	}
	return nil
}

// Parse validates the shape of a batch (§a.9). Any shape error rejects the whole batch (400): an SDK bug, not data.
// Content checks that depend on the value (unsafe names or values) are per event and done by Judge.
func Parse(body []byte) (Batch, error) {
	var w wireBatch
	if err := strict(body, &w); err != nil {
		return Batch{}, errMalformed
	}
	if w.V != 1 || !reSiteKey.MatchString(w.K) || !platforms[w.Platform] || !reSDKVer.MatchString(w.SDKVersion) {
		return Batch{}, errMalformed
	}
	m := reAppVer.FindStringSubmatch(w.AppVersion)
	if m == nil {
		return Batch{}, errMalformed
	}
	b := Batch{SiteKey: w.K, Platform: w.Platform, AppVersion: m[1], SDKVersion: w.SDKVersion}
	if w.TMAPlatform != nil {
		if !tmaClasses[*w.TMAPlatform] || w.Platform != "web" { // a Mini App is a web page in Telegram's WebView
			return Batch{}, errMalformed
		}
		b.TMAPlatform = *w.TMAPlatform
	}
	if len(w.Events) < 1 || len(w.Events) > MaxEvents {
		return Batch{}, errMalformed
	}
	for _, raw := range w.Events {
		var we wireEvent
		if err := strict(raw, &we); err != nil || we.Ts == nil || !reSession.MatchString(we.Session) {
			return Batch{}, errMalformed
		}
		if len(we.Name) < 1 || len(we.Name) > MaxNameLen || !reName.MatchString(we.Name) {
			return Batch{}, errMalformed
		}
		e := Event{TsMs: *we.Ts, Session: we.Session, Name: we.Name}
		if len(we.Props) > 0 && string(we.Props) != "null" {
			var props map[string]json.RawMessage
			if err := strict(we.Props, &props); err != nil || len(props) > MaxProps {
				return Batch{}, errMalformed
			}
			e.Props = make(map[string]string, len(props))
			for k, v := range props {
				var s string
				if !rePropKey.MatchString(k) || json.Unmarshal(v, &s) != nil || len(s) < 1 || len(s) > MaxValueLen {
					return Batch{}, errMalformed // only strings: numbers, booleans and objects are not enum values
				}
				e.Props[k] = s
			}
		}
		b.Events = append(b.Events, e)
	}
	return b, nil
}

// Drop reasons of a single event (closed set; also the `_dropped/reason` cell values and metric labels).
const (
	DropUnsafe      = "unsafe"      // the name or a property value looks like an identifier or secret
	DropValue       = "value_shape" // a property value is not a lower-case enum token
	DropStale       = "stale"       // ts outside [now − 24 h, now + 5 min]
	DropCardinality = "cardinality" // the site's daily name or cell budget on this node is used up
)

// Names start with a letter or digit (the parser's rule), so the platform's own `_session` and `_dropped` cells can
// never collide with a tenant event.
//
// judgeEvent returns "" for an acceptable event, else its drop reason. Property values must be enum-like tokens: a
// lower-case letter first, then [a-z0-9_], at most 32 characters, no run of ≥ 6 digits and not hex-like. That cannot
// carry a Stellar address (56 upper-case characters), a hash, an e-mail address, a phone number or free text.
func judgeEvent(e Event) string {
	if guard.Unsafe(e.Name) || reDigits.MatchString(e.Name) {
		return DropUnsafe
	}
	for k, v := range e.Props {
		if !rePropVal.MatchString(v) || reHexish.MatchString(v) {
			return DropValue
		}
		if reDigits.MatchString(v) || guard.Unsafe(v) || guard.Unsafe(k) {
			return DropUnsafe
		}
	}
	return ""
}
