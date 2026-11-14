// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/collector/client"
)

// Request metadata set by the gateway (wire-formats §f.4). The otlp receiver
// turns HTTP headers and gRPC metadata alike into client.Info.Metadata when
// include_metadata is true; Get is case-insensitive.
const (
	MetaTenantID        = "x-scf-tenant-id"
	MetaAllowedServices = "x-scf-allowed-services"
	MetaReceivedAt      = "x-scf-received-at"
	// MetaTenantLevel is the tenant's verification level from the edge
	// snapshot (C-116): exactly one of "L0"…"L3".
	MetaTenantLevel = "x-scf-tenant-level"
)

// Why a request carries no scf.tenant.level (self-metric attribute "reason").
const (
	levelMissing = "missing" // header absent
	levelInvalid = "invalid" // repeated, or not exactly L0…L3
)

// requestMeta is what the sanitise step takes from one request's metadata.
type requestMeta struct {
	tenant     string              // canonical lower-case UUID
	allowAll   bool                // x-scf-allowed-services is "*"
	allowed    map[string]struct{} // decoded service names; empty = none allowed
	receivedAt int64               // Unix ns: gateway receipt time, or the Collector's clock as fallback
	// receivedAtFallback is true when x-scf-received-at was missing or invalid
	// and the Collector's clock was used instead.
	receivedAtFallback bool
	// level is the tenant level 0…3 when hasLevel; otherwise levelAbsent says
	// why ("missing" or "invalid") and scf.tenant.level is not stamped.
	level       int64
	hasLevel    bool
	levelAbsent string
}

// parseMeta reads the gateway metadata. ok is false when there is no valid
// tenant id: the request cannot be attributed and is dropped whole.
func parseMeta(md client.Metadata, now time.Time) (rm requestMeta, ok bool) {
	tenant, ok := single(md, MetaTenantID)
	if !ok {
		return rm, false
	}
	if rm.tenant, ok = canonicalUUID(tenant); !ok {
		return rm, false
	}

	if v, ok := single(md, MetaAllowedServices); ok {
		if strings.TrimSpace(v) == "*" {
			rm.allowAll = true
		} else {
			rm.allowed = parseAllowed(v)
		}
	} // missing or repeated header: fail closed, no service allowed

	rm.receivedAt = now.UnixNano()
	rm.receivedAtFallback = true
	if v, ok := single(md, MetaReceivedAt); ok {
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil && n > 0 {
			rm.receivedAt = n
			rm.receivedAtFallback = false
		}
	}

	rm.level, rm.hasLevel, rm.levelAbsent = parseLevel(md)
	return rm, true
}

// parseLevel reads x-scf-tenant-level: exactly one value "L0"…"L3" (upper-case
// L, one digit); anything else leaves the level absent, so the writer applies
// no level-specific cap rather than a wrong one.
func parseLevel(md client.Metadata) (int64, bool, string) {
	v := md.Get(MetaTenantLevel)
	if len(v) == 0 {
		return 0, false, levelMissing
	}
	if len(v) != 1 || len(v[0]) != 2 || v[0][0] != 'L' || v[0][1] < '0' || v[0][1] > '3' {
		return 0, false, levelInvalid
	}
	return int64(v[0][1] - '0'), true, ""
}

// single returns the only value of key; a missing or repeated key is not ok.
func single(md client.Metadata, key string) (string, bool) {
	v := md.Get(key)
	if len(v) != 1 || v[0] == "" {
		return "", false
	}
	return v[0], true
}

// parseAllowed decodes the comma list of percent-encoded service names (C-70).
func parseAllowed(v string) map[string]struct{} {
	out := make(map[string]struct{})
	for part := range strings.SplitSeq(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, err := url.PathUnescape(part)
		if err != nil || name == "" {
			continue
		}
		out[name] = struct{}{}
	}
	return out
}

func (rm *requestMeta) serviceAllowed(name string) bool {
	if rm.allowAll {
		return true
	}
	_, ok := rm.allowed[name]
	return ok
}

// canonicalUUID accepts the 8-4-4-4-12 hexadecimal form in any case and
// returns it in lower case.
func canonicalUUID(s string) (string, bool) {
	if len(s) != 36 {
		return "", false
	}
	b := []byte(s)
	for i, c := range b {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return "", false
			}
			continue
		}
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f':
		case c >= 'A' && c <= 'F':
			b[i] = c + ('a' - 'A')
		default:
			return "", false
		}
	}
	return string(b), true
}
