// SPDX-License-Identifier: Apache-2.0
// Real-browser leg of the gateway integration test: Chromium loads a page on https://site.test that embeds the
// tracker served by the gateway (SRI from the gateway's own manifest); the tracker's two ingest hosts resolve to the
// gateway container. The page view goes through challenge → WebCrypto proof → POST /v1/e → spool → engine proxy →
// Umami. Usage: PW_MODULE=<…/@playwright/test/index.mjs> GW=https://127.0.0.1:56200 node browser.mjs <siteKey>
const { chromium } = await import(process.env.PW_MODULE);
const [siteKey] = process.argv.slice(2);
const port = new URL(process.env.GW).port;
const manifest = await (await fetch(`${process.env.GW}/lib/manifest.json`))
  .json()
  .catch(() => null);
const m = manifest.versions[0];
const file = m.files.find((f) => f.path === "standard.js");
const browser = await chromium.launch({
  args: [
    `--host-resolver-rules=MAP ingest-a.example-analytics.org:443 127.0.0.1:${port}, MAP ingest-b.example-analytics.net:443 127.0.0.1:${port}`,
    "--disable-blink-features=AutomationControlled",
    // The test maps the public ingest hosts to the loopback gateway; Chrome's Local Network Access would block a
    // public page from reaching loopback. In production the ingest hosts are public addresses.
    "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
  ],
});
const major = browser.version().split(".")[0];
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  locale: "en-US",
  userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
});
const page = await ctx.newPage();
const html = `<!doctype html><html><head><title>WSB secret title</title>
<script src="https://ingest-a.example-analytics.org/lib/${m.version}/standard.js" integrity="${file.integrity}" crossorigin="anonymous" data-site="${siteKey}" defer></script>
</head><body><a id="nav" href="#">next</a><script>document.getElementById("nav").onclick=(e)=>{e.preventDefault();history.pushState({},"","/spa/second");};</script></body></html>`;
await page.route("https://site.test/**", (r) =>
  r.fulfill({ status: 200, contentType: "text/html", body: html }),
);
const statuses = [];
page.on("response", (r) => {
  if (r.url().includes("/v1/")) statuses.push(`${new URL(r.url()).pathname} ${r.status()}`);
});
const first = page.waitForResponse((r) => r.url().endsWith("/v1/e") && r.status() === 202, {
  timeout: 20000,
});
await page.goto("https://site.test/landing?utm_secret=1#frag");
await first;
await page.click("#nav");
await page.waitForResponse((r) => r.url().endsWith("/v1/e") && r.status() === 202, {
  timeout: 20000,
});
console.log(
  JSON.stringify({ statuses, webdriver: await page.evaluate(() => navigator.webdriver) }),
);
await browser.close();
