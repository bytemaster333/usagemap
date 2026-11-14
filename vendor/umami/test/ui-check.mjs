// SPDX-License-Identifier: Apache-2.0
// Adopted from spikes/s02-umami-hardened-image/ui-check.mjs (C-104).
// S-02: load the Umami dashboard once in headless Chromium and list every URL the UI requests.
// Requests to any host other than the Umami origin are recorded and ABORTED (nothing leaves the machine).
// Usage: PW_DIR=<dir with node_modules/playwright> node ui-check.mjs <base-url> <username> <password> <websiteId>
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.PW_DIR}/`);
const { chromium } = require('playwright');

const [base, username, password, websiteId] = process.argv.slice(2);
const origin = new URL(base).origin;
const external = new Map();
const internal = new Map();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext();
await context.route('**/*', route => {
  const url = route.request().url();
  if (new URL(url).origin === origin) {
    const p = new URL(url).pathname.replace(/\/[0-9a-f-]{36}/g, '/:id');
    internal.set(p, (internal.get(p) || 0) + 1);
    return route.continue();
  }
  external.set(url, (external.get(url) || 0) + 1);
  return route.abort('blockedbyclient');
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', m => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)));

await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
await page.getByLabel(/username/i).fill(username).catch(() => page.locator('input[name=username]').fill(username));
await page.locator('input[type=password]').fill(password);
await page.locator('button[type=submit]').click();
await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 20000 });
await page.waitForLoadState('networkidle');
const visited = [page.url()];
for (const path of [`/websites/${websiteId}`, '/websites', '/settings/websites', '/settings/profile']) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  visited.push(new URL(page.url()).pathname);
}
const title = await page.title();
await browser.close();

console.log(JSON.stringify({
  title,
  visited,
  externalRequests: Object.fromEntries(external),
  internalPaths: Object.fromEntries([...internal].sort()),
  consoleErrors,
}, null, 2));
process.exit(0);
