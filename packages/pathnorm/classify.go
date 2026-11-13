// SPDX-License-Identifier: Apache-2.0
package pathnorm

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// classify applies the per-segment classifier (S0–S14, F1) to one decoded
// segment. It returns the output segment and whether it is a literal (to be
// re-encoded by the caller). The first matching rule wins.
func classify(d string, res *Result, loc Location, folding Folding) (string, bool) {
	// S0: our own placeholders pass through unchanged (idempotence).
	if isOwnPlaceholder(d) {
		return d, false
	}
	// S1, S2: secrets and personal identifiers, before any length cap so that
	// every hit is counted.
	if ph, ok := classifySensitive(d, res, loc); ok {
		return ph, false
	}
	// S3: very long segment.
	n := utf8.RuneCountInString(d)
	if n > MaxSegmentRunes {
		res.fire(RuleLongSegment)
		return PhLong, false
	}
	// S4: StrKey shape → strict decode → typed placeholder, else {id}.
	if ph, ok := classifyStrKey(d, res); ok {
		return ph, false
	}
	// S5: assets.
	if isAsset(d) {
		res.fire(RuleAsset)
		return PhAsset, false
	}
	if len(d) == 11 && strings.HasPrefix(d, "iso4217:") && rxAssetFiat.MatchString(d) {
		res.fire(RuleAssetFiat)
		return PhAsset, false
	}
	// S8: literal allow-list (versions, SEP/CAP names, technical tokens),
	// evaluated before the numeric and hex rules.
	if isAllowed(d) {
		res.fire(RuleAllow)
		return d, true
	}
	// S6: numeric families.
	if isEvent(d) {
		res.fire(RuleEvent)
		return PhEvent, false
	}
	if isDate(d) {
		if folding == FoldingRelaxed {
			res.fire(RuleRelaxedDate)
			return relaxedLiteral(d, n, res)
		}
		res.fire(RuleDate)
		return PhDate, false
	}
	if isCursor(d) {
		res.fire(RuleCursor)
		return PhCursor, false
	}
	if d != "" && allDigits(d) { // every all-digit segment, single digits included (1.1.0)
		if folding == FoldingRelaxed {
			res.fire(RuleRelaxedInt)
			return relaxedLiteral(d, n, res)
		}
		res.fire(RuleInt)
		return PhInt, false
	}
	if isDecimal(d) {
		if folding == FoldingRelaxed {
			res.fire(RuleRelaxedDecimal)
			return relaxedLiteral(d, n, res)
		}
		res.fire(RuleDecimal)
		return PhID, false
	}
	// S7: UUID and hex families.
	if ph, r, ok := classifyHex(d); ok {
		res.fire(r)
		return ph, false
	}
	// S9: static files — content-hashed names fold, others stay literal.
	if ph, lit, ok := classifyStatic(d, n, res); ok {
		return ph, lit
	}
	// S10: ULID.
	if len(d) == 26 && rxULID.MatchString(d) {
		res.fire(RuleULID)
		return PhID, false
	}
	// S11: long opaque base64 / base64url / base58 tokens.
	if len(d) >= 32 && rxB64Token.MatchString(d) {
		if hasDigit(d) || hasMixedCase(d) || strings.ContainsAny(d, "+/") || strings.HasSuffix(d, "=") {
			res.fire(RuleToken)
			return PhToken, false
		}
	}
	// S12: generic mixed identifiers (relaxed keeps slugs).
	if isSafeLiteral(d) {
		if r, ok := mixedID(d); ok {
			if r == RuleMixedID && folding == FoldingRelaxed && isSlug(d) {
				res.fire(RuleRelaxedSlug)
				return relaxedLiteral(d, n, res)
			}
			res.fire(r)
			return PhID, false
		}
	}
	// S13: special characters → opaque parameter.
	if hasSpecial(d) {
		res.fire(RuleSpecial)
		return PhID, false
	}
	// S14: long literal.
	if n > MaxLiteralRunes {
		res.fire(RuleLongLiteral)
		return PhLong, false
	}
	return d, true
}

