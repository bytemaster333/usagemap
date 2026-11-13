#!/usr/bin/env python3
"""Drive a fixed, known request mix against one sample API. Usage: load.py BASE_URL [PREFIX]
The query strings and User-Agent contain canary values so personal-data leaks are easy to grep."""
import sys, urllib.request, urllib.error, json

base = sys.argv[1].rstrip("/")
UA = "s06a-load/1.0 (canary-ua-7f3a)"
ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
MIX = [  # (path, times, expected status)
    ("/health", 10, 200),
    ("/accounts/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H?cursor=canary-cursor-91&email=canary%40example.com", 20, 200),
    ("/accounts/GMISSING", 5, 404),
    (f"/assets/USDC/{ISSUER}?limit=5", 10, 200),
    ("/boom", 5, 500),
    ("/nope/unmatched-canary-path", 3, 404),
]
counts = {}
for path, n, want in MIX:
    for _ in range(n):
        req = urllib.request.Request(base + path, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        counts[f"{path.split('?')[0][:40]} -> {code}"] = counts.get(f"{path.split('?')[0][:40]} -> {code}", 0) + 1
        if code != want:
            print(f"WARN {path} returned {code}, expected {want}", file=sys.stderr)
print(json.dumps({"base": base, "total": sum(n for _, n, _ in MIX), "by_path_status": counts}))
