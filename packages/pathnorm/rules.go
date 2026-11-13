// SPDX-License-Identifier: Apache-2.0
package pathnorm

import "regexp"

// Rule identifies a rule of the rule set. The IDs are those of the research
// rule set (A* pre-processing, R* route mode, S* per-segment classifier, K*
// Stellar context, F* page-path folding) and are stable within a MAJOR version.
type Rule string

// Pre-processing rules (whole input).
const (
	RuleEmpty         Rule = "A0.empty"
	RuleTooLong       Rule = "A1.too_long"
	RuleAbsolute      Rule = "A2.absolute"
	RuleAsterisk      Rule = "A3.asterisk"
	RuleQueryFragment Rule = "A4.query_fragment"
	RuleLeadingSlash  Rule = "A5.leading_slash"
	RuleMatrix        Rule = "A7.matrix"
	RuleInvalidUTF8   Rule = "A8.invalid_utf8"
	RuleControlChar   Rule = "A8.control_char"
	RuleDotSegment    Rule = "A9.dot_segment"
	RuleDepthCap      Rule = "A10.depth_cap"
	RuleOutputCap     Rule = "A11.output_cap"
)

// Route-mode rules.
const (
	RuleStripMethod      Rule = "R0.strip_method"
	RuleRoutePlaceholder Rule = "R1.route_placeholder"
)

// Per-segment rules, in evaluation order.
const (
	RuleSeed              Rule = "S1.seed"
	RuleJWT               Rule = "S1.jwt"
	RuleAPIKey            Rule = "S1.api_key"
	RuleEmail             Rule = "S2.email"
	RuleFederation        Rule = "S2.federation"
	RulePhone             Rule = "S2.phone"
	RuleIP                Rule = "S2.ip"
	RuleLongSegment       Rule = "S3.long"
	RuleStrKeyBadCRC      Rule = "S4.strkey_shape_badcrc"
	RuleAsset             Rule = "S5.asset"
	RuleAssetFiat         Rule = "S5.asset_fiat"
	RuleAllow             Rule = "S8.allow"
	RuleEvent             Rule = "S6.event"
	RuleDate              Rule = "S6.date"
	RuleCursor            Rule = "S6.cursor"
	RuleInt               Rule = "S6.int"
	RuleDecimal           Rule = "S6.decimal"
	RuleUUID              Rule = "S7.uuid"
	RuleBalanceHex        Rule = "S7.balance_hex"
	RuleHash64            Rule = "S7.hash64"
	RuleHex               Rule = "S7.hex"
	RuleHexMid            Rule = "S7.hex_mid"
	RuleStatic            Rule = "S9.static"
	RuleStaticLiteral     Rule = "S9.static_literal"
	RuleULID              Rule = "S10.ulid"
	RuleToken             Rule = "S11.token"
	RuleMixedID           Rule = "S12.mixed_id"
	RuleRandomCase        Rule = "S12.random_case"
	RuleSpecial           Rule = "S13.special"
	RuleLongLiteral       Rule = "S14.long_literal"
	RuleHorizonDataKey    Rule = "K1.horizon_data_key"
	RuleRelaxedInt        Rule = "F1.relaxed_int"
	RuleRelaxedDecimal    Rule = "F1.relaxed_decimal"
	RuleRelaxedDate       Rule = "F1.relaxed_date"
	RuleRelaxedSlug       Rule = "F1.relaxed_slug"
	ruleStrKeyPrefix           = "S4.strkey."
	ruleStrKeyLowerSuffix      = ".lowercase"
)

// StrKeyRule returns the rule ID reported when a StrKey of type t is
// recognised (with the ".lowercase" suffix when the input was not upper case).
func StrKeyRule(t StrKeyType, lowercase bool) Rule {
	r := ruleStrKeyPrefix + string(rune(t))
	if lowercase {
		r += ruleStrKeyLowerSuffix
	}
	return Rule(r)
}

// strKeyRules caches StrKeyRule for every type, so that classification does
// not allocate.
var strKeyRules = func() (m [256][2]Rule) {
	for _, vb := range versionByte {
		m[vb.t][0] = StrKeyRule(vb.t, false)
		m[vb.t][1] = StrKeyRule(vb.t, true)
	}
	return m
}()

// Placeholders.
const (
	PhAccount  = "{account}"
	PhContract = "{contract}"
	PhPool     = "{pool}"
	PhBalance  = "{balance}"
	PhSigner   = "{signer}"
	PhAsset    = "{asset}"
	PhHash     = "{hash}"
	PhHex      = "{hex}"
	PhInt      = "{int}"
	PhEvent    = "{event}"
	PhCursor   = "{cursor}"
	PhDate     = "{date}"
	PhUUID     = "{uuid}"
	PhID       = "{id}"
	PhToken    = "{token}"
	PhKey      = "{key}"
	PhStatic   = "{static}" // always followed by ".<ext>"
	PhRedacted = "{redacted}"
	PhInvalid  = "{invalid}"
	PhLong     = "{long}"
	PhRest     = "{rest}"
	PhWildcard = "{wildcard}"
	// PhOverflow is assigned by the metrics writer's cardinality guard, never
	// by this package.
	PhOverflow = "{overflow}"
	// PhUnknown is assigned when neither a route nor a path exists (see
	// NormalizeSpan); Normalize never produces it.
	PhUnknown = "{unknown}"
)