// relaxedLiteral keeps a value literal under FoldingRelaxed, subject to the
// literal length cap.
func relaxedLiteral(d string, n int, res *Result) (string, bool) {
	if n > MaxLiteralRunes {
		res.fire(RuleLongLiteral)
		return PhLong, false
	}
	return d, true
}

// classifySensitive applies S1 (secrets) and S2 (personal identifiers).
func classifySensitive(d string, res *Result, loc Location) (string, bool) {
	k, r, ok := sensitiveKind(d)
	if !ok {
		return "", false
	}
	res.fire(r)
	res.redact(k, loc)
	return PhRedacted, true
}

func sensitiveKind(d string) (Kind, Rule, bool) {
	// S1.seed: a seed-shaped run anywhere, any case — the checksum is never
	// consulted (a seed with a typo still leaks 55 of 56 characters).
	if len(d) >= 56 && rxSeedAnywhere.MatchString(d) {
		return KindStellarSeed, RuleSeed, true
	}
	if strings.Contains(d, "eyJ") && (rxJWT.MatchString(d) || rxJWTEmbed.MatchString(d)) {
		return KindJWT, RuleJWT, true
	}
	if len(d) >= 16 && rxAPIKey.MatchString(d) {
		return KindAPIKey, RuleAPIKey, true
	}
	if strings.IndexByte(d, '@') >= 0 && (rxEmail.MatchString(d) || rxEmailEmbed.MatchString(d)) {
		return KindEmail, RuleEmail, true
	}
	if strings.IndexByte(d, '*') >= 0 && rxFederation.MatchString(d) {
		return KindFederation, RuleFederation, true
	}
	if len(d) > 0 && d[0] == '+' && rxPhone.MatchString(d) {
		return KindPhone, RulePhone, true
	}
	if isIP(d) {
		return KindIP, RuleIP, true
	}
	return 0, "", false
}

func isIP(d string) bool {
	if len(d) >= 7 && len(d) <= 15 && d[0] >= '0' && d[0] <= '9' && rxIPv4.MatchString(d) {
		return true
	}
	if strings.Count(d, ":") >= 2 && rxIPv6.MatchString(d) {
		for i := 0; i < len(d); i++ {
			if isAlnum(d[i]) {
				return true
			}
		}
	}
	return false
}

// isOwnPlaceholder: ^\{[a-z_][a-z0-9_]{0,31}\}$ (except the route-level
// {unknown} and {overflow}, which are ordinary text here) or
// ^\{static\}\.[a-z0-9]{1,8}$.
func isOwnPlaceholder(d string) bool {
	if len(d) < 3 || d[0] != '{' {
		return false
	}
	if strings.HasPrefix(d, "{static}.") {
		ext := d[len("{static}."):]
		if len(ext) < 1 || len(ext) > 8 {
			return false
		}
		for i := 0; i < len(ext); i++ {
			c := ext[i]
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
				return false
			}
		}
		return true
	}
	if d[len(d)-1] != '}' {
		return false
	}
	return isPlaceholderName(d[1:len(d)-1]) && d != PhUnknown && d != PhOverflow
}

// isPlaceholderName: ^[a-z_][a-z0-9_]{0,31}$.
func isPlaceholderName(s string) bool {
	if len(s) < 1 || len(s) > MaxParamName {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c == '_' || i > 0 && c >= '0' && c <= '9' {
			continue
		}
		return false
	}
	return true
}

