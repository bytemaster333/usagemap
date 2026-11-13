// SPDX-License-Identifier: Apache-2.0
package pathnorm

import "fmt"

// RuleSetVersion identifies this rule set. It is stored next to every
// normalised route (scf.rules_version, pathnorm_rules_version). Any change to
// an output of the corpus requires a new version (README.md, "Versioning").
const RuleSetVersion = "scf-path-rules/1.1.0"

// InputKind says where the input string comes from.
type InputKind uint8

const (
	// InputPath is a raw API path: span url.path, legacy http.target, or the
	// path of url.full / http.url (absolute-form is accepted).
	InputPath InputKind = iota
	// InputRoute is a tenant-supplied http.route template: framework
	// placeholders are canonicalised, literal segments still pass every rule.
	InputRoute
	// InputWebPage is a web page path received by the gateway. The rules are
	// those of InputPath; Options.Folding applies.
	InputWebPage
)

func (k InputKind) String() string {
	switch k {
	case InputPath:
		return "path"
	case InputRoute:
		return "route"
	case InputWebPage:
		return "web_page"
	}
	return fmt.Sprintf("InputKind(%d)", uint8(k))
}

// Folding is the per-site page-path folding setting (sites.path_folding,
// C-52, C-70, C-89).
type Folding uint8

const (
	// FoldingFull applies every rule (default).
	FoldingFull Folding = iota
	// FoldingRelaxed keeps numbers, dates and slugs literal. StrKeys, hashes,
	// UUIDs, tokens and other identifiers are still folded, and secrets and
	// personal identifiers are still redacted: redaction cannot be relaxed.
	FoldingRelaxed
)

func (f Folding) String() string {
	switch f {
	case FoldingFull:
		return "full"
	case FoldingRelaxed:
		return "relaxed"
	}
	return fmt.Sprintf("Folding(%d)", uint8(f))
}

// ParseFolding parses the stored setting value ("full" or "relaxed").
func ParseFolding(s string) (Folding, error) {
	switch s {
	case "full", "":
		return FoldingFull, nil
	case "relaxed":
		return FoldingRelaxed, nil
	}
	return FoldingFull, fmt.Errorf("pathnorm: unknown folding %q (want full or relaxed)", s)
}

// Options selects the input kind and the folding setting. The zero value is
// InputPath with FoldingFull.
type Options struct {
	Input   InputKind
	Folding Folding
}

// Kind is the kind of a redacted value. Values themselves, prefixes and
// hashes of them are never recorded — only counts per kind and location.
type Kind uint8

const (
	KindStellarSeed Kind = iota // Stellar secret seed (S…)
	KindJWT                     // JSON Web Token
	KindAPIKey                  // API-key-shaped string (sk_live_…, ghp_…, AKIA…, …)
	KindEmail                   // e-mail address
	KindFederation              // federation address name*domain
	KindPhone                   // phone number with +
	KindIP                      // IPv4 / IPv6 literal
	numKinds
)

var kindNames = [numKinds]string{"stellar_seed", "jwt", "api_key", "email", "federation", "phone", "ip"}

func (k Kind) String() string {
	if k < numKinds {
		return kindNames[k]
	}
	return fmt.Sprintf("Kind(%d)", uint8(k))
}

// Class is "secret" (rotate the credential) or "pii" (personal identifier).
func (k Kind) Class() string {
	if k <= KindAPIKey {
		return "secret"
	}
	return "pii"
}

// Location is where a redacted value was found.
type Location uint8

const (
	LocPath  Location = iota // a path segment (path and web-page inputs)
	LocQuery                 // the query string, fragment or a ;matrix parameter (dropped; counted only)
	LocRoute                 // a literal segment of a tenant http.route
	numLocations
)

var locationNames = [numLocations]string{"path", "query", "route"}

func (l Location) String() string {
	if l < numLocations {
		return locationNames[l]
	}
	return fmt.Sprintf("Location(%d)", uint8(l))
}

// Redactions counts redactions by kind and location.
type Redactions struct {
	n [numKinds][numLocations]uint32
}

func (r *Redactions) add(k Kind, l Location) { r.n[k][l]++ }

// Count returns the number of redactions of kind k at location l.
func (r Redactions) Count(k Kind, l Location) int { return int(r.n[k][l]) }

// ByKind returns the number of redactions of kind k at any location.
func (r Redactions) ByKind(k Kind) int {
	t := 0
	for _, c := range r.n[k] {
		t += int(c)
	}
	return t
}

// Total returns the number of redactions.
func (r Redactions) Total() int {
	t := 0
	for k := range r.n {
		for _, c := range r.n[k] {
			t += int(c)
		}
	}
	return t
}

// Each calls fn for every non-zero counter, in Kind then Location order.
func (r Redactions) Each(fn func(k Kind, l Location, n int)) {
	for k := range r.n {
		for l, c := range r.n[k] {
			if c != 0 {
				fn(Kind(k), Location(l), int(c))
			}
		}
	}
}

// Flags summarise what happened to the input.
type Flags uint16

const (
	FlagRedacted       Flags = 1 << iota // at least one value was redacted (path, route or query)
	FlagQueryStripped                    // a query string or fragment was removed
	FlagTruncated                        // depth or output cap applied ({rest})
	FlagTooLong                          // input over MaxInputBytes ("/{long}")
	FlagInvalid                          // a segment was invalid UTF-8 or had control characters
	FlagMethodStripped                   // route mode: a leading "METHOD " was removed
	FlagEmpty                            // the input was empty
)

// Has reports whether all bits of g are set.
func (f Flags) Has(g Flags) bool { return f&g == g }

// Result is the outcome of Normalize.
type Result struct {
	// Route is the normalised route: "/" followed by segments, or "*".
	Route string
	// Rules lists the rules that fired, distinct, in first-firing order.
	Rules []Rule
	// Redactions counts redacted secrets and personal identifiers.
	Redactions Redactions
	// Flags summarise the processing.
	Flags Flags
}

// RulesVersion returns RuleSetVersion; store it next to Route.
func (Result) RulesVersion() string { return RuleSetVersion }

// Fired reports whether rule r fired.
func (res *Result) Fired(r Rule) bool {
	for _, x := range res.Rules {
		if x == r {
			return true
		}
	}
	return false
}

func (res *Result) fire(r Rule) {
	if !res.Fired(r) {
		res.Rules = append(res.Rules, r)
	}
}

func (res *Result) redact(k Kind, l Location) {
	res.Redactions.add(k, l)
	res.Flags |= FlagRedacted
}
