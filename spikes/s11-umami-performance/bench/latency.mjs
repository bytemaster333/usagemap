// SPDX-License-Identifier: Apache-2.0
// S-11 dashboard latency benchmark against Umami's HTTP API (the endpoints the website overview page calls).
// Usage: node latency.mjs --mode warm|cold|conc --sites large=<uuid>,small=<uuid> --t0 <ms> --out file.csv
//        [--ranges 24h,7d,30d,90d] [--filters none,tag] [--reps 10] [--conc 10]
// Appends CSV rows: mode,conc,site,range,filter,endpoint,rep,ms,status,bytes
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []),
);
const BASE = args.base ?? 'http://127.0.0.1:18700';
const MODE = args.mode ?? 'warm';
const T0 = Number(args.t0);
const SITES = args.sites.split(',').map(s => s.split('='));
const RANGES = (args.ranges ?? '24h,7d,30d,90d').split(',');
const FILTERS = (args.filters ?? 'none,tag').split(',');
const REPS = Number(args.reps ?? 10);
const CONC = Number(args.conc ?? 10);
const TIMEOUT_MS = Number(args.timeout ?? 600000);
const OUT = args.out;
const HOURS = { '24h': 24, '7d': 168, '14d': 336, '30d': 720, '60d': 1440, '90d': 2160 };

if (!existsSync(OUT)) writeFileSync(OUT, 'mode,conc,site,range,filter,endpoint,rep,ms,status,bytes\n');

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'umami' }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return (await r.json()).token;
}

function endpoints(id, range, filter) {
  const endAt = T0 - 1;
  const startAt = T0 - HOURS[range] * 3600_000;
  const base = `startAt=${startAt}&endAt=${endAt}&timezone=UTC${filter === 'tag' ? '&tag=eq.v' : ''}`;
  const unit = HOURS[range] <= 48 ? 'hour' : 'day';
  const m = t => [`metrics:${t}`, `/api/websites/${id}/metrics?type=${t}&limit=10&${base}`];
  return [
    ['stats', `/api/websites/${id}/stats?${base}`],
    ['pageviews', `/api/websites/${id}/pageviews?unit=${unit}&${base}`],
    m('path'), m('referrer'), m('browser'), m('os'), m('device'), m('country'), m('event'),
  ];
}

let TOKEN;
async function timed(url) {
  const t = performance.now();
  try {
    const r = await fetch(BASE + url, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await r.text();
    return { ms: performance.now() - t, status: r.status, bytes: body.length };
  } catch (e) {
    return { ms: performance.now() - t, status: e.name === 'TimeoutError' ? 'timeout' : 'error', bytes: 0 };
  }
}

function rec(conc, site, range, filter, ep, rep, r) {
  appendFileSync(OUT, `${MODE},${conc},${site},${range},${filter},${ep},${rep},${r.ms.toFixed(1)},${r.status},${r.bytes}\n`);
}

TOKEN = await login();
for (const [role, id] of SITES) {
  for (const range of RANGES) {
    for (const filter of FILTERS) {
      const eps = endpoints(id, range, filter);
      const t = performance.now();
      if (MODE === 'cold') {
        // one sequential dashboard load right after a database restart (run.sh restarts between calls)
        for (const [ep, url] of eps) rec(1, role, range, filter, ep, 0, await timed(url));
      } else if (MODE === 'warm') {
        let warm = 0;
        for (const [ep, url] of eps) {
          const r = await timed(url);
          warm += r.ms;
          rec(1, role, range, filter, ep, -1, r); // warm-up pass, rep -1, excluded from stats
        }
        // adaptive: combinations that are already far over budget get fewer repetitions
        const reps = warm > 60000 ? 1 : warm > 20000 ? Math.min(3, REPS) : REPS;
        for (let rep = 0; rep < reps; rep++) for (const [ep, url] of eps) rec(1, role, range, filter, ep, rep, await timed(url));
      } else if (MODE === 'conc') {
        // CONC clients, each loads the full dashboard once (9 requests sequentially), starting at different panels
        await Promise.all(
          Array.from({ length: CONC }, async (_, w) => {
            for (let i = 0; i < eps.length; i++) {
              const [ep, url] = eps[(i + w) % eps.length];
              rec(CONC, role, range, filter, ep, w, await timed(url));
            }
          }),
        );
      }
      console.error(`${MODE} ${role} ${range} ${filter}: ${((performance.now() - t) / 1000).toFixed(1)} s`);
    }
  }
}