// classifyStrKey (S4). Shapes, applied to the ASCII-upper-cased segment:
//
//	^[GCTXL][A-D][A-Z2-7]{54}$                      (56)
//	^BAA[A-Z2-7]{54}[AEIMQUY4]$                     (58)
//	^[MW][A-D][A-Z2-7]{66}[ACEGIKMOQSUWY246]$       (69)
//	^P[A-D][A-Z2-7]{67,163}$ with one of 16 lengths (69–165)
func classifyStrKey(d string, res *Result) (string, bool) {
	n := len(d)
	if n < 56 || n > 165 {
		return "", false
	}
	var ubuf [165]byte
	u := ubuf[:n]
	lower := false
	for i := 0; i < n; i++ {
		c := d[i]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
			lower = true
		}
		if b32Value[c] < 0 {
			return "", false
		}
		u[i] = c
	}
	if u[1] < 'A' || u[1] > 'D' {
		return "", false
	}
	shape := false
	switch {
	case n == 56:
		shape = strings.IndexByte("GCTXL", u[0]) >= 0
	case n == 58:
		shape = u[0] == 'B' && u[1] == 'A' && u[2] == 'A' && strings.IndexByte("AEIMQUY4", u[57]) >= 0
	}
	if !shape && n == 69 && (u[0] == 'M' || u[0] == 'W') {
		shape = strings.IndexByte("ACEGIKMOQSUWY246", u[68]) >= 0
	}
	if !shape && u[0] == 'P' && signedPayloadLengths[n] {
		shape = true
	}
	if !shape {
		return "", false
	}
	var raw [110]byte
	t, _, ok := decodeInto(u, raw[:0])
	if !ok {
		res.fire(RuleStrKeyBadCRC)
		return PhID, true
	}
	res.fire(strKeyRules[t][b2i(lower)])
	switch t {
	case StrKeyAccount, StrKeyMuxedAccount:
		return PhAccount, true
	case StrKeyContract, StrKeyMuxedContract:
		return PhContract, true
	case StrKeyLiquidityPool:
		return PhPool, true
	case StrKeyClaimableBalance:
		return PhBalance, true
	default: // T, X, P
		return PhSigner, true
	}
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// isAsset (S5): CODE:ISSUER, CODE-ISSUER[-1|2], stellar:CODE:ISSUER; the
// issuer must strict-decode as a G StrKey.
func isAsset(d string) bool {
	if len(d) < 58 || len(d) > 80 {
		return false
	}
	m := rxAsset.FindStringSubmatchIndex(d)
	if m == nil {
		return false
	}
	issuer := d[m[4]:m[5]]
	var ubuf [56]byte
	for i := 0; i < 56; i++ {
		c := issuer[i]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		ubuf[i] = c
	}
	var raw [40]byte
	t, _, ok := decodeInto(ubuf[:], raw[:0])
	return ok && t == StrKeyAccount
}

// isAllowed (S8): versions ^[vV][0-9]{1,3}([._][0-9]{1,3}){0,2}([a-z]{1,8}[0-9]{0,3})?$,
// ^(sep|SEP|cap|CAP)-?[0-9]{1,4}$, and the technical-token list.
func isAllowed(d string) bool {
	if len(d) == 0 {
		return false
	}
	switch d[0] {
	case 'v', 'V':
		if rxVersion.MatchString(d) {
			return true
		}
	case 's', 'S', 'c', 'C':
		if rxSEP.MatchString(d) {
			return true
		}
	}
	return isAllowLiteral(d)
}

