// SPDX-License-Identifier: Apache-2.0
// S-11 ingest benchmark: POST /api/send the way our gateway will (surrogate address in x-forwarded-for from the
// IPv6 documentation prefix, country in cf-ipcountry, real browser User-Agent, tag v|s, cache token reused within a
// visit like the tracker does on an SPA).
// Usage: node ingest.mjs --sites <file with one website uuid per line> --secs 120 (--conc N | --rate R) --label x
// Prints one JSON line: {label, conc, rate, secs, sent, ok, errors, evps, p50, p95, p99, umamiCpu, dbCpu}
// umamiCpu/dbCpu = average CPU cores used by the container (cgroup v2 usage_usec delta / wall time).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []),
);
const BASE = args.base ?? 'http://127.0.0.1:18700';
const SECS = Number(args.secs ?? 120);
const CONC = args.conc ? Number(args.conc) : 0;
const RATE = args.rate ? Number(args.rate) : 0;
const SITES = readFileSync(args.sites, 'utf8').trim().split('\n').map(l => l.split(','));
// weight site choice by its daily volume (column 2) so the mix matches the stored data
const total = SITES.reduce((s, x) => s + Number(x[1]), 0);
const cum = [];
SITES.reduce((s, x) => (cum.push(s + Number(x[1])), s + Number(x[1])), 0);
const pickSite = () => {
  const r = Math.random() * total;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
  return SITES[lo];
};

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
];
const COUNTRIES = ['US', 'DE', 'GB', 'FR', 'IN', 'BR', 'NL', 'CA', 'ES', 'IT'];
const hex = () => Math.floor(Math.random() * 65536).toString(16);

function cgroupUsec(name) {
  const id = execFileSync('docker', ['inspect', '-f', '{{.Id}}', name]).toString().trim();
  const s = readFileSync(`/sys/fs/cgroup/system.slice/docker-${id}.scope/cpu.stat`, 'utf8');
  return Number(/usage_usec (\d+)/.exec(s)[1]);
}

const lat = [];
let sent = 0, ok = 0, errors = 0;
const end = Date.now() + SECS * 1000;

// a "visitor": fixed surrogate address + UA + country; 1..5 page views in one visit, cache token reused
async function visitor() {
  const [site, , domain] = pickSite();
  const ip = `2001:db8:${hex()}:${hex()}::${hex()}`;
  const ua = UAS[Math.floor(Math.random() * UAS.length)];
  const country = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
  const tag = Math.random() < 0.15 ? 's' : 'v';
  const pages = 1 + Math.floor(Math.random() * 5);
  let cache;
  for (let p = 0; p < pages && Date.now() < end; p++) {
    const body = JSON.stringify({
      type: 'event',
      payload: {
        website: site, hostname: domain, url: `/page-${Math.floor(Math.random() ** 3 * 200)}`,
        referrer: p === 0 && Math.random() < 0.5 ? 'https://www.google.com/' : '', title: 'Page',
        screen: '1920x1080', language: 'en-US', tag,
      },
    });
    const headers = {
      'content-type': 'application/json', 'user-agent': ua, 'x-forwarded-for': ip, 'cf-ipcountry': country,
    };
    if (cache) headers['x-umami-cache'] = cache;
    const t = performance.now();
    sent++;
    try {
      const r = await fetch(`${BASE}/api/send`, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      lat.push(performance.now() - t);
      if (r.ok && j.cache) { ok++; cache = j.cache; } else errors++;
    } catch {
      lat.push(performance.now() - t);
      errors++;
    }
    if (RATE) return; // open loop: one event per scheduled arrival
  }
}

const u0 = cgroupUsec('scf-s11-umami-1'), d0 = cgroupUsec('scf-s11-db-1'), t0 = Date.now();
if (CONC) {
  await Promise.all(Array.from({ length: CONC }, async () => { while (Date.now() < end) await visitor(); }));
} else {
  // open loop at RATE events/s (Poisson arrivals); each arrival is a new single-event visitor
  const inflight = [];
  let next = performance.now();
  while (Date.now() < end) {
    next += -Math.log(1 - Math.random()) * (1000 / RATE);
    const wait = next - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    inflight.push(visitor());
  }
  await Promise.all(inflight);
}
const wall = (Date.now() - t0) / 1000;
const u1 = cgroupUsec('scf-s11-umami-1'), d1 = cgroupUsec('scf-s11-db-1');
lat.sort((a, b) => a - b);
const q = p => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]?.toFixed(1);
console.log(JSON.stringify({
  label: args.label, conc: CONC || null, rate: RATE || null, secs: +wall.toFixed(1), sent, ok, errors,
  evps: +(ok / wall).toFixed(1), p50: +q(0.5), p95: +q(0.95), p99: +q(0.99),
  umamiCpu: +((u1 - u0) / 1e6 / wall).toFixed(2), dbCpu: +((d1 - d0) / 1e6 / wall).toFixed(2),
}));
