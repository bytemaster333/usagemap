// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
// Unit tests of the Adblock network-filter matcher used by the filter-list check (web.adblock-safe-script-name, web.adblock-safe-endpoints): anchors,
// wildcards, separators, options, exceptions, `important`, `badfilter`, regex filters and hosts-file lines, on
// rules in the form EasyList, EasyPrivacy, uBlock Origin and AdGuard publish them.

import { describe, expect, it } from "vitest";
import {
  FilterSet,
  hostMatches,
  ipMatches,
  parseLine,
  type Request,
  type RequestType,
  site,
} from "../scripts/filter-list/matcher.ts";

const req = (
  url: string,
  type: RequestType = "script",
  pageHost = "tenant.example",
  method: "GET" | "POST" = type === "script" ? "GET" : "POST",
): Request => ({ url, type, method, pageHost });

const blocks = (rules: string, r: Request): boolean =>
  new FilterSet("t").add(rules).match(r).blocked;

describe("patterns", () => {
  it("`||` anchors at a host label boundary", () => {
    expect(blocks("||doubleclick.net^", req("https://ad.doubleclick.net/x.js"))).toBe(true);
    expect(blocks("||doubleclick.net^", req("https://doubleclick.net/"))).toBe(true);
    expect(blocks("||doubleclick.net^", req("https://notdoubleclick.net/x.js"))).toBe(false);
    expect(blocks("||doubleclick.net^", req("https://doubleclick.net.evil.org/x"))).toBe(false);
  });

  it("`^` is a separator or the end of the URL, never a letter, digit, `_ - . %`", () => {
    expect(blocks("/ads^", req("https://x.org/ads?x=1"))).toBe(true);
    expect(blocks("/ads^", req("https://x.org/ads"))).toBe(true);
    expect(blocks("/ads^", req("https://x.org/ads-free/"))).toBe(false);
    expect(blocks("/ads^", req("https://x.org/adsl"))).toBe(false);
  });

  it("plain patterns are substrings; `*` is any run; `|` anchors start and end", () => {
    expect(blocks("/analytics.js", req("https://cdn.x.org/js/analytics.js"))).toBe(true);
    expect(blocks("/ad*banner.", req("https://x.org/ad/top-banner.png"))).toBe(true);
    expect(blocks("|https://ads.", req("https://ads.x.org/a"))).toBe(true);
    expect(blocks("|https://ads.", req("https://x.org/?u=https://ads.y"))).toBe(false);
    expect(blocks(".swf|", req("https://x.org/a.swf"))).toBe(true);
    expect(blocks(".swf|", req("https://x.org/a.swf?x"))).toBe(false);
  });

  it("is case-insensitive unless `match-case`", () => {
    expect(blocks("/Tracker.js", req("https://x.org/tracker.js"))).toBe(true);
    expect(blocks("/Tracker.js$match-case", req("https://x.org/tracker.js"))).toBe(false);
  });

  it("regular-expression filters, including `$` inside the expression", () => {
    expect(blocks("/\\/v[0-9]\\/e$/", req("https://x.org/v1/e", "xmlhttprequest"))).toBe(true);
    expect(blocks("/\\/v[0-9]\\/e$/$script", req("https://x.org/v1/e", "xmlhttprequest"))).toBe(
      false,
    );
    expect(blocks("/^https:\\/\\/[a-z]+\\.track\\./", req("https://a.track.io/x"))).toBe(true);
    // option values containing `/` and `$` (uBO `header=` with a regex value)
    const hdr =
      '/^https:\\/\\/[a-z]{6,12}\\.com\\/[a-z]+$/$script,3p,header=etag:/^W\\/"[0-9a-z]+"$/';
    expect(parseLine(hdr)).toMatchObject({
      kind: "filter",
      filter: { re: /^https:\/\/[a-z]{6,12}\.com\/[a-z]+$/ },
    });
    expect(blocks(hdr, req("https://abcdefg.com/js"))).toBe(true); // header= assumed to hold
    expect(blocks(hdr, req("https://abcdefg.com/js/1.0.0/a.js"))).toBe(false);
    // a path pattern that merely starts and ends with `/` but is not a valid expression
    expect(parseLine("/loader.min.js$xhr,replace=/a{1\\,2}(/b/").kind).toBe("ignored");
  });

  it("uBO `ipaddress=` applies only when the request host's resolved address matches", () => {
    const r = req("https://x.org/t.js");
    expect(blocks("*$script,3p,ipaddress=203.0.113.7", r)).toBe(false); // address unknown
    expect(blocks("*$script,3p,ipaddress=203.0.113.7", { ...r, ips: ["203.0.113.7"] })).toBe(true);
    expect(blocks("*$script,3p,ipaddress=203.0.113.*", { ...r, ips: ["203.0.113.9"] })).toBe(true);
    expect(blocks("*$script,ipaddress=0.0.0.0", { ...r, ips: ["198.51.100.1"] })).toBe(false);
    expect(ipMatches("192.168.1.4", "lan")).toBe(true);
    expect(ipMatches("8.8.8.8", "lan")).toBe(false);
    expect(ipMatches("127.0.0.1", "loopback")).toBe(true);
    expect(ipMatches("10.1.2.3", "/^10\\./")).toBe(true);
  });

  it("uBO `top=` restricts to the top-level page like `from=`; `_` separators are no-ops", () => {
    expect(blocks("/t.js$script,top=news.example", req("https://x.org/t.js"))).toBe(false);
    expect(blocks("/t.js$script,top=~news.example", req("https://x.org/t.js"))).toBe(true);
    expect(blocks("/t.js$script,___,3p", req("https://x.org/t.js"))).toBe(true);
  });

  it("hosts-file lines block the host and its subdomains", () => {
    expect(blocks("127.0.0.1 tracker.example", req("https://a.tracker.example/x"))).toBe(true);
    expect(blocks("0.0.0.0 tracker.example", req("https://tracker.example/x"))).toBe(true);
    expect(blocks("127.0.0.1 localhost", req("https://localhost/x"))).toBe(false);
  });
});