func isAllowLiteral(t string) bool {
	if len(t) > 9 {
		return false
	}
	var buf [9]byte
	for i := 0; i < len(t); i++ {
		c := t[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		buf[i] = c
	}
	_, ok := allowLiterals[string(buf[:len(t)])]
	return ok
}

// isEvent: ^[0-9]{19}-[0-9]{10}$.
func isEvent(d string) bool {
	return len(d) == 30 && d[19] == '-' && allDigits(d[:19]) && allDigits(d[20:])
}

// isCursor: ^[0-9]{1,20}-[0-9]{1,10}$.
func isCursor(d string) bool {
	i := strings.IndexByte(d, '-')
	if i < 1 || i > 20 {
		return false
	}
	r := d[i+1:]
	return len(r) >= 1 && len(r) <= 10 && allDigits(d[:i]) && allDigits(r)
}

func isDate(d string) bool {
	return len(d) >= 10 && d[4] == '-' && allDigits(d[:4]) && rxDate.MatchString(d)
}

// isDecimal: ^-[0-9]+(\.[0-9]+)?$ or ^[0-9]+\.[0-9]+$.
func isDecimal(d string) bool {
	if d == "" {
		return false
	}
	s := d
	neg := s[0] == '-'
	if neg {
		s = s[1:]
	}
	i := strings.IndexByte(s, '.')
	if i < 0 {
		return neg && len(s) > 0 && allDigits(s)
	}
	return i > 0 && i < len(s)-1 && allDigits(s[:i]) && allDigits(s[i+1:])
}

// classifyHex (S7): UUID; 72-hex claimable balance (00000000 + 64 hex);
// 64-hex hash (optional 0x); ≥ 16 hex or any 0x-hex; 7–15 hex with a digit
// and a letter.
func classifyHex(d string) (string, Rule, bool) {
	n := len(d)
	if n >= 36 && n <= 47 && strings.IndexByte(d, '-') >= 0 && rxUUID.MatchString(d) {
		return PhUUID, RuleUUID, true
	}
	if n == 72 && strings.HasPrefix(d, "00000000") && allHex(d) {
		return PhBalance, RuleBalanceHex, true
	}
	body := d
	ox := n > 2 && d[0] == '0' && (d[1] == 'x' || d[1] == 'X')
	if ox {
		body = d[2:]
	}
	if !allHex(body) || body == "" {
		return "", "", false
	}
	switch {
	case len(body) == 64:
		return PhHash, RuleHash64, true
	case len(body) >= 16 || ox:
		return PhHex, RuleHex, true
	case len(body) >= 7 && len(body) <= 15 && hasDigit(body) && hasLetter(body):
		return PhHex, RuleHexMid, true
	}
	return "", "", false
}

// classifyStatic (S9). A name ending in a static extension whose stem has a
// content-hash token (hex ≥ 6 with a digit; ≥ 8 alphanumerics with a digit
// and a letter; ≥ 2 digits; a UUID) becomes {static}.<ext>; otherwise a
// safe static name (≤ 64) stays literal.
func classifyStatic(d string, n int, res *Result) (string, bool, bool) {
	dot := strings.LastIndexByte(d, '.')
	if dot < 1 || len(d)-dot-1 < 1 || len(d)-dot-1 > 8 {
		return "", false, false
	}
	ext := d[dot+1:]
	var lb [8]byte
	for i := 0; i < len(ext); i++ {
		c := ext[i]
		if !isAlnum(c) {
			return "", false, false
		}
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		lb[i] = c
	}
	lext := string(lb[:len(ext)])
	if _, ok := staticExt[lext]; !ok {
		return "", false, false
	}
	stem := d[:dot]
	hashed := false
	forEachToken(stem, func(t string) bool {
		switch {
		case len(t) >= 6 && allHex(t) && hasDigit(t),
			len(t) >= 8 && allWord(t) && hasDigit(t) && hasLetter(t),
			len(t) >= 2 && allDigits(t),
			rxUUID.MatchString(t):
			hashed = true
			return false
		}
		return true
	})
	if hashed {
		res.fire(RuleStatic)
		return PhStatic + "." + lext, false, true
	}
	if n <= MaxLiteralRunes && isSafeLiteral(d) {
		res.fire(RuleStaticLiteral)
		return d, true, true
	}
	return "", false, false
}

// mixedID (S12): split on . _ ~ -; a token that is not allow-listed and not a
// version, with a digit run ≥ 3 or ≥ 8 characters with a digit and a letter
// → {id}; a letters-only token ≥ 16 with ≥ 6 case transitions → {id}.
func mixedID(d string) (Rule, bool) {
	var rule Rule
	forEachToken(d, func(t string) bool {
		if isAllowLiteral(t) || (t[0] == 'v' || t[0] == 'V') && rxVersion.MatchString(t) {
			return true
		}
		run, maxRun, digit, alpha := 0, 0, false, false
		for i := 0; i < len(t); i++ {
			c := t[i]
			if c >= '0' && c <= '9' {
				digit = true
				run++
				if run > maxRun {
					maxRun = run
				}
			} else {
				run = 0
				if isLetter(c) {
					alpha = true
				}
			}
		}
		if maxRun >= 3 || len(t) >= 8 && digit && alpha {
			rule = RuleMixedID
			return false
		}
		if len(t) >= 16 && !digit && allLetters(t) {
			trans := 0
			for i := 1; i < len(t); i++ {
				if isLower(t[i-1]) != isLower(t[i]) {
					trans++
				}
			}
			if trans >= 6 {
				rule = RuleRandomCase
				return false
			}
		}
		return true
	})
	return rule, rule != ""
}

// isSlug (relaxed folding): lower-case words and numbers joined by single
// hyphens, at least two parts and at least one word of two or more letters
// (my-post-12345, sku-100234). Mixed letter-digit parts are identifiers, not
// slugs.
func isSlug(d string) bool {
	parts, word := 0, false
	for p := range strings.SplitSeq(d, "-") {
		if p == "" {
			return false
		}
		parts++
		switch {
		case allDigits(p):
		case allLowerLetters(p):
			if len(p) >= 2 {
				word = true
			}
		default:
			return false
		}
	}
	return parts >= 2 && word
}

// forEachToken calls fn for every non-empty token of s split on . _ ~ -,
// stopping when fn returns false.
func forEachToken(s string, fn func(string) bool) {
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == '.' || s[i] == '_' || s[i] == '~' || s[i] == '-' {
			if i > start && !fn(s[start:i]) {
				return
			}
			start = i + 1
		}
	}
}

