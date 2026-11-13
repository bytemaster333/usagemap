"""Site size distribution for S-11: 300 sites, 1,000,000 page views/day in total.

pv_i = C / (i + 1)^1.3 for i = 1..300 -> a few large sites (174k, 103k, 71k/day), a long tail (site 150 ~630/day,
site 300 ~260/day). Prints CSV: idx,pv_day,npaths.
"""
N, A, B, TOTAL = 300, 1, 1.3, 1_000_000
w = [1 / (i + A) ** B for i in range(1, N + 1)]
s = sum(w)
for i, x in enumerate(w, start=1):
    pv = round(TOTAL * x / s)
    npaths = max(10, min(2000, pv // 50))
    print(f"{i},{pv},{npaths}")