describe("options", () => {
  it("resource types: `$script`, `$xhr`, `$ping`, `$~script`, `$all`", () => {
    expect(blocks("/collect$script", req("https://x.org/collect", "xmlhttprequest"))).toBe(false);
    expect(blocks("/collect$xhr", req("https://x.org/collect", "xmlhttprequest"))).toBe(true);
    expect(blocks("/collect$ping", req("https://x.org/collect", "ping"))).toBe(true);
    expect(blocks("/collect$ping", req("https://x.org/collect", "xmlhttprequest"))).toBe(false);
    expect(blocks("/collect$~script", req("https://x.org/collect"))).toBe(false);
    expect(blocks("/collect$all", req("https://x.org/collect", "ping"))).toBe(true);
    expect(blocks("/collect$image", req("https://x.org/collect"))).toBe(false);
  });

  it("party: `$third-party`/`$3p` and `$first-party`/`$1p`/`$~third-party`", () => {
    const third = req("https://cdn.other.org/t.js");
    const first = req("https://cdn.tenant.example/t.js");
    expect(blocks("/t.js$third-party", third)).toBe(true);
    expect(blocks("/t.js$3p", first)).toBe(false);
    expect(blocks("/t.js$1p", first)).toBe(true);
    expect(blocks("/t.js$~third-party", third)).toBe(false);
  });

  it("`domain=`/`from=` restrict to (or exclude) the page's site; `to=`/`denyallow=` the request host", () => {
    const r = req("https://cdn.other.org/t.js");
    expect(blocks("/t.js$domain=news.example", r)).toBe(false);
    expect(blocks("/t.js$domain=tenant.example", r)).toBe(true);
    expect(blocks("/t.js$domain=~tenant.example", r)).toBe(false);
    expect(blocks("/t.js$domain=~news.example", r)).toBe(true);
    expect(blocks("/t.js$from=tenant.*", r)).toBe(true);
    expect(blocks("*$script,to=other.org", r)).toBe(true);
    expect(blocks("*$script,denyallow=other.org", r)).toBe(false);
  });

  it("`method=`", () => {
    const post = req("https://x.org/e", "xmlhttprequest", "tenant.example", "POST");
    expect(blocks("/e$method=post", post)).toBe(true);
    expect(blocks("/e$method=get", post)).toBe(false);
    expect(blocks("/e$method=~post", post)).toBe(false);
  });

  it("filters that do not block requests are ignored; unknown options are counted, not dropped silently", () => {
    const set = new FilterSet("t").add(
      ["/t.js$removeparam=x", "/t.js$csp=script-src 'none'", "/t.js$frobnicate", "##.ad"].join(
        "\n",
      ),
    );
    expect(set.match(req("https://x.org/t.js")).blocked).toBe(false);
    expect(set.unsupported.get("option frobnicate")).toBe(1);
    expect(parseLine("example.org##.banner").kind).toBe("ignored");
    expect(parseLine("example.org#@#.banner").kind).toBe("ignored");
    expect(parseLine("example.org##+js(set, a, 1)").kind).toBe("ignored");
    expect(parseLine("example.org#$#abort-on-property-read x").kind).toBe("ignored");
    expect(parseLine("! comment").kind).toBe("ignored");
    expect(parseLine("[Adblock Plus 2.0]").kind).toBe("ignored");
  });
});

