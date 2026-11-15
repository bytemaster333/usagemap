// SPDX-License-Identifier: Apache-2.0

// Package uabot applies the bot list Umami uses (`isbot`, at the version bundled in the Umami release we run) to the
// raw User-Agent, before it is reduced (register C-36, wire-formats §h.2 `ua_bot`).
//
// Source of the pattern: the `isbot` regular expression bundled in our Umami 3.5.0 image (vendor/umami, commit
// d3c62a8; package.json `"isbot": "^5.2.2"`), extracted from `/app/.next/server/chunks/*` by
// testdata/extract-isbot.sh. Go's RE2 has no look-around, so the six alternatives that use one are matched by hand
// below and every other alternative is compiled unchanged. The parity test (isbot_test.go) runs this function and
// Umami's own expression (in Node, from the image) over the same User-Agent corpus and requires identical answers.
package uabot

import (
	"regexp"
	"strings"
)

// PatternVersion names the upstream list this file reproduces.
const PatternVersion = "isbot@umami-3.5.0-d3c62a8"

// plain holds every alternative of the upstream expression that needs no look-around, verbatim (the upstream flag
// is `i`; we lower-case the input instead, which is equivalent for the ASCII-only pattern).
var plain = regexp.MustCompile(strings.Join([]string{
	` daum[ /]`, ` deusu/`,
	`24x7`, `;\s\w+;$`, `@[a-z][\w-]+\.`, `\(\)`, `\.com\b`, `\b\w+/1\.0;`, `\bbw/`, `\bdlc\b`, `\bort/`, `\bperl\b`,
	`\btime/`, `\|`, `^[<\(;]`, `^[\w \.\-\(?:\):%]+(?:/v?\d+(?:\.\d+)?(?:\.\d{1,10})*?)?(?:,|$)`, `^[\w\-]+/[\w]+$`,
	`^[^ ]{50,}$`, `^\d+\b`, `^\w*search\b`, `^\w+/[\w\(\)]*$`, `^\w+/\d\.\d\s\([\w@]+\)$`,
	`^active`, `^ad muncher`, `^amaya`, `^apache/`, `^avsdevicesdk/`, `^azure`, `^biglotron`, `^blackbox exporter`,
	`^bot`, `^clamav[ /]`, `^claude-code/`, `^client/`, `^cobweb/`, `^custom`, `^ddg[_-]android`, `^discourse`,
	`^dispatch/\d`, `^downcast/`, `^duckduckgo`, `^email`, `^exodusmovement`, `^facebook`, `^getright/`,
	`^gozilla/`, `^hobbit`, `^hotzonu`, `^hwcdn/`, `^igetter/`, `^jeode/`, `^jetty/`, `^jigsaw`, `^microsoft bits`,
	`^movabletype`, `^mozilla/\d\.\d\s[\w\.-]+$`,
	`^mozilla/\d\.\d\s\((?:compatible;)?(?:\s?[\w\d-.]+\/\d+\.\d+)?\)$`,
	`^navermailapp`, `^netsurf`, `^offline`, `^openai/`, `^owler`, `^php`, `^postman`, `^ps_daily/`, `^python`,
	`^rank`, `^read`, `^reed`, `^remove\.bg/`, `^rest`, `^rss`, `^snapchat`, `^sora `, `^space bison`, `^stape/`,
	`^svn`, `^swcd `, `^taringa`, `^thumbor/`, `^track`, `^w3c`, `^webbandit/`, `^webcopier`, `^wget`, `^whatsapp`,
	`^wordpress`, `^xenu link sleuth`, `^yahoo`, `^yandex`, `^zdm/\d`, `^zoom marketplace/`,
	`abuse`, `advisor`, `agent\b`, `analyzer`, `archive`, `ask jeeves/teoma`, `attracta`, `audit`, `bluecoat drtr`,
	`browsex`, `burpcollaborator`, `capture`, `catch`, `check\b`, `checker`, `chrome-lighthouse`, `chromeframe`,
	`classifier`, `cloudflare`, `collapsify\b`, `convertify`, `cookiehubverify/`, `crawl`, `cursor/`, `cypress/`,
	`dareboost`, `datanyze`, `dejaclick`, `detect`, `discovery`, `dmbrowser`, `download`, `exaleadcloudview`, `feed`,
	`firephp`, `foregenix`, `functionize`, `grab`, `hardenize\b`, `headless`, `hotjar`, `httrack`,
	`hubspot marketing grader`, `ibisbrowser`, `infrawatch`, `insight`, `inspect`, `iplabel`, `library`, `linkcheck`,
	`linktiger`, `mail\.ru/`, `manager`, `manus-user/`, `marketgoo/`, `measure`, `monitor\b`, `neustar wpm`, `node\b`,
	`nutch`, `offbyone`, `openvas`, `optimize`, `pageburst`, `pagespeed`, `parser`, `phantomjs`, `pingdom`,
	`playwright`, `powermarks`, `preview`, `productfinder`, `prospectingstudio`, `proxy`, `ptst[ /]\d`, `radar`,
	`readable/`, `retriever`, `rexx;`, `rigor`, `rss\b`, `scrape`, `securityheaders`, `selenium`, `server`, `silktide`,
	`sindup/`, `sogou`, `sparkler/`, `speedcurve`, `spider`, `splash`, `statuscake`, `supercleaner`, `synapse`,
	`synthetic`, `testlocally`, `tools`, `torrent`, `transcoder`, `url`, `validator`, `virtuoso`, `wappalyzer`,
	`watchtowr`, `webglance`, `webkit2png`, `whatcms/`, `xtate/`,
}, "|"))

