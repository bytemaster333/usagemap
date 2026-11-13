"""Summarise results/latency.csv into Markdown tables (p50/p95 per combination and per endpoint)."""
import csv
import sys
from collections import defaultdict

LIMIT = {'24h': 1000, '7d': 1000, '14d': 1000, '30d': 1000, '60d': 3000, '90d': 3000}
ORDER_R = ['24h', '7d', '14d', '30d', '60d', '90d']
ORDER_S = ['large', 'medium', 'small']
ORDER_M = [('warm', '1'), ('conc', '10'), ('cold', '1')]


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return float('nan')
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def fmt(ms):
    return f'{ms / 1000:.2f}'


rows = [r for r in csv.DictReader(open(sys.argv[1])) if r['rep'] != '-1']
by = defaultdict(list)
byep = defaultdict(list)
bad = defaultdict(int)
for r in rows:
    k = (r['mode'], r['conc'], r['site'], r['range'], r['filter'])
    if r['status'] != '200':
        bad[k] += 1
    by[k].append(float(r['ms']))
    byep[k + (r['endpoint'],)].append(float(r['ms']))

eps = sorted({r['endpoint'] for r in rows}, key=lambda e: (e != 'stats', e != 'pageviews', e))
print('### Per dashboard combination (all 9 endpoints pooled; seconds)\n')
print('| mode | conc | site | range | filter | n | p50 | p95 | worst endpoint p95 | pass? | non-200 |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
for mode, conc in ORDER_M:
    for s in ORDER_S:
        for rg in ORDER_R:
            for f in ['none', 'tag']:
                k = (mode, conc, s, rg, f)
                if k not in by:
                    continue
                worst = max(eps, key=lambda e: pct(byep.get(k + (e,), [0]), 0.95))
                wp95 = pct(byep[k + (worst,)], 0.95)
                p95 = pct(by[k], 0.95)
                ok = 'yes' if wp95 < LIMIT[rg] and not bad[k] else 'NO'
                print(f'| {mode} | {conc} | {s} | {rg} | {f} | {len(by[k])} | {fmt(pct(by[k], .5))} | {fmt(p95)} '
                      f'| {fmt(wp95)} ({worst}) | {ok} | {bad[k]} |')

print('\n### Per endpoint p95 (seconds), warm, c=1\n')
print('| site | range | filter | ' + ' | '.join(eps) + ' |')
print('|---|---|---|' + '---|' * len(eps))
for s in ORDER_S:
    for rg in ORDER_R:
        for f in ['none', 'tag']:
            k = ('warm', '1', s, rg, f)
            if k not in by:
                continue
            print(f'| {s} | {rg} | {f} | ' + ' | '.join(fmt(pct(byep.get(k + (e,), [float("nan")]), .95)) for e in eps) + ' |')

print('\n### Per endpoint (seconds), cold (single load after restart with direct I/O)\n')
print('| site | range | filter | ' + ' | '.join(eps) + ' |')
print('|---|---|---|' + '---|' * len(eps))
for s in ORDER_S:
    for rg in ORDER_R:
        for f in ['none', 'tag']:
            k = ('cold', '1', s, rg, f)
            if k not in by:
                continue
            print(f'| {s} | {rg} | {f} | ' + ' | '.join(fmt(pct(byep.get(k + (e,), [float("nan")]), .95)) for e in eps) + ' |')