describe("exceptions, important, badfilter", () => {
  it("`@@` allows what a blocking filter matched, and the verdict names both", () => {
    const set = new FilterSet("t").add("||cdn.x.org^\n@@||cdn.x.org/lib/$script");
    const v = set.match(req("https://cdn.x.org/lib/a.js"));
    expect(v.blocked).toBe(false);
    expect(v.by?.raw).toBe("||cdn.x.org^");
    expect(v.allowedBy?.raw).toBe("@@||cdn.x.org/lib/$script");
    expect(set.match(req("https://cdn.x.org/other.js")).blocked).toBe(true);
  });

  it("`$important` overrides an exception", () => {
    expect(blocks("||x.org^$important\n@@||x.org^", req("https://x.org/a.js"))).toBe(true);
  });

  it("`$badfilter` disables the identical filter", () => {
    expect(blocks("||x.org^$script\n||x.org^$script,badfilter", req("https://x.org/a.js"))).toBe(
      false,
    );
    expect(blocks("||x.org^$script\n||x.org^$badfilter", req("https://x.org/a.js"))).toBe(true);
  });

  it("reports the matching rule with its list and line", () => {
    const set = new FilterSet("EasyPrivacy").add("! header\n/pixel.gif\n/analytics.js", "ep.txt");
    const v = set.match(req("https://x.org/analytics.js"));
    expect(v).toMatchObject({
      blocked: true,
      by: { raw: "/analytics.js", list: "ep.txt", line: 3 },
    });
  });
});

describe("helpers", () => {
  it("site() approximates the registrable domain", () => {
    expect(site("ingest-a.example-analytics.org")).toBe("example-analytics.org");
    expect(site("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(site("localhost")).toBe("localhost");
  });

  it("hostMatches() handles subdomains, `name.*` and uBO regex entries", () => {
    expect(hostMatches("a.b.example.org", "example.org")).toBe(true);
    expect(hostMatches("badexample.org", "example.org")).toBe(false);
    expect(hostMatches("www.google.de", "google.*")).toBe(true);
    expect(hostMatches("notgoogle.de", "google.*")).toBe(false);
    expect(hostMatches("shop12.example", "/^shop\\d+\\./")).toBe(true);
  });
});

describe("positive control: typical analytics URLs are blocked by typical EasyPrivacy rules", () => {
  const easyPrivacyLike = [
    "||google-analytics.com^",
    "/analytics.js",
    "/collect?",
    "-analytics/",
    "/track.js",
    "||plausible.io^$3p",
  ].join("\n");
  for (const url of [
    "https://www.google-analytics.com/g/collect?v=2",
    "https://cdn.x.org/js/analytics.js",
    "https://x.org/collect?id=1",
    "https://x.org/web-analytics/a.js",
    "https://plausible.io/js/script.js",
  ]) {
    it(url, () => expect(blocks(easyPrivacyLike, req(url))).toBe(true));
  }
});