// boundaryAfter reports whether position i of s is a JavaScript `\b` boundary (ASCII word characters).
func boundaryAfter(s string, i int) bool {
	before := i > 0 && isWord(s[i-1])
	after := i < len(s) && isWord(s[i])
	return before != after
}

func isWord(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// eachIndex calls fn for every (possibly overlapping) occurrence of sub in s until fn returns true.
func eachIndex(s, sub string, fn func(i int) bool) bool {
	for off := 0; off <= len(s)-len(sub); {
		j := strings.Index(s[off:], sub)
		if j < 0 {
			return false
		}
		if fn(off + j) {
			return true
		}
		off += j + 1
	}
	return false
}

// lookaround implements the six alternatives that use look-around, exactly as upstream writes them:
//
//	(?:^|[^g])news(?!sapphire)
//	(?<! channel/|google/)google(?!(?:wv|app|/google| pixel))
//	(?<! cu)bots?(?:\b|_)
//	(?<!cam)scan
//	(?<!lib)http
//	java(?!;)
func lookaround(s string) bool {
	if eachIndex(s, "news", func(i int) bool {
		return (i == 0 || s[i-1] != 'g') && !strings.HasPrefix(s[i+4:], "sapphire")
	}) {
		return true
	}
	if eachIndex(s, "google", func(i int) bool {
		if strings.HasSuffix(s[:i], " channel/") || strings.HasSuffix(s[:i], "google/") {
			return false
		}
		rest := s[i+6:]
		for _, p := range []string{"wv", "app", "/google", " pixel"} {
			if strings.HasPrefix(rest, p) {
				return false
			}
		}
		return true
	}) {
		return true
	}
	if eachIndex(s, "bot", func(i int) bool {
		if strings.HasSuffix(s[:i], " cu") {
			return false
		}
		// bots?(?:\b|_): try "bots" first, then "bot" (backtracking).
		ok := func(end int) bool { return end < len(s) && s[end] == '_' || boundaryAfter(s, end) }
		if i+3 < len(s) && s[i+3] == 's' && ok(i+4) {
			return true
		}
		return ok(i + 3)
	}) {
		return true
	}
	if eachIndex(s, "scan", func(i int) bool { return !strings.HasSuffix(s[:i], "cam") }) {
		return true
	}
	if eachIndex(s, "http", func(i int) bool { return !strings.HasSuffix(s[:i], "lib") }) {
		return true
	}
	return eachIndex(s, "java", func(i int) bool { return !strings.HasPrefix(s[i+4:], ";") })
}

// asciiLower lower-cases ASCII letters only (JavaScript's non-Unicode `i` flag folds ASCII; the pattern is ASCII).
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// IsBot reports whether Umami's bot list matches the raw User-Agent. Like upstream, an empty string is not a bot
// (the gateway treats a missing User-Agent separately).
func IsBot(ua string) bool {
	if ua == "" {
		return false
	}
	s := asciiLower(ua)
	return lookaround(s) || plain.MatchString(s)
}

// headlessMarkers are automation tokens in a User-Agent (wire-formats §h.2 `automation_flag`, standard profile). Most
// are also on the bot list (then the event is `rejected` as `ua_bot` and this reason is counted as well).
var headlessMarkers = []string{
	"headless", "phantomjs", "slimerjs", "puppeteer", "playwright", "selenium", "webdriver", "cypress", "nightmare",
	"htmlunit", "jsdom", "zombie.js",
}

// HasHeadlessMarker reports a headless or automation-framework token in the raw User-Agent.
func HasHeadlessMarker(ua string) bool {
	s := asciiLower(ua)
	for _, m := range headlessMarkers {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}