// Vocabulary is the closed placeholder vocabulary of the rule set (ADR-0012,
// C-16): 24 placeholders. Route mode additionally keeps the tenant's own
// lower-cased parameter names.
var Vocabulary = []string{
	PhAccount, PhContract, PhPool, PhBalance, PhSigner, PhAsset, PhHash, PhHex,
	PhInt, PhEvent, PhCursor, PhDate, PhUUID, PhID, PhToken, PhKey, PhStatic,
	PhRedacted, PhInvalid, PhLong, PhRest, PhWildcard, PhOverflow, PhUnknown,
}

// Caps (research values, ADR-0012).
const (
	MaxInputBytes   = 8192 // raw input above this → "/{long}"
	MaxDepth        = 12   // segments; the remainder becomes "{rest}"
	MaxSegmentRunes = 256  // decoded segment above this → "{long}" (after secret checks)
	MaxLiteralRunes = 64   // literal segment above this → "{long}"
	MaxOutputBytes  = 1024 // output above this is cut at a segment boundary + "{rest}"
	MaxParamName    = 32   // route-mode parameter names
)

// Regex catalogue (RE2 / Go regexp; no look-around, no back-references).
// Simple shapes (integers, hex, strkey shapes, versions) are checked by hand
// in classify.go for speed; their regex equivalents are given in comments
// there and in README.md.
var (
	// S1 secrets. A seed-shaped run is searched for anywhere in the decoded
	// segment, case-insensitively and without a boundary (fail closed).
	rxSeedAnywhere = regexp.MustCompile(`[Ss][A-Da-d][A-Za-z2-7]{54}`)
	// Query/fragment scan (counter only): case-sensitive, base32 boundary.
	rxSeedEmbed   = regexp.MustCompile(`(?:^|[^A-Z2-7])S[A-D][A-Z2-7]{54}(?:[^A-Z2-7]|$)`)
	rxSeedWhole   = regexp.MustCompile(`^[Ss][A-Da-d][A-Za-z2-7]{54}$`)
	rxJWT         = regexp.MustCompile(`^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$`)
	rxJWTEmbed    = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.`)
	rxAPIKey      = regexp.MustCompile(`^(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|sk_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})$`)
	rxAPIKeyEmbed = regexp.MustCompile(`(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})`)

	// S2 personal identifiers.
	rxEmail      = regexp.MustCompile(`^[^@\s/]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$`)
	rxEmailEmbed = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`)
	rxFederation = regexp.MustCompile(`^[^*\s/]+\*[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$`)
	rxPhone      = regexp.MustCompile(`^\+[0-9][0-9 ().-]{6,20}$`)
	rxIPv4       = regexp.MustCompile(`^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$`)
	rxIPv6       = regexp.MustCompile(`^[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}$`)

	// S5 assets.
	rxAsset     = regexp.MustCompile(`^(?:stellar:)?([A-Za-z0-9]{1,12})[:-]([Gg][A-Da-d][A-Za-z2-7]{54})(?:-[12])?$`)
	rxAssetFiat = regexp.MustCompile(`^iso4217:[A-Za-z]{3}$`)

	// S6 dates.
	rxDate = regexp.MustCompile(`^[0-9]{4}-[01][0-9]-[0-3][0-9](?:[Tt ][0-2][0-9]:[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,9})?)?(?:[Zz]|[+-][0-2][0-9]:?[0-5][0-9])?)?$`)

	// S8 versions.
	rxVersion = regexp.MustCompile(`^[vV][0-9]{1,3}(?:[._][0-9]{1,3}){0,2}(?:[a-z]{1,8}[0-9]{0,3})?$`)
	rxSEP     = regexp.MustCompile(`^(?:sep|SEP|cap|CAP)-?[0-9]{1,4}$`)

	// S7 UUID: any version, any case, braced, urn:uuid:.
	rxUUID = regexp.MustCompile(`^(?:[Uu][Rr][Nn]:[Uu][Uu][Ii][Dd]:)?\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$`)

	// S10 ULID.
	rxULID = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$`)

	// S11 opaque tokens.
	rxB64Token = regexp.MustCompile(`^[A-Za-z0-9+/_-]{32,}={0,2}$`)

	// R0 "METHOD /route".
	rxMethodPrefix = regexp.MustCompile(`^(?:GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH|QUERY|_OTHER) +/`)

	// A2 absolute-form scheme + authority.
	rxAbsolute = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*`)
)

// allowLiterals are technical tokens kept literal (S8), compared lower-cased.
var allowLiterals = map[string]struct{}{
	"ed25519": {}, "secp256k1": {}, "secp256r1": {}, "sha256": {}, "sha512": {}, "sha3": {},
	"keccak256": {}, "base64": {}, "base32": {}, "base58": {}, "x509": {}, "utf8": {}, "utf-8": {},
	"oauth2": {}, "2fa": {}, "i18n": {}, "l10n": {}, "k8s": {}, "s3": {}, "web3": {}, "erc20": {},
	"erc721": {}, "erc1155": {}, "h264": {}, "mp4": {}, "mp3": {}, "p2p": {}, "b2b": {}, "b2c": {},
	"ipv4": {}, "ipv6": {}, "html5": {}, "e2e": {}, "x402": {},
}

// staticExt are file extensions treated as static assets (S9).
var staticExt = map[string]struct{}{
	"js": {}, "mjs": {}, "cjs": {}, "css": {}, "map": {}, "woff": {}, "woff2": {}, "ttf": {},
	"otf": {}, "eot": {}, "png": {}, "jpg": {}, "jpeg": {}, "gif": {}, "webp": {}, "avif": {},
	"svg": {}, "ico": {}, "wasm": {}, "json": {}, "txt": {}, "html": {}, "webm": {}, "mp4": {},
}