// hasSpecial (S13): any of : @ * + , = ! $ ' ( ) & ; % \ { } [ ] < > | ^ ` "
// or white space.
func hasSpecial(d string) bool {
	for _, r := range d {
		if r < utf8.RuneSelf {
			if strings.IndexByte(":@*+,=!$'()&;%\\{}[]<>|^`\" \t\n\v\f\r", byte(r)) >= 0 {
				return true
			}
		} else if unicode.IsSpace(r) {
			return true
		}
	}
	return false
}

// isSafeLiteral: ^[A-Za-z0-9._~-]+$.
func isSafeLiteral(d string) bool {
	if d == "" {
		return false
	}
	for i := 0; i < len(d); i++ {
		if !isUnreserved(d[i]) {
			return false
		}
	}
	return true
}

func isUnreserved(c byte) bool {
	return isAlnum(c) || c == '-' || c == '.' || c == '_' || c == '~'
}

func isAlnum(c byte) bool  { return isLetter(c) || c >= '0' && c <= '9' }
func isLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }
func isLower(c byte) bool  { return c >= 'a' && c <= 'z' }

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func allHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func allWord(s string) bool {
	for i := 0; i < len(s); i++ {
		if !isAlnum(s[i]) && s[i] != '_' {
			return false
		}
	}
	return true
}

func allLetters(s string) bool {
	for i := 0; i < len(s); i++ {
		if !isLetter(s[i]) {
			return false
		}
	}
	return true
}

func allLowerLetters(s string) bool {
	for i := 0; i < len(s); i++ {
		if !isLower(s[i]) {
			return false
		}
	}
	return true
}

func hasDigit(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			return true
		}
	}
	return false
}

func hasLetter(s string) bool {
	for i := 0; i < len(s); i++ {
		if isLetter(s[i]) {
			return true
		}
	}
	return false
}

func hasMixedCase(s string) bool {
	up, lo := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		up = up || c >= 'A' && c <= 'Z'
		lo = lo || c >= 'a' && c <= 'z'
	}
	return up && lo
}
